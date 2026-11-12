package app

import (
	"context"
	"testing"
	"time"
)

func TestAiApprovalsCarryRiskAndReviewCriticalPlansSeparately(t *testing.T) {
	app := NewApp()
	app.ctx.Set(context.Background())
	h := newApprovalPanelHarness(app)
	plans := []aiToolExecutionPlan{
		{ToolName: "execute_command", Command: "uptime", Detail: "uptime", Target: "test"},
		{ToolName: "execute_command", Command: "uname -a", Detail: "uname -a", Target: "test"},
		{ToolName: "execute_command", Command: "git push origin main", Detail: "git push origin main", Target: "test"},
		{ToolName: "execute_command", Command: "uptime", Detail: "uptime\nNamed secrets: TOKEN=secret://test-key (values hidden)", SecretNames: []string{"TOKEN=secret://test-key"}, Target: "test"},
	}
	done := make(chan []bool, 1)
	go func() { done <- app.confirmAiToolExecutionBatch(plans) }()
	ordinary := h.nextRequest(t)
	if ordinary.Critical || len(ordinary.Items) != 2 {
		t.Fatal("ordinary plans were not batched")
	}
	for _, item := range ordinary.Items {
		if item.RiskTier != "T0" || item.RiskLabel == "" {
			t.Fatalf("missing risk metadata: %#v", item)
		}
	}
	if err := app.ResolveCliApproval(ordinary.ID, []string{ordinary.Items[1].ID}); err != nil {
		t.Fatal(err)
	}
	critical := h.nextRequest(t)
	if !critical.Critical || len(critical.Items) != 1 || critical.Items[0].RiskTier != "T3" || len(critical.Items[0].Spans) == 0 || len(critical.Items[0].RiskLines) == 0 {
		t.Fatalf("critical metadata missing: %#v", critical)
	}
	if err := app.ResolveCliApproval(critical.ID, nil); err != nil {
		t.Fatal(err)
	}
	credential := h.nextRequest(t)
	if !credential.Critical || len(credential.Items) != 1 || credential.Items[0].RiskTier != "T3" || len(credential.Items[0].RiskLines) == 0 {
		t.Fatalf("named credential risk missing: %#v", credential)
	}
	if err := app.ResolveCliApproval(credential.ID, []string{credential.Items[0].ID}); err != nil {
		t.Fatal(err)
	}
	select {
	case approved := <-done:
		want := []bool{false, true, false, true}
		for i := range want {
			if approved[i] != want[i] {
				t.Fatalf("verdicts=%v want=%v", approved, want)
			}
		}
	case <-time.After(5 * time.Second):
		t.Fatal("AI approvals never completed")
	}
}
