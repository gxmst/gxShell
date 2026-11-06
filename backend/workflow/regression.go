package workflow

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	maxSavedCases     = 20
	maxEvaluationRuns = 8
	savedCasePrefix   = "saved-"
)

// SavedCase freezes a real diagnosis the user flagged as a false alarm or a
// missed issue: its redacted evidence plus the check states the user says are
// right. Evaluations replay the evidence without SSH and grade the model's raw
// answer against those states, so real mistakes become regression tests.
type SavedCase struct {
	ID          string            `json:"id"`
	Title       string            `json:"title"`
	SourceRunID string            `json:"sourceRunId"`
	Target      string            `json:"target"`
	Workflow    string            `json:"workflow"`
	Service     string            `json:"service,omitempty"`
	Port        int               `json:"port,omitempty"`
	Evidence    []Evidence        `json:"evidence"`
	Expected    map[string]string `json:"expected"`
	Feedback    ReportFeedback    `json:"feedback"`
	Reviewer    string            `json:"reviewer"`
	CreatedAt   time.Time         `json:"createdAt"`
}

func savedCasePath(dir, id string) string {
	return filepath.Join(dir, "cases", strings.TrimPrefix(id, savedCasePrefix)+".json")
}

// SaveCase turns a flagged run into a regression case. expected must name
// exactly the checks the run's report covers.
func (m *Manager) SaveCase(runID, title string, expected map[string]string, reviewer string) (SavedCase, error) {
	run, err := m.Get(runID)
	if err != nil {
		return SavedCase{}, err
	}
	if !Terminal(run.State) || len(run.Evidence) == 0 {
		return SavedCase{}, fmt.Errorf("only a finished diagnosis with evidence can become an evaluation case")
	}
	if n := len(run.Feedback); n == 0 || run.Feedback[n-1].Outcome == "correct" {
		return SavedCase{}, fmt.Errorf("mark the report as a false alarm or missed issue first")
	}
	checks := RunChecks(run)
	if len(expected) != len(checks) {
		return SavedCase{}, fmt.Errorf("give an expected state for every check")
	}
	for _, check := range checks {
		if !containsCheck([]string{"normal", "warning", "critical", "unknown"}, expected[check]) {
			return SavedCase{}, fmt.Errorf("invalid expected state for %s", check)
		}
	}
	title = strings.TrimSpace(title)
	if title == "" || len(title) > 120 {
		return SavedCase{}, fmt.Errorf("case title must be 1-120 characters")
	}
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return SavedCase{}, err
	}
	evidence := cloneValue(run.Evidence)
	for i := range evidence {
		evidence[i].Output = m.clean(runID, evidence[i].Output, maxReport)
		evidence[i].Error = m.clean(runID, evidence[i].Error, 1024)
	}
	saved := SavedCase{ID: savedCasePrefix + hex.EncodeToString(bytes[:]), Title: m.clean(runID, title, 120), SourceRunID: run.ID, Target: run.Target,
		Workflow: run.Workflow, Service: run.Service, Port: run.Port, Evidence: evidence, Expected: cloneValue(expected),
		Feedback: run.Feedback[len(run.Feedback)-1], Reviewer: reviewer, CreatedAt: time.Now()}
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.cases) >= maxSavedCases {
		return SavedCase{}, fmt.Errorf("at most %d saved cases; delete one first", maxSavedCases)
	}
	for _, existing := range m.cases {
		if existing.SourceRunID == run.ID {
			return SavedCase{}, fmt.Errorf("this diagnosis is already an evaluation case")
		}
	}
	if err := writeLearning(savedCasePath(m.dir, saved.ID), saved); err != nil {
		return SavedCase{}, err
	}
	m.cases[saved.ID] = &saved
	return cloneValue(saved), nil
}

func (m *Manager) DeleteCase(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cases[id] == nil {
		return fmt.Errorf("evaluation case not found")
	}
	if err := os.Remove(savedCasePath(m.dir, id)); err != nil && !os.IsNotExist(err) {
		return err
	}
	delete(m.cases, id)
	return nil
}

// SavedCases lists regression cases, oldest first.
func (m *Manager) SavedCases() []SavedCase {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]SavedCase, 0, len(m.cases))
	for _, saved := range m.cases {
		out = append(out, cloneValue(*saved))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

func (m *Manager) savedCase(id string) (SavedCase, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if saved := m.cases[id]; saved != nil {
		return cloneValue(*saved), true
	}
	return SavedCase{}, false
}

// AllEvaluationCases lists the fixed fixtures followed by saved cases.
func (m *Manager) AllEvaluationCases(language string) []EvaluationCase {
	out := EvaluationCases(language)
	for _, saved := range m.SavedCases() {
		description := saved.Feedback.Note
		if saved.Feedback.Outcome == "false_alarm" {
			description = tr(language, "误报：", "False alarm: ") + description
		} else {
			description = tr(language, "漏报：", "Missed issue: ") + description
		}
		out = append(out, EvaluationCase{ID: saved.ID, Title: saved.Title, Description: description, Saved: true, Target: saved.Target, CreatedAt: saved.CreatedAt})
	}
	return out
}

func savedCaseFixture(saved SavedCase, language string) (Run, map[string]string) {
	run := Run{ID: strings.Repeat("e", 32), Workflow: saved.Workflow, Service: saved.Service, Port: saved.Port, Language: NormalizeLanguage(language),
		ReportSchemaVersion: 2, Evidence: cloneValue(saved.Evidence), State: "completed"}
	return run, cloneValue(saved.Expected)
}

func (m *Manager) loadSavedCase(path string, data []byte) {
	var saved SavedCase
	if err := json.Unmarshal(data, &saved); err != nil || !strings.HasPrefix(saved.ID, savedCasePrefix) || filepath.Base(path) != filepath.Base(savedCasePath(m.dir, saved.ID)) {
		return
	}
	if _, err := hex.DecodeString(strings.TrimPrefix(saved.ID, savedCasePrefix)); err != nil || len(saved.ID) != len(savedCasePrefix)+32 {
		return
	}
	if !containsCheck([]string{"host_inspection", "service_diagnosis", "disk_diagnosis"}, saved.Workflow) || len(saved.Evidence) == 0 || len(saved.Expected) == 0 {
		return
	}
	m.cases[saved.ID] = &saved
}
