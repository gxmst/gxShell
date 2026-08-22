package app

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gxShell/backend/config"
	"gxShell/backend/types"
)

// The CLI approval gate coalesces concurrent exec requests for the same server
// into a single native confirmation dialog within a short window, so a burst of
// commands does not spam the user with one dialog each. These tests exercise the
// batching logic through the injectable seams (cliApprovalDelay + the batch
// confirm function) rather than the real GUI dialog.

// TestCliApprovalBatchCoalescesConcurrentRequests fires several concurrent
// confirmCliExecution calls for the same server and asserts they are confirmed
// by a single batch call, and that every caller observes the batch's decision.
func TestCliApprovalBatchCoalescesConcurrentRequests(t *testing.T) {
	app := NewApp()
	app.ctx.Set(context.Background())
	app.cliApprovalDelay = 40 * time.Millisecond

	var batchCalls int32
	var seenCommands int32
	app.cliConfirmBatchFn = func(serverName string, commands []string) bool {
		atomic.AddInt32(&batchCalls, 1)
		atomic.AddInt32(&seenCommands, int32(len(commands)))
		return true
	}

	const n = 8
	var wg sync.WaitGroup
	results := make([]bool, n)
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(idx int) {
			defer wg.Done()
			results[idx] = app.confirmCliExecution("prod-web", "uptime")
		}(i)
	}
	wg.Wait()

	if got := atomic.LoadInt32(&batchCalls); got != 1 {
		t.Fatalf("batch confirm called %d times, want exactly 1 (requests should coalesce)", got)
	}
	if got := atomic.LoadInt32(&seenCommands); got != n {
		t.Fatalf("batch saw %d commands, want %d", got, n)
	}
	for i, ok := range results {
		if !ok {
			t.Fatalf("request %d did not receive the batch approval", i)
		}
	}
}

// TestCliApprovalBatchDecisionPropagatesToAll ensures a denied batch denies
// every waiter, not just the leader.
func TestCliApprovalBatchDecisionPropagatesToAll(t *testing.T) {
	app := NewApp()
	app.ctx.Set(context.Background())
	app.cliApprovalDelay = 40 * time.Millisecond
	app.cliConfirmBatchFn = func(serverName string, commands []string) bool {
		return false
	}

	const n = 5
	var wg sync.WaitGroup
	results := make([]bool, n)
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(idx int) {
			defer wg.Done()
			results[idx] = app.confirmCliExecution("prod-web", "systemctl restart nginx")
		}(i)
	}
	wg.Wait()

	for i, ok := range results {
		if ok {
			t.Fatalf("request %d was approved despite a denied batch", i)
		}
	}
}

// TestCliApprovalSeparateServersDoNotShareBatch ensures requests to different
// servers are batched independently: each server gets its own confirmation.
func TestCliApprovalSeparateServersDoNotShareBatch(t *testing.T) {
	app := NewApp()
	app.ctx.Set(context.Background())
	app.cliApprovalDelay = 40 * time.Millisecond

	var mu sync.Mutex
	seenServers := map[string]int{}
	app.cliConfirmBatchFn = func(serverName string, commands []string) bool {
		mu.Lock()
		seenServers[serverName]++
		mu.Unlock()
		return true
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); app.confirmCliExecution("prod-web", "uptime") }()
	go func() { defer wg.Done(); app.confirmCliExecution("dev-box", "uptime") }()
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if len(seenServers) != 2 {
		t.Fatalf("expected 2 distinct server batches, got %#v", seenServers)
	}
	for server, count := range seenServers {
		if count != 1 {
			t.Fatalf("server %q confirmed %d times, want 1", server, count)
		}
	}
}

// TestCliApprovalKeyIsCaseInsensitive ensures the batch key folds case, so
// "Prod-Web" and "prod-web" coalesce into one dialog rather than two.
func TestCliApprovalKeyIsCaseInsensitive(t *testing.T) {
	app := NewApp()
	app.ctx.Set(context.Background())
	app.cliApprovalDelay = 40 * time.Millisecond

	var batchCalls int32
	app.cliConfirmBatchFn = func(serverName string, commands []string) bool {
		atomic.AddInt32(&batchCalls, 1)
		return true
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); app.confirmCliExecution("prod-web", "uptime") }()
	go func() { defer wg.Done(); app.confirmCliExecution("PROD-WEB", "uptime") }()
	wg.Wait()

	if got := atomic.LoadInt32(&batchCalls); got != 1 {
		t.Fatalf("case-differing server names produced %d batches, want 1", got)
	}
}

