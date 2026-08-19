package app

import (
	"testing"
	"time"
)

func TestCliJobSnapshotFiltersEvents(t *testing.T) {
	job := &cliJob{
		ID: "job-1", Alias: "2", State: "running", CreatedAt: time.Now(), NextSeq: 2,
		Events:         []cliJobEvent{{Sequence: 1, Stream: "stdout", Data: "one"}, {Sequence: 2, Stream: "stderr", Data: "two"}},
		RiskAssessment: riskAssessment{Tier: tierBounded, Findings: []riskFinding{{Tier: tierBounded, Category: riskUndecidable}}},
		Approval:       "user", ApprovalStrength: "click",
	}
	snapshot := cliJobSnapshot(job, 1)
	events, ok := snapshot["events"].([]cliJobEvent)
	if !ok || len(events) != 1 || events[0].Sequence != 2 {
		t.Fatalf("events = %#v", snapshot["events"])
	}
	for key, want := range map[string]any{
		"riskTier": "T2", "riskLabel": "bounded destructive", "approval": "user", "approvalStrength": "click",
	} {
		if snapshot[key] != want {
			t.Fatalf("snapshot[%q] = %#v, want %#v", key, snapshot[key], want)
		}
	}
	categories, ok := snapshot["riskCategories"].([]string)
	if !ok || len(categories) != 1 || categories[0] != string(riskUndecidable) {
		t.Fatalf("riskCategories = %#v", snapshot["riskCategories"])
	}
}

func TestCliJobTerminalStates(t *testing.T) {
	for _, state := range []string{"succeeded", "failed", "cancelled"} {
		if !isCliJobTerminal(state) {
			t.Fatalf("%q should be terminal", state)
		}
	}
	if isCliJobTerminal("running") {
		t.Fatal("running should not be terminal")
	}
}
