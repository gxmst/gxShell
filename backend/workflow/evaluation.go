package workflow

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gxShell/backend/ai"
)

type EvaluationCase struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
}
type EvaluationResult struct {
	CaseID           string            `json:"caseId"`
	Title            string            `json:"title"`
	Passed           bool              `json:"passed"`
	SchemaValid      bool              `json:"schemaValid"`
	CorrectChecks    int               `json:"correctChecks"`
	TotalChecks      int               `json:"totalChecks"`
	AnalysisPresent  bool              `json:"analysisPresent"`
	Expected         map[string]string `json:"expected"`
	Actual           map[string]string `json:"actual"`
	Error            string            `json:"error,omitempty"`
	DurationMs       int64             `json:"durationMs"`
	PromptTokens     int               `json:"promptTokens"`
	CompletionTokens int               `json:"completionTokens"`
	RawReport        string            `json:"rawReport,omitempty"`
}
type EvaluationRun struct {
	ID            string             `json:"id"`
	Provider      string             `json:"provider"`
	Model         string             `json:"model"`
	Language      string             `json:"language"`
	State         string             `json:"state"`
	CaseVersion   int                `json:"caseVersion"`
	PromptVersion string             `json:"promptVersion"`
	CaseIDs       []string           `json:"caseIds"`
	CreatedAt     time.Time          `json:"createdAt"`
	FinishedAt    time.Time          `json:"finishedAt"`
	Results       []EvaluationResult `json:"results"`
	Error         string             `json:"error,omitempty"`
}