// TestCliApprovalSequentialBatchesReopen ensures that after one batch flushes, a
// later request opens a fresh batch (the map entry is cleared, not leaked).
func TestCliApprovalSequentialBatchesReopen(t *testing.T) {
	app := NewApp()
	app.ctx.Set(context.Background())
	app.cliApprovalDelay = 20 * time.Millisecond

	var batchCalls int32
	app.cliConfirmBatchFn = func(serverName string, commands []string) bool {
		atomic.AddInt32(&batchCalls, 1)
		return true
	}

	if !app.confirmCliExecution("prod-web", "uptime") {
		t.Fatal("first request should be approved")
	}
	if !app.confirmCliExecution("prod-web", "uptime") {
		t.Fatal("second request should be approved")
	}

	if got := atomic.LoadInt32(&batchCalls); got != 2 {
		t.Fatalf("sequential requests produced %d batches, want 2", got)
	}
}

func TestCliTimedTrustSkipsDialog(t *testing.T) {
	store, err := config.NewStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	app.store = store
	profile := types.Profile{
		ID:            "prod",
		CliEnabled:    true,
		CliAlias:      "prod-web",
		CliTrustUntil: time.Now().Add(time.Hour),
	}
	if err := store.SaveProfiles([]types.Profile{profile}); err != nil {
		t.Fatal(err)
	}
	decision := app.authorizeCliProfileExecution(profile, "systemctl restart nginx")
	if !decision.Allowed || decision.Source != cliApprovalTimedTrust {
		t.Fatal("trusted CLI request was not auto-approved")
	}

	profile.CliTrustUntil = time.Now().Add(-time.Second)
	if err := store.SaveProfiles([]types.Profile{profile}); err != nil {
		t.Fatal(err)
	}
	decision = app.authorizeCliProfileExecution(profile, "systemctl restart nginx")
	if decision.Allowed || decision.Source != cliApprovalUser {
		t.Fatal("expired trust did not fall back to fail-closed user approval")
	}
}

