package app

import (
	"context"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"

	"gxShell/backend/ai"
	sshmanager "gxShell/backend/ssh"
	"gxShell/backend/workflow"
)

func TestBatchApprovalRequiresEveryHostAndPinsModel(t *testing.T) {
	profile, known := inspectionSSHFixture(t)
	app := NewApp()
	app.ctx.Set(context.Background())
	app.automationEventFn = func(terminalAutomationEvent) {}
	app.ssh = sshmanager.NewManager(known, func(string, any) {}, nil)
	first, err := app.ssh.Connect(profile, 5, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	profile.ID, profile.Name = "second-fixture", "Second fixture"
	second, err := app.ssh.Connect(profile, 5, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.ssh.Disconnect(first.ID); _ = app.ssh.Disconnect(second.ID) })
	app.ai = ai.NewManager()
	app.ai.UpdateConfig(ai.Config{Provider: "openai", Model: "original-model"})
	var queries atomic.Int32
	app.inspections, err = workflow.NewManager(t.TempDir(), func(ctx context.Context, id string, query workflow.Query) workflow.Evidence {
		queries.Add(1)
		return app.executeInspectionQuery(ctx, id, query)
	}, func(_ context.Context, cfg ai.Config, _ ai.ChatRequest, _ func(ai.ChatResponse)) error {
		if cfg.Model != "original-model" {
			t.Error("batch changed model after approval")
		}
		return fmt.Errorf("simulated model failure")
	}, nil, nil, app.validateInspectionSession)
	if err != nil {
		t.Fatal(err)
	}
	defer app.inspections.Close()
	panels := newApprovalPanelHarness(app)
	type response struct {
		batch workflow.InspectionBatch
		err   error
	}
	for _, allowed := range [][]string{nil, {first.ID}, {"unknown"}, {first.ID, second.ID}} {
		done := make(chan response, 1)
		go func() {
			batch, err := app.StartAiInspectionBatch([]string{first.ID, second.ID}, 2)
			done <- response{batch, err}
		}()
		request := panels.nextRequest(t)
		if len(request.Items) != 2 || !strings.Contains(request.Summary, "original-model") || request.Items[0].ID != first.ID || request.Items[1].ID != second.ID {
			t.Fatalf("approval did not pin exact hosts/model: %+v", request)
		}
		if len(allowed) == 2 {
			app.ai.UpdateConfig(ai.Config{Provider: "openai", Model: "replacement-model"})
		}
		if err := app.ResolveCliApproval(request.ID, allowed); err != nil {
			t.Fatal(err)
		}
		result := <-done
		if len(allowed) != 2 {
			if result.err == nil || queries.Load() != 0 || len(app.inspections.List()) != 0 {
				t.Fatal("unapproved/partially approved batch executed")
			}
			continue
		}
		if result.err != nil {
			t.Fatal(result.err)
		}
		for _, run := range result.batch.Runs {
			finished := waitInspectionFixture(t, app.inspections, run.ID)
			if finished.Model != "original-model" || len(finished.Evidence) != 7 {
				t.Fatal("batch lost pinned model or evidence")
			}
		}
	}
}
