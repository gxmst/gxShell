package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gxShell/backend/ai"
	"gxShell/backend/workflow"
)

func TestSavedCaseEvaluationAsksBeforeSendingRealEvidence(t *testing.T) {
	dir := t.TempDir()
	id := "saved-" + strings.Repeat("ab", 16)
	saved := workflow.SavedCase{ID: id, Title: "Root disk missed", Target: "web-1", Workflow: "host_inspection",
		Evidence: []workflow.Evidence{{ID: "E1", Query: workflow.Query{Check: "disk"}, Status: "collected", Output: "/dev/vda1 98% /"}},
		Expected: map[string]string{"disk": "critical"}, CreatedAt: time.Now()}
	data, _ := json.Marshal(saved)
	if err := os.MkdirAll(filepath.Join(dir, "cases"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "cases", strings.Repeat("ab", 16)+".json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	secondID := "saved-" + strings.Repeat("cd", 16)
	second := saved
	second.ID, second.Title, second.Target = secondID, "Service missed", "web-2"
	secondData, _ := json.Marshal(second)
	if err := os.WriteFile(filepath.Join(dir, "cases", strings.Repeat("cd", 16)+".json"), secondData, 0600); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	app.ctx.Set(context.Background())
	app.ai = ai.NewManager()
	app.ai.UpdateConfig(ai.Config{Provider: "openai", Model: "fixture-a"})
	called := make(chan struct{}, 4)
	model := func(context.Context, ai.Config, ai.ChatRequest, func(ai.ChatResponse)) error {
		called <- struct{}{}
		return context.Canceled
	}
	var err error
	app.inspections, err = workflow.NewManager(dir, nil, model, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer app.inspections.Close()
	panels := newApprovalPanelHarness(app)

	done := make(chan error, 1)
	go func() { _, err := app.StartAiInspectionEvaluation([]string{"healthy_host", id}); done <- err }()
	req := panels.nextRequest(t)
	if len(req.Items) != 1 || req.Items[0].ID != id || !strings.Contains(req.Items[0].Text, "web-1") || !strings.Contains(req.Summary, "fixture-a") {
		t.Fatalf("panel did not name the saved case, server and model: %+v", req)
	}
	if err := app.ResolveCliApproval(req.ID, nil); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err == nil {
		t.Fatal("rejected evaluation started")
	}
	select {
	case <-called:
		t.Fatal("rejected evaluation reached the model")
	case <-time.After(100 * time.Millisecond):
	}

	go func() { _, err := app.StartAiInspectionEvaluation([]string{id, secondID}); done <- err }()
	req = panels.nextRequest(t)
	if len(req.Items) != 2 {
		t.Fatalf("expected both real-server cases to be reviewed: %+v", req)
	}
	if err := app.ResolveCliApproval(req.ID, []string{id}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err == nil {
		t.Fatal("partially approved batch started and could send an unchecked case")
	}
	select {
	case <-called:
		t.Fatal("partially approved batch reached the model")
	case <-time.After(100 * time.Millisecond):
	}

	if _, err := app.StartAiInspectionEvaluation([]string{"healthy_host"}); err != nil {
		t.Fatalf("fixed fixtures need no confirmation: %v", err)
	}
	select {
	case req := <-panels.requests:
		t.Fatalf("fixed fixtures asked for approval: %+v", req)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestInspectionConfirmationRequiresEveryRequestedItem(t *testing.T) {
	for _, test := range []struct {
		name string
		ids  []string
		want bool
	}{
		{"invented selection", []string{"a", "invented"}, false},
		{"complete selection", []string{"a", "b"}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			app := NewApp()
			app.ctx.Set(context.Background())
			panels := newApprovalPanelHarness(app)
			done := make(chan bool, 1)
			go func() {
				done <- app.confirmInspection("Review", "Review cases", cliApprovalPanelRequest{Source: "ai", Items: []cliApprovalItem{
					{ID: "a", Kind: "inspection", Text: "Case A", RiskTier: "T0"},
					{ID: "b", Kind: "inspection", Text: "Case B", RiskTier: "T0"},
				}})
			}()
			req := panels.nextRequest(t)
			if err := app.ResolveCliApproval(req.ID, test.ids); err != nil {
				t.Fatal(err)
			}
			if got := <-done; got != test.want {
				t.Fatalf("confirmation = %v, want %v", got, test.want)
			}
		})
	}
}
