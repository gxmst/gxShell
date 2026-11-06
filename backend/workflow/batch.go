package workflow

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gxShell/backend/ai"
)

const MaxBatchTargets = 12
const MaxBatchConcurrency = 3

type BatchTarget struct {
	SessionID  string `json:"sessionId"`
	ProfileID  string `json:"profileId"`
	Target     string `json:"target"`
	Generation uint64 `json:"generation,omitempty"`
}

type InspectionBatch struct {
	ID               string    `json:"id"`
	State            string    `json:"state"`
	Concurrency      int       `json:"concurrency"`
	CreatedAt        time.Time `json:"createdAt"`
	Runs             []Run     `json:"runs"`
	Completed        int       `json:"completed"`
	Unfinished       int       `json:"unfinished"`
	PromptTokens     int       `json:"promptTokens"`
	CompletionTokens int       `json:"completionTokens"`
}

// StartBatch reserves all targets before starting any. Each worker owns its
// context and evidence. The semaphore only schedules execution, never shares
// model messages or credentials between hosts.
func (m *Manager) StartBatch(parent context.Context, targets []BatchTarget, language string, cfg ai.Config, concurrency int) (InspectionBatch, error) {
	if len(targets) < 2 || len(targets) > MaxBatchTargets || concurrency < 1 || concurrency > MaxBatchConcurrency {
		return InspectionBatch{}, fmt.Errorf("select 2 to %d hosts and concurrency 1 to %d", MaxBatchTargets, MaxBatchConcurrency)
	}
	if cfg.Model == "" {
		return InspectionBatch{}, fmt.Errorf("AI model not configured")
	}
	if err := ai.ValidateConfig(cfg); err != nil {
		return InspectionBatch{}, err
	}
	newID := func() (string, error) {
		var data [16]byte
		_, err := rand.Read(data[:])
		return hex.EncodeToString(data[:]), err
	}
	id, err := newID()
	if err != nil {
		return InspectionBatch{}, err
	}
	runs := []*Run{}
	seen := map[string]bool{}
	for _, target := range targets {
		key := target.ProfileID
		if key == "" {
			key = "session:" + target.SessionID
		}
		if target.SessionID == "" || seen[key] {
			return InspectionBatch{}, fmt.Errorf("invalid or duplicate inspection host")
		}
		seen[key] = true
		runID, err := newID()
		if err != nil {
			return InspectionBatch{}, err
		}
		run := &Run{ID: runID, Workflow: "host_inspection", SessionID: target.SessionID, ProfileID: target.ProfileID, Target: target.Target, State: "queued", Step: "system", CreatedAt: time.Now(), Language: NormalizeLanguage(language), Provider: string(cfg.Provider), Model: cfg.Model, Evidence: []Evidence{}, ReportSchemaVersion: 2, BatchID: id, BatchConcurrency: concurrency}
		stampRun(run, cfg)
		run.SessionGeneration = target.Generation
		runs = append(runs, run)
	}
	if err := parent.Err(); err != nil {
		return InspectionBatch{}, err
	}
	m.mu.Lock()
	for activeID := range m.active {
		active := m.runs[activeID]
		if active.BatchID != "" {
			m.mu.Unlock()
			return InspectionBatch{}, fmt.Errorf("a batch inspection is already running")
		}
		for _, run := range runs {
			if sameRunServer(*run, *active) {
				m.mu.Unlock()
				return InspectionBatch{}, fmt.Errorf("an inspection is already running for %s", run.Target)
			}
		}
	}
	for activeID := range m.activePlans {
		for _, run := range runs {
			if sameRunServer(*run, *m.runs[activeID]) {
				m.mu.Unlock()
				return InspectionBatch{}, fmt.Errorf("an action is already running for %s", run.Target)
			}
		}
	}
	for _, run := range runs {
		if dossier, ok := m.dossiers[run.ProfileID]; ok && !dossier.Deleted {
			copy := cloneValue(dossier)
			copy.History = nil
			run.Dossier = &copy
		}
	}
	saved := []string{}
	for _, run := range runs {
		if err := m.save(run); err != nil {
			// These files were created exclusively by this failed reservation.
			for _, savedID := range saved {
				_ = os.Remove(filepath.Join(m.dir, savedID+".json"))
			}
			m.mu.Unlock()
			return InspectionBatch{}, err
		}
		saved = append(saved, run.ID)
	}
	contexts := make([]context.Context, len(runs))
	cancels := make([]context.CancelFunc, len(runs))
	for i, run := range runs {
		contexts[i], cancels[i] = context.WithCancel(parent)
		m.runs[run.ID], m.active[run.ID] = run, cancels[i]
	}
	batch := m.batchLocked(id)
	m.mu.Unlock()
	gate := make(chan struct{}, concurrency)
	for i, run := range runs {
		if m.emit != nil {
			m.emit(clone(run))
		}
		go m.runBatchMember(contexts[i], cancels[i], run.ID, cfg, gate)
	}
	return batch, nil
}

