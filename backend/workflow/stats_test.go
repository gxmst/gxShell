package workflow

import (
	"testing"
	"time"
)

func TestStatsClassifiesReportOutcomesPerModel(t *testing.T) {
	m, err := NewManager(t.TempDir(), nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	validation := func(states ...string) []TraceStep {
		steps := []TraceStep{{Kind: "model_turn", State: "completed"}}
		for _, state := range states {
			steps = append(steps, TraceStep{Kind: "report_validation", State: state})
		}
		return steps
	}
	add := func(id, model, state string, trace []TraceStep, feedback string) {
		run := &Run{ID: id, Provider: "openai", Model: model, State: state, CreatedAt: start, FinishedAt: start.Add(2 * time.Second), PromptTokens: 900, CompletionTokens: 100, Trace: trace}
		if feedback != "" {
			run.Feedback = []ReportFeedback{{Outcome: "correct"}, {Outcome: feedback}}
		}
		m.runs[id] = run
	}
	add("a", "flash", "completed", validation("completed"), "")
	add("b", "flash", "completed", validation("corrected"), "false_alarm")
	add("c", "flash", "completed", validation("failed", "corrected"), "missed_issue")
	add("d", "flash", "partial", validation("failed", "failed"), "")
	add("e", "flash", "partial", validation(), "")
	add("f", "flash", "cancelled", validation("completed"), "false_alarm")
	add("g", "flash", "running", nil, "")
	add("h", "pro", "completed", validation("completed"), "")

	stats := m.Stats()
	if len(stats) != 2 || stats[0].Model != "flash" || stats[1].Model != "pro" {
		t.Fatalf("groups: %+v", stats)
	}
	got := stats[0]
	want := ModelStats{Provider: "openai", Model: "flash", Runs: 6, Stopped: 1, Clean: 1, Corrected: 2, Failed: 1, NoReport: 1, FalseAlarms: 1, MissedIssues: 1, AvgTokens: 1000, AvgDurationMs: 2000}
	if got != want {
		t.Fatalf("flash stats\n got %+v\nwant %+v", got, want)
	}
}
