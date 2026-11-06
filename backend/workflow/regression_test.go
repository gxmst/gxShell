package workflow

import (
	"context"
	"strings"
	"testing"
	"time"

	"gxShell/backend/ai"
)

func expectAll(state string) map[string]string {
	expected := map[string]string{}
	for _, check := range Checks {
		expected[check] = state
	}
	return expected
}

func TestSavedCaseRequiresFlaggedReportAndSurvivesRestart(t *testing.T) {
	m, run := storedReport(t)
	m.runs[run.ID].Evidence[2].Output = "/dev/vda1 98% / secret-value"
	if _, err := m.SaveCase(run.ID, "disk", expectAll("normal"), "operator"); err == nil {
		t.Fatal("saved a report nobody flagged")
	}
	if _, err := m.FeedbackReport(run.ID, "missed_issue", "root is 98% full", "operator"); err != nil {
		t.Fatal(err)
	}
	partial := expectAll("normal")
	delete(partial, "disk")
	if _, err := m.SaveCase(run.ID, "disk", partial, "operator"); err == nil {
		t.Fatal("accepted a case without every check")
	}
	if _, err := m.SaveCase(run.ID, "disk", map[string]string{"disk": "bad"}, "operator"); err == nil {
		t.Fatal("accepted an invalid state")
	}
	expected := expectAll("normal")
	expected["disk"] = "critical"
	saved, err := m.SaveCase(run.ID, " Root disk missed ", expected, "operator")
	if err != nil {
		t.Fatal(err)
	}
	if saved.Title != "Root disk missed" || saved.Feedback.Outcome != "missed_issue" || !strings.Contains(saved.Evidence[2].Output, "[redacted]") {
		t.Fatalf("saved case lost its fields or was not redacted: %+v", saved)
	}
	if _, err := m.SaveCase(run.ID, "again", expected, "operator"); err == nil {
		t.Fatal("saved the same diagnosis twice")
	}
	reopened, err := NewManager(m.dir, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	cases := reopened.AllEvaluationCases("en")
	last := cases[len(cases)-1]
	if len(cases) != len(EvaluationCases("en"))+1 || last.ID != saved.ID || !last.Saved || last.Target != "Test host" || !strings.HasPrefix(last.Description, "Missed issue:") {
		t.Fatalf("saved case not listed after restart: %+v", cases)
	}
	if err := reopened.DeleteCase(saved.ID); err != nil || len(reopened.SavedCases()) != 0 {
		t.Fatal("delete failed")
	}
	if again, _ := NewManager(m.dir, nil, nil, nil, nil); len(again.SavedCases()) != 0 {
		t.Fatal("deleted case came back")
	}
}

func TestEvaluationGradesSavedCaseAgainstUserExpectation(t *testing.T) {
	m, run := storedReport(t)
	if _, err := m.FeedbackReport(run.ID, "missed_issue", "disk", "operator"); err != nil {
		t.Fatal(err)
	}
	expected := expectAll("normal")
	expected["disk"] = "critical"
	saved, err := m.SaveCase(run.ID, "disk", expected, "operator")
	if err != nil {
		t.Fatal(err)
	}
	var prompt string
	m.chat = func(_ context.Context, _ ai.Config, request ai.ChatRequest, emit func(ai.ChatResponse)) error {
		prompt = request.Messages[0].Content
		emit(ai.ChatResponse{Content: testReportJSON("en", Checks)})
		emit(ai.ChatResponse{Finish: true})
		return nil
	}
	m.execute = func(context.Context, string, Query) Evidence { t.Error("evaluation called SSH"); return Evidence{} }
	started, err := m.StartEvaluation(context.Background(), ai.Config{Model: "test"}, "en", []string{"healthy_host", saved.ID})
	if err != nil {
		t.Fatal(err)
	}
	var done EvaluationRun
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if values := m.ListEvaluations(); values[0].ID == started.ID && values[0].State != "running" {
			done = values[0]
			break
		}
	}
	if len(done.Results) != 2 || !done.Results[0].Passed {
		t.Fatalf("evaluation did not finish: %+v", done)
	}
	result := done.Results[1]
	if result.Title != "disk" || result.Passed || result.Expected["disk"] != "critical" || result.CorrectChecks != len(Checks)-1 {
		t.Fatalf("saved case not graded against the user's expectation: %+v", result)
	}
	if !strings.Contains(prompt, "example") {
		t.Fatal("saved evidence was not sent")
	}
	if err := m.DeleteCase(saved.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := m.StartEvaluation(context.Background(), ai.Config{Model: "test"}, "en", []string{saved.ID}); err == nil {
		t.Fatal("started an evaluation with a deleted case")
	}
}