func (m *Manager) runBatchMember(parent context.Context, cancel context.CancelFunc, id string, cfg ai.Config, gate chan struct{}) {
	defer cancel()
	defer func() { m.mu.Lock(); delete(m.active, id); m.mu.Unlock() }()
	defer func() {
		if recover() != nil {
			m.finish(id, "failed", "Inspection stopped unexpectedly; collected evidence was preserved.")
		}
	}()
	select {
	case <-parent.Done():
		m.finish(id, "cancelled", parent.Err().Error())
		return
	case gate <- struct{}{}:
	}
	defer func() { <-gate }()
	if parent.Err() != nil {
		m.finish(id, "cancelled", parent.Err().Error())
		return
	}
	ctx, deadlineCancel := context.WithTimeout(parent, m.timeout)
	defer deadlineCancel()
	m.run(ctx, id, cfg)
}

// Batch history is reconstructed from durable per-host records. Unfinished
// records become interrupted on restart and are never automatically resumed.
func (m *Manager) batchLocked(id string) InspectionBatch {
	batch := InspectionBatch{ID: id, State: "completed", Runs: []Run{}}
	for _, run := range m.runs {
		if run.BatchID != id {
			continue
		}
		batch.Runs = append(batch.Runs, clone(run))
		batch.Concurrency = run.BatchConcurrency
		if batch.CreatedAt.IsZero() || run.CreatedAt.Before(batch.CreatedAt) {
			batch.CreatedAt = run.CreatedAt
		}
		batch.PromptTokens += run.PromptTokens
		batch.CompletionTokens += run.CompletionTokens
		if run.State == "completed" {
			batch.Completed++
		} else {
			batch.Unfinished++
		}
		if !Terminal(run.State) {
			batch.State = "running"
		}
	}
	if batch.State != "running" && batch.Unfinished > 0 {
		batch.State = "partial"
	}
	sort.Slice(batch.Runs, func(i, j int) bool { return batch.Runs[i].CreatedAt.Before(batch.Runs[j].CreatedAt) })
	return batch
}

func (m *Manager) GetBatch(id string) (InspectionBatch, error) {
	if !validBatchID(id) {
		return InspectionBatch{}, fmt.Errorf("invalid inspection batch ID")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	batch := m.batchLocked(id)
	if len(batch.Runs) == 0 {
		return batch, fmt.Errorf("inspection batch not found")
	}
	return batch, nil
}

func (m *Manager) ListBatches() []InspectionBatch {
	m.mu.Lock()
	defer m.mu.Unlock()
	ids := map[string]bool{}
	for _, run := range m.runs {
		if validBatchID(run.BatchID) {
			ids[run.BatchID] = true
		}
	}
	batches := []InspectionBatch{}
	for id := range ids {
		batches = append(batches, m.batchLocked(id))
	}
	sort.Slice(batches, func(i, j int) bool { return batches[i].CreatedAt.After(batches[j].CreatedAt) })
	if len(batches) > 10 {
		batches = batches[:10]
	}
	return batches
}

func (m *Manager) CancelBatch(id string) bool {
	if !validBatchID(id) {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cancelled := false
	for runID, cancel := range m.active {
		if m.runs[runID].BatchID == id {
			cancel()
			cancelled = true
		}
	}
	return cancelled
}

func validBatchID(id string) bool {
	if len(id) != 32 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}

// Summary export deliberately scopes every conclusion to its host and report
// ID. Evidence IDs such as E1 remain local to the individual report.
func BatchMarkdown(batch InspectionBatch, language string) string {
	var out strings.Builder
	fmt.Fprintf(&out, "# %s\n\n%s: %s\n\n%s: %d/%d · Token: %d\n\n", tr(language, "批量巡检汇总", "Batch inspection summary"), tr(language, "批次编号", "Batch ID"), batch.ID, tr(language, "报告已完成", "Reports completed"), batch.Completed, len(batch.Runs), batch.PromptTokens+batch.CompletionTokens)
	cell := func(s string) string { return strings.NewReplacer("|", "\\|", "\n", " ", "\r", " ").Replace(s) }
	fmt.Fprintf(&out, "| %s | %s | %s | %s | %s |\n| --- | --- | --- | --- | --- |\n", tr(language, "主机", "Host"), tr(language, "报告编号", "Report ID"), tr(language, "结论", "Verdict"), tr(language, "待确认项", "Pending review"), tr(language, "AI 摘要", "AI summary"))
	for _, run := range batch.Runs {
		verdict, summary := tr(language, "报告未完成", "Report unfinished"), run.Error
		confirmed, pending, issue := ReviewStatus(run)
		if run.Document != nil {
			verdict, summary = StatusLabel(language, run.Document.Verdict), run.Document.Summary
		}
		if issue {
			verdict = tr(language, "人工确认存在问题", "Manually confirmed issue")
		} else if confirmed > 0 && pending == 0 && run.Document != nil && run.Document.Verdict == "unknown" {
			verdict = tr(language, "已人工核实", "Manually reviewed")
		}
		if run.State != "completed" {
			verdict = tr(language, "报告未完成", "Report unfinished")
		}
		fmt.Fprintf(&out, "| %s | %s | %s | %d | %s |\n", cell(run.Target), run.ID, cell(verdict), pending, cell(summary))
	}
	fmt.Fprintf(&out, "\n%s\n", tr(language, "汇总保留各台主机的独立结论，不推断跨主机根因。详细证据和人工确认记录请打开对应报告。", "This summary preserves independent host conclusions and does not infer cross-host causes. Open each report for evidence and human review records."))
	return out.String()
}
