package app

import (
	"context"
	"errors"
	"testing"
	"time"

	sshmanager "gxShell/backend/ssh"
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

func TestCliRemoteOutcomeIsConservative(t *testing.T) {
	for _, test := range []struct {
		result sshmanager.CommandExecutionResult
		err    error
		want   string
	}{
		{sshmanager.CommandExecutionResult{RemoteExitObserved: true}, nil, "exited"},
		{sshmanager.CommandExecutionResult{}, &sshmanager.CommandNotStartedError{Stage: "cancelled", Err: context.Canceled}, "not_started"},
		{sshmanager.CommandExecutionResult{TimedOut: true}, errors.New("timeout"), "unknown"},
		{sshmanager.CommandExecutionResult{}, context.Canceled, "unknown"},
	} {
		if got := cliRemoteState(test.result, test.err); got != test.want {
			t.Fatalf("got %s want %s", got, test.want)
		}
	}
	job := &cliJob{State: "cancelled", CancelRequested: true, RemoteState: "unknown", FinishedAt: time.Now()}
	snapshot := cliJobSnapshot(job, 0)
	if snapshot["remoteState"] != "unknown" || snapshot["cancelRequested"] != true || snapshot["message"] == nil {
		t.Fatalf("snapshot=%v", snapshot)
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