func TestCliRiskTierAuthorization(t *testing.T) {
	store, err := config.NewStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	app.ctx.Set(context.Background())
	app.store = store
	app.cliApprovalEventFn = func(cliApprovalEvent) {}
	app.cliApprovalDelay = time.Millisecond
	profile := types.Profile{
		ID: "prod", CliEnabled: true, CliAlias: "prod-web",
		CliTrustUntil: time.Now().Add(time.Hour),
	}
	if err := store.SaveProfiles([]types.Profile{profile}); err != nil {
		t.Fatal(err)
	}

	var batchCalls int32
	app.cliConfirmBatchFn = func(_ string, _ []string) bool {
		atomic.AddInt32(&batchCalls, 1)
		return true
	}
	type riskCall struct {
		tier     commandTier
		strength approvalStrength
	}
	var riskCalls []riskCall
	var riskMu sync.Mutex
	app.cliConfirmRiskFn = func(_ string, _ string, assessment riskAssessment, strength approvalStrength) (bool, error) {
		riskMu.Lock()
		riskCalls = append(riskCalls, riskCall{tier: assessment.Tier, strength: strength})
		riskMu.Unlock()
		return true, nil
	}

	for _, command := range []string{"uptime", "mkdir -p /srv/app"} {
		decision := app.authorizeCliProfileExecution(profile, command)
		if !decision.Allowed {
			t.Fatalf("trusted %q was denied", command)
		}
	}
	if got := atomic.LoadInt32(&batchCalls); got != 0 {
		t.Fatalf("T0/T1 trusted commands opened %d batch dialogs, want 0", got)
	}

	decision := app.authorizeCliProfileExecution(profile, "rm -rf /srv/app/old")
	if !decision.Allowed || decision.Source != cliApprovalTimedTrust {
		t.Fatal("trusted T2 request with a resolved target was not auto-approved by the trust window")
	}
	if got := atomic.LoadInt32(&batchCalls); got != 0 {
		t.Fatalf("resolved T2 command opened %d batch dialogs, want 0", got)
	}

	// An undecidable command is floored at T2 by rule 1, and that half of the
	// tier stays outside the trust window: the classifier prompts precisely
	// because it could not read the command, so a window must not convert that
	// into an approval.
	decision = app.authorizeCliProfileExecution(profile, `rm -rf "$TARGET_DIR"`)
	if !decision.Allowed || decision.Source != cliApprovalUser {
		t.Fatal("trusted but undecidable T2 request did not require and receive user approval")
	}
	if got := atomic.LoadInt32(&batchCalls); got != 1 {
		t.Fatalf("undecidable T2 command opened %d batch dialogs, want 1", got)
	}

	decision = app.authorizeCliProfileExecution(profile, "rm -rf /etc")
	if !decision.Allowed {
		t.Fatal("trusted T3 request was denied by the test confirmation")
	}
	riskMu.Lock()
	if len(riskCalls) != 1 || riskCalls[0].tier != tierCritical || riskCalls[0].strength != approvalClick {
		t.Fatalf("trusted T3 risk calls = %#v, want one immediate click confirmation", riskCalls)
	}
	riskMu.Unlock()
	if got := atomic.LoadInt32(&batchCalls); got != 1 {
		t.Fatalf("T3 entered the ordinary batch; batch calls = %d, want unchanged", got)
	}

	profile.CliTrustUntil = time.Now().Add(-time.Second)
	if err := store.SaveProfiles([]types.Profile{profile}); err != nil {
		t.Fatal(err)
	}
	decision = app.authorizeCliProfileExecution(profile, "rm -rf /etc")
	if !decision.Allowed {
		t.Fatal("untrusted T3 request was denied by the test confirmation")
	}
	decision = app.authorizeCliProfileExecution(profile, "cat /root/.aws/credentials")
	if !decision.Allowed {
		t.Fatal("credential T3 request was denied by the test confirmation")
	}
	riskMu.Lock()
	defer riskMu.Unlock()
	if len(riskCalls) != 3 || riskCalls[1].strength != approvalClick || riskCalls[2].strength != approvalClick {
		t.Fatalf("untrusted/credential T3 risk calls = %#v, want click confirmations", riskCalls)
	}
}

func TestCliCriticalConfirmationErrorIsNotUserDenial(t *testing.T) {
	store, err := config.NewStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	app.ctx.Set(context.Background())
	app.store = store
	app.cliApprovalEventFn = func(cliApprovalEvent) {}
	profile := types.Profile{ID: "prod", CliEnabled: true, CliAlias: "prod-web"}
	if err := store.SaveProfiles([]types.Profile{profile}); err != nil {
		t.Fatal(err)
	}

	dialogErr := errors.New("native dialog failed")
	app.cliConfirmRiskFn = func(_ string, _ string, _ riskAssessment, _ approvalStrength) (bool, error) {
		return false, dialogErr
	}
	decision := app.authorizeCliProfileExecution(profile, "rm -rf /etc")
	if decision.Allowed {
		t.Fatal("T3 command was allowed after the native dialog failed")
	}
	if !errors.Is(decision.Err, dialogErr) {
		t.Fatalf("confirmation error = %v, want %v", decision.Err, dialogErr)
	}
}

func TestCliApprovalEventLifecycle(t *testing.T) {
	store, err := config.NewStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	app.ctx.Set(context.Background())
	app.store = store
	app.cliApprovalDelay = time.Millisecond
	profile := types.Profile{ID: "prod", CliEnabled: true, CliAlias: "prod-web"}
	if err := store.SaveProfiles([]types.Profile{profile}); err != nil {
		t.Fatal(err)
	}

	var events []cliApprovalEvent
	app.cliApprovalEventFn = func(event cliApprovalEvent) {
		events = append(events, event)
	}
	app.cliConfirmBatchFn = func(_ string, _ []string) bool { return true }
	decision := app.authorizeCliProfileExecution(profile, "rm -rf /srv/app/old")
	if !decision.Allowed {
		t.Fatal("test approval was not propagated")
	}
	if len(events) != 2 || events[0].Phase != "pending" || events[1].Phase != "approved" || events[0].ID != events[1].ID {
		t.Fatalf("approved event lifecycle = %#v", events)
	}
	if events[0].RiskTier != "T2" || events[0].Strength != "click" || events[0].Command == "" {
		t.Fatalf("pending event omitted risk context: %#v", events[0])
	}

	events = nil
	app.cliConfirmBatchFn = func(_ string, _ []string) bool { return false }
	decision = app.authorizeCliProfileExecution(profile, "rm -rf /srv/app/old")
	if decision.Allowed {
		t.Fatal("test denial was not propagated")
	}
	if len(events) != 2 || events[0].Phase != "pending" || events[1].Phase != "denied" || events[0].ID != events[1].ID {
		t.Fatalf("denied event lifecycle = %#v", events)
	}
}