func EvaluationCases(language string) []EvaluationCase {
	return []EvaluationCase{
		{ID: "healthy_host", Title: tr(language, "正常主机", "Healthy host"), Description: tr(language, "资源有余量、没有失败服务，避免误报。", "Resources have headroom and no failed units; test false alarms.")},
		{ID: "disk_pressure", Title: tr(language, "磁盘接近满", "Disk pressure"), Description: tr(language, "根分区使用率 98%，应识别磁盘异常。", "Root usage is 98%; detect critical disk pressure.")},
		{ID: "service_port", Title: tr(language, "服务停止与端口不通", "Stopped service and unreachable port"), Description: tr(language, "服务未运行，所选端口本机连接失败，其他端口存在监听。", "The service is inactive and its local port fails; another port is listening.")},
		{ID: "missing_tool", Title: tr(language, "Docker 工具缺失", "Missing Docker tool"), Description: tr(language, "Docker 不存在应判为未确认，不能当作容器故障。", "Missing Docker should be unconfirmed, not a container fault.")},
	}
}
func evaluationFixture(id, language string) (Run, map[string]string) {
	run := Run{ID: strings.Repeat("e", 32), Workflow: "host_inspection", Language: NormalizeLanguage(language), ReportSchemaVersion: 2, Evidence: []Evidence{}, State: "completed"}
	outputs := map[string]string{
		"system":     "Linux 6.8.0 x86_64\n2\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"",
		"load":       "10:00:00 up 3 days, 1 user, load average: 0.05, 0.08, 0.04",
		"disk":       "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 1000000 380000 620000 38% /",
		"memory":     "              total used free shared buff/cache available\nMem: 2048 400 1000 10 648 1500\nSwap: 1024 0 1024",
		"services":   "GXSHELL_SERVICE_MANAGER=systemd\n",
		"ports":      "State Recv-Q Send-Q Local Address:Port Peer Address:Port\nLISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n",
		"containers": "web\tUp 3 days\t127.0.0.1:8080->80/tcp",
	}
	if id == "disk_pressure" {
		outputs["disk"] = "/dev/vda1 1000000 980000 20000 98% /"
	}
	if id == "service_port" {
		run.Workflow, run.Service, run.Port = "service_diagnosis", "nginx.service", 80
		outputs["ports"] = "State Recv-Q Send-Q Local Address:Port Peer Address:Port\nLISTEN 0 128 0.0.0.0:8080 0.0.0.0:*\n"
		outputs["service"] = "LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success"
		outputs["connectivity"] = "GXSHELL_TCP=unreachable"
	}
	expected := map[string]string{}
	for _, check := range RunChecks(run) {
		query := Query{Check: check}
		if check == "service" {
			query.Service, query.View = run.Service, "status"
		}
		if check == "connectivity" {
			query.Port = run.Port
		}
		e := Evidence{ID: fmt.Sprintf("E%d", len(run.Evidence)+1), Query: query, Status: "collected", Output: outputs[check], CollectedAt: time.Now(), RemoteState: "exited"}
		expected[check] = "normal"
		if id == "disk_pressure" && check == "disk" {
			expected[check] = "critical"
		}
		if id == "missing_tool" && check == "containers" {
			e.Status, e.Output, e.ExitCode, e.Error = "unavailable", "docker: not found", 127, "remote exit code 127"
			expected[check] = "unknown"
		}
		if id == "service_port" && check == "service" {
			expected[check] = "warning"
		}
		if id == "service_port" && check == "connectivity" {
			e.ExitCode = 1
			expected[check] = "critical"
		}
		run.Evidence = append(run.Evidence, e)
	}
	return run, expected
}
func (m *Manager) StartEvaluation(parent context.Context, cfg ai.Config, language string, caseIDs []string) (EvaluationRun, error) {
	if cfg.Model == "" {
		return EvaluationRun{}, fmt.Errorf("configure an AI model before evaluation")
	}
	if err := ai.ValidateConfig(cfg); err != nil {
		return EvaluationRun{}, err
	}
	if len(caseIDs) < 1 || len(caseIDs) > 4 {
		return EvaluationRun{}, fmt.Errorf("select one to four evaluation cases")
	}
	known, seen := map[string]bool{}, map[string]bool{}
	for _, c := range EvaluationCases(language) {
		known[c.ID] = true
	}
	for _, id := range caseIDs {
		if !known[id] || seen[id] {
			return EvaluationRun{}, fmt.Errorf("invalid or duplicate evaluation case")
		}
		seen[id] = true
	}
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return EvaluationRun{}, err
	}
	evaluation := EvaluationRun{ID: hex.EncodeToString(bytes[:]), Provider: string(cfg.Provider), Model: cfg.Model, Language: NormalizeLanguage(language), CaseVersion: 1, PromptVersion: "assessment-v2", CaseIDs: append([]string{}, caseIDs...), State: "running", CreatedAt: time.Now(), Results: []EvaluationResult{}}
	ctx, cancel := context.WithTimeout(parent, 3*time.Minute)
	m.mu.Lock()
	if len(m.activeEvaluation) > 0 {
		m.mu.Unlock()
		cancel()
		return EvaluationRun{}, fmt.Errorf("an evaluation is already running")
	}
	if err := writeLearning(filepath.Join(m.dir, "evaluations", evaluation.ID+".json"), evaluation); err != nil {
		m.mu.Unlock()
		cancel()
		return EvaluationRun{}, err
	}
	m.evaluations[evaluation.ID], m.activeEvaluation[evaluation.ID] = &evaluation, cancel
	m.mu.Unlock()
	snapshot := cloneValue(evaluation)
	go func() {
		defer cancel()
		defer func() { m.mu.Lock(); delete(m.activeEvaluation, evaluation.ID); m.mu.Unlock() }()
		defer func() {
			if recover() != nil {
				_ = m.updateEvaluation(evaluation.ID, func(e *EvaluationRun) {
					e.State, e.Error, e.FinishedAt = "failed", "Evaluation stopped unexpectedly", time.Now()
				})
			}
		}()
		for _, caseID := range caseIDs {
			if ctx.Err() != nil {
				break
			}
			result := m.evaluateCase(ctx, cfg, language, caseID)
			if err := m.updateEvaluation(evaluation.ID, func(e *EvaluationRun) { e.Results = append(e.Results, result) }); err != nil {
				_ = m.updateEvaluation(evaluation.ID, func(e *EvaluationRun) { e.State, e.Error, e.FinishedAt = "failed", err.Error(), time.Now() })
				return
			}
		}
		_ = m.updateEvaluation(evaluation.ID, func(e *EvaluationRun) {
			e.State, e.FinishedAt = "completed", time.Now()
			if ctx.Err() != nil {
				e.State, e.Error = "cancelled", LocalizeError(e.Language, ctx.Err().Error())
			}
		})
	}()
	return snapshot, nil
}
func (m *Manager) evaluateCase(parent context.Context, cfg ai.Config, language, caseID string) EvaluationResult {
	fixture, expected := evaluationFixture(caseID, language)
	result := EvaluationResult{CaseID: caseID, Expected: expected, Actual: map[string]string{}, TotalChecks: len(expected)}
	for _, c := range EvaluationCases(language) {
		if c.ID == caseID {
			result.Title = c.Title
		}
	}
	ctx, cancel := context.WithTimeout(parent, 40*time.Second)
	defer cancel()
	started := time.Now()
	raw, _ := json.Marshal(map[string]any{"evidence": fixture.Evidence, "observations": fallbackDocument(fixture).Checks})
	var content strings.Builder
	var response ai.ChatResponse
	err := m.chat(ctx, cfg, ai.ChatRequest{Instructions: inspectionInstructions(fixture.Language) + diagnosisInstructions(fixture) + reportContract(fixture) + contextInstructions(fixture), Messages: []ai.Message{{Role: "user", Content: tr(language, "根据模拟证据生成诊断报告。本次不连接服务器，不调用工具。", "Diagnose this simulated evidence. No server connection or tools.") + string(raw)}}, EnableTools: false}, func(chunk ai.ChatResponse) {
		if content.Len() < maxReport {
			content.WriteString(chunk.Content)
		}
		if chunk.Finish {
			response = chunk
		}
	})
	result.DurationMs, result.PromptTokens, result.CompletionTokens = time.Since(started).Milliseconds(), response.PromptTk, response.CompleteTk
	text := content.String()
	if m.redact != nil {
		text = m.redact("", text)
	}
	if len(text) > maxReport {
		text = strings.ToValidUTF8(text[:maxReport], "")
	}
	result.RawReport = text
	if err != nil {
		message := err.Error()
		if m.redact != nil {
			message = m.redact("", message)
		}
		result.Error = LocalizeError(language, message)
		return result
	}
	if !response.Finish || len(response.ToolCalls) > 0 {
		result.Error = tr(language, "响应未完整结束或模型试图调用工具。", "Response did not finish or attempted a tool call.")
		return result
	}
	// Grade raw model judgments BEFORE deterministic report reconciliation.
	// Otherwise a rule correcting a missed disk fault would inflate model scores.
	var original ReportDocument
	clean := strings.TrimSpace(text)
	if strings.HasPrefix(clean, "```") {
		if index := strings.IndexByte(clean, '\n'); index >= 0 && strings.HasSuffix(clean, "```") {
			clean = strings.TrimSpace(clean[index+1 : len(clean)-3])
		}
	}
	if json.Unmarshal([]byte(clean), &original) == nil {
		result.AnalysisPresent = original.Analysis != nil
		for _, c := range original.Checks {
			result.Actual[c.Check] = c.Status
		}
		for check, wanted := range expected {
			if result.Actual[check] == wanted {
				result.CorrectChecks++
			}
		}
	}
	if _, err := decodeReport(clean, fixture); err != nil {
		result.Error = err.Error()
	} else {
		result.SchemaValid = true
	}
	result.Passed = result.SchemaValid && result.AnalysisPresent && result.CorrectChecks == result.TotalChecks
	return result
}
func (m *Manager) updateEvaluation(id string, update func(*EvaluationRun)) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	current := m.evaluations[id]
	if current == nil {
		return fmt.Errorf("evaluation not found")
	}
	copy := cloneValue(*current)
	update(&copy)
	if err := writeLearning(filepath.Join(m.dir, "evaluations", id+".json"), &copy); err != nil {
		current.State, current.Error, current.FinishedAt = "failed", tr(current.Language, "评测记录保存失败：", "Evaluation history save failed: ")+err.Error(), time.Now()
		return err
	}
	m.evaluations[id] = &copy
	return nil
}
func (m *Manager) ListEvaluations() []EvaluationRun {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []EvaluationRun{}
	for _, evaluation := range m.evaluations {
		out = append(out, cloneValue(*evaluation))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	if len(out) > 10 {
		out = out[:10]
	}
	return out
}
func (m *Manager) CancelEvaluation(id string) bool {
	m.mu.Lock()
	cancel := m.activeEvaluation[id]
	m.mu.Unlock()
	if cancel != nil {
		cancel()
		return true
	}
	return false
}