func TestCliApprovalUsesConfiguredChineseExplanation(t *testing.T) {
	store, err := config.NewStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	settings, err := store.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	settings.Language = "zh-CN"
	if err := store.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}

	app := NewApp()
	app.ctx.Set(context.Background())
	app.store = store
	app.cliApprovalDelay = time.Millisecond
	profile := types.Profile{ID: "prod", CliEnabled: true, CliAlias: "prod-web"}
	if err := store.SaveProfiles([]types.Profile{profile}); err != nil {
		t.Fatal(err)
	}

	var pending cliApprovalEvent
	app.cliApprovalEventFn = func(event cliApprovalEvent) {
		if event.Phase == "pending" {
			pending = event
		}
	}
	var nativeText string
	app.cliConfirmBatchFn = func(_ string, commands []string) bool {
		nativeText = commands[0]
		return true
	}
	decision := app.authorizeCliProfileExecution(profile, "rm -rf /srv/app/old")
	if !decision.Allowed {
		t.Fatal("test approval was not propagated")
	}
	if pending.RiskLabel != "有限破坏性操作" || len(pending.RiskLines) == 0 || pending.RiskLines[0] != "删除文件：/srv/app/old" {
		t.Fatalf("pending event was not localized: %#v", pending)
	}
	if !strings.Contains(nativeText, "作用说明：\n- 删除文件：/srv/app/old") || !strings.Contains(nativeText, "风险等级：T2（有限破坏性操作）") {
		t.Fatalf("native approval text was not localized: %q", nativeText)
	}
}

func TestCliTimedTrustCopyRequiresBothProfiles(t *testing.T) {
	store, err := config.NewStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	app.store = store
	future := time.Now().Add(time.Hour)
	source := types.Profile{ID: "source", CliEnabled: true, CliAlias: "source", CliTrustUntil: future}
	destination := types.Profile{ID: "destination", CliEnabled: true, CliAlias: "destination", CliTrustUntil: future}
	if err := store.SaveProfiles([]types.Profile{source, destination}); err != nil {
		t.Fatal(err)
	}
	decision := app.authorizeCliCopy(source, destination, "copy")
	if !decision.Allowed || decision.Source != cliApprovalTimedTrust {
		t.Fatal("two trusted copy endpoints did not bypass approval")
	}
	destination.CliTrustUntil = time.Now().Add(-time.Second)
	if err := store.SaveProfiles([]types.Profile{source, destination}); err != nil {
		t.Fatal(err)
	}
	decision = app.authorizeCliCopy(source, destination, "copy")
	if decision.Allowed || decision.Source != cliApprovalUser {
		t.Fatal("copy with one expired endpoint did not require user approval")
	}
}

// The in-app AI assistant and transfer/copy path checks still use the legacy
// preflight guard. External CLI exec uses the tier classifier tested above.
func TestLegacyCommandGuardStillBlocksItsCallers(t *testing.T) {
	for _, command := range []string{"rm -rf /", "shutdown now", "cat /etc/shadow"} {
		confirmCalled := false
		block, ok := guardCommandReport(command, false, func() bool {
			confirmCalled = true
			return true
		})
		if ok {
			t.Errorf("%q passed the legacy known-pattern guard", command)
		}
		if confirmCalled {
			t.Errorf("%q reached confirmation before the legacy preflight guard", command)
		}
		if block.Kind == "" {
			t.Errorf("%q returned no structured block reason", command)
		}
	}
}
