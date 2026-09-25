package app

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gxShell/backend/config"
	"gxShell/backend/types"
)

// The approval panel replaces the native MessageBox as the review surface for
// external CLI and AI requests. These tests drive it through the seams
// (cliApprovalPanelFn + cliApprovalPanelClosedFn) instead of a real renderer.

type approvalPanelHarness struct {
	requests chan cliApprovalPanelRequest
	closed   chan string
	raised   int32
	cleared  int32
}

func newApprovalPanelHarness(app *App) *approvalPanelHarness {
	h := &approvalPanelHarness{
		requests: make(chan cliApprovalPanelRequest, 16),
		closed:   make(chan string, 16),
	}
	app.frontendReady.Store(true)
	app.cliApprovalPanelFn = func(req cliApprovalPanelRequest) { h.requests <- req }
	app.cliApprovalPanelClosedFn = func(id string) { h.closed <- id }
	// The real window calls go through Wails and need the lifecycle context.
	app.windowRaiseFn = func() { atomic.AddInt32(&h.raised, 1) }
	app.windowClearFn = func() { atomic.AddInt32(&h.cleared, 1) }
	return h
}

func (h *approvalPanelHarness) nextRequest(t *testing.T) cliApprovalPanelRequest {
	t.Helper()
	select {
	case req := <-h.requests:
		return req
	case <-time.After(5 * time.Second):
		t.Fatal("the approval panel was never requested")
		return cliApprovalPanelRequest{}
	}
}

// A renderer that has not registered its listener must not receive a panel:
// nobody would answer it, and the request would hang until the safety timeout.
func TestApprovalPanelUnavailableBeforeRendererRegisters(t *testing.T) {
	app := NewApp()
	app.ctx.Set(context.Background())
	if _, ok := app.requestCliApprovalPanel(context.Background(), cliApprovalPanelRequest{
		Items: []cliApprovalItem{{ID: "cmd-0", Text: "uptime"}},
	}); ok {
		t.Fatal("the panel was used before the renderer registered")
	}

	// And without an application context at all.
	headless := NewApp()
	headless.frontendReady.Store(true)
	if _, ok := headless.requestCliApprovalPanel(context.Background(), cliApprovalPanelRequest{
		Items: []cliApprovalItem{{ID: "cmd-0", Text: "uptime"}},
	}); ok {
		t.Fatal("the panel was used without an application context")
	}
}

func TestResolveCliApprovalRejectsEmptyIDAndIgnoresUnknown(t *testing.T) {
	app := NewApp()
	if err := app.ResolveCliApproval("   ", []string{"cmd-0"}); err == nil {
		t.Fatal("an empty request id was accepted")
	}
	// A stale renderer replaying an id that was already answered, cancelled or
	// timed out must not error and must not approve anything.
	if err := app.ResolveCliApproval("panel-does-not-exist", []string{"cmd-0"}); err != nil {
		t.Fatalf("resolving an unknown panel returned %v", err)
	}
}

// The mask is the trust boundary of the panel: only ids the renderer was
// actually given, and only ids it named, can come back approved.
func TestApprovalPanelMaskDeniesUnnamedItems(t *testing.T) {
	items := []cliApprovalItem{{ID: "a"}, {ID: "b"}, {ID: "c"}}
	got := cliApprovalPanelResult{Approved: []string{"b", "invented", ""}}.mask(items)
	want := []bool{false, true, false}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("mask = %v, want %v", got, want)
		}
	}
	if denied := (cliApprovalPanelResult{}).mask(items); denied[0] || denied[1] || denied[2] {
		t.Fatalf("an empty decision approved %v", denied)
	}
}

// The panel accepts a subset, and each caller must observe its own verdict
// rather than the batch's.
func TestCliBatchPanelApprovesSubset(t *testing.T) {
	app := NewApp()
	app.ctx.Set(context.Background())
	app.cliApprovalDelay = time.Millisecond
	h := newApprovalPanelHarness(app)

	commands := []string{"uptime", "mkdir -p /srv/app", "rm -rf /srv/app/old"}
	results := make([]bool, len(commands))
	var wg sync.WaitGroup
	wg.Add(len(commands))
	for i, command := range commands {
		go func(idx int, cmd string) {
			defer wg.Done()
			results[idx] = app.confirmCliExecutionCtx(context.Background(), "prod-web", cmd)
		}(i, command)
	}

	req := h.nextRequest(t)
	if len(req.Items) != len(commands) {
		t.Fatalf("the panel carried %d items, want %d", len(req.Items), len(commands))
	}
	byText := map[string]string{}
	for _, item := range req.Items {
		byText[item.Text] = item.ID
	}
	// Approve the two harmless commands only; the destructive one must stay out.
	if err := app.ResolveCliApproval(req.ID, []string{byText["uptime"], byText["mkdir -p /srv/app"]}); err != nil {
		t.Fatal(err)
	}
	wg.Wait()

	want := map[string]bool{"uptime": true, "mkdir -p /srv/app": true, "rm -rf /srv/app/old": false}
	for i, command := range commands {
		if results[i] != want[command] {
			t.Fatalf("%q verdict = %v, want %v", command, results[i], want[command])
		}
	}
	// The user chose an interrupting prompt, so the window is raised while the
	// panel is up and the always-on-top pin is released once it resolves.
	if got := atomic.LoadInt32(&h.raised); got != 1 {
		t.Fatalf("the window was raised %d times, want 1", got)
	}
	if got := atomic.LoadInt32(&h.cleared); got != 1 {
		t.Fatalf("the always-on-top pin was cleared %d times, want 1", got)
	}
}

// Panels are serialised: a second request waits for the first to come down
// instead of stacking a second modal on top of it, matching the native dialog
// it replaced.
func TestApprovalPanelsAreSerialised(t *testing.T) {
	app := NewApp()
	app.ctx.Set(context.Background())
	h := newApprovalPanelHarness(app)

	firstDone := make(chan bool, 1)
	secondDone := make(chan bool, 1)
	go func() { firstDone <- app.confirmCliExecution("prod-web", "uptime") }()
	first := h.nextRequest(t)

	go func() { secondDone <- app.confirmCliExecution("prod-web", "whoami") }()

	// The second request must not reach the renderer while the first is up.
	select {
	case second := <-h.requests:
		t.Fatalf("a second panel was emitted while one was pending: %#v", second)
	case <-time.After(100 * time.Millisecond):
	}

	// Denying the first releases the gate and lets the second through.
	if err := app.ResolveCliApproval(first.ID, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case allowed := <-firstDone:
		if allowed {
			t.Fatal("a denied panel approved its request")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the first request stayed blocked")
	}

	second := h.nextRequest(t)
	if second.ID == first.ID {
		t.Fatal("the queued request reused the resolved panel id")
	}
	ids := make([]string, 0, len(second.Items))
	for _, item := range second.Items {
		ids = append(ids, item.ID)
	}
	if err := app.ResolveCliApproval(second.ID, ids); err != nil {
		t.Fatal(err)
	}
	select {
	case allowed := <-secondDone:
		if !allowed {
			t.Fatal("the queued request was not approved")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the queued request stayed blocked")
	}
}

// A caller that disconnects while queued behind another panel is denied rather
// than left holding a place for a prompt it will never be shown.
func TestQueuedCallerDeniedWhenItDisconnects(t *testing.T) {
	app := NewApp()
	app.ctx.Set(context.Background())
	h := newApprovalPanelHarness(app)

	firstDone := make(chan bool, 1)
	go func() { firstDone <- app.confirmCliExecution("prod-web", "uptime") }()
	first := h.nextRequest(t)

	queuedCtx, cancelQueued := context.WithCancel(context.Background())
	queuedDone := make(chan bool, 1)
	go func() { queuedDone <- app.confirmCliExecutionCtx(queuedCtx, "prod-web", "whoami") }()

	// Give the queued caller time to actually be waiting on the gate.
	time.Sleep(50 * time.Millisecond)
	cancelQueued()

	select {
	case allowed := <-queuedDone:
		if allowed {
			t.Fatal("a disconnected queued caller was approved")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a disconnected queued caller stayed blocked")
	}

	// The panel that was up is unaffected and still resolvable.
	if err := app.ResolveCliApproval(first.ID, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-firstDone:
	case <-time.After(5 * time.Second):
		t.Fatal("the visible panel stayed blocked")
	}
}

// A timeout denies. It must NOT fall back to the native dialog: that dialog is
// the thing the panel replaced, and a batch too long to read is exactly what it
// cannot show.
func TestApprovalPanelTimeoutDenies(t *testing.T) {
	app := NewApp()
	app.ctx.Set(context.Background())
	app.approvalPanelTimeout = 20 * time.Millisecond
	h := newApprovalPanelHarness(app)

	done := make(chan bool, 1)
	go func() { done <- app.confirmCliExecution("prod-web", "uptime") }()
	h.nextRequest(t)

	select {
	case allowed := <-done:
		if allowed {
			t.Fatal("an unanswered panel approved its request")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("an unanswered panel never timed out")
	}

	// The gate must be free again, or every later approval would be blocked.
	if got := app.approvalPanel.len(); got != 0 {
		t.Fatalf("%d panels are still registered after a timeout", got)
	}
	if allowed := app.acquireApprovalGate(context.Background()); !allowed {
		t.Fatal("the approval gate was never released")
	}
	app.releaseApprovalGate()
}

// A renderer that reloads has no memory of the panel it was showing, so a
// re-registration denies whatever was pending instead of leaving it to hang.
func TestRendererReloadDeniesPendingPanels(t *testing.T) {
	app := NewApp()
	app.ctx.Set(context.Background())
	h := newApprovalPanelHarness(app)

	done := make(chan bool, 1)
	go func() { done <- app.confirmCliExecution("prod-web", "uptime") }()
	h.nextRequest(t)

	if err := app.RegisterApprovalPanel(); err != nil {
		t.Fatal(err)
	}

	select {
	case allowed := <-done:
		if allowed {
			t.Fatal("a panel orphaned by a renderer reload was approved")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a panel orphaned by a renderer reload stayed blocked")
	}
	if got := app.approvalPanel.len(); got != 0 {
		t.Fatalf("%d panels survived a renderer reload", got)
	}
}

// A caller that disconnects must not be approved, and once no caller is left
// the panel comes down instead of asking about a dead request.
func TestCliBatchPanelDismissedWhenCallersDisconnect(t *testing.T) {
	app := NewApp()
	app.ctx.Set(context.Background())
	app.cliApprovalDelay = time.Millisecond
	h := newApprovalPanelHarness(app)

	callerCtx, cancel := context.WithCancel(context.Background())
	done := make(chan bool, 1)
	go func() { done <- app.confirmCliExecutionCtx(callerCtx, "prod-web", "uptime") }()

	req := h.nextRequest(t)
	cancel()

	select {
	case allowed := <-done:
		if allowed {
			t.Fatal("a disconnected caller was approved")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a disconnected caller stayed blocked")
	}
	select {
	case id := <-h.closed:
		if id != req.ID {
			t.Fatalf("closed %q, want %q", id, req.ID)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the panel was not dismissed after the last caller disconnected")
	}
}

// The panel stays up while another caller is still waiting, so one disconnect
// cannot deny a request somebody else is blocked on.
func TestCliBatchPanelSurvivesOneDisconnectedCaller(t *testing.T) {
	app := NewApp()
	app.ctx.Set(context.Background())
	app.cliApprovalDelay = time.Millisecond
	h := newApprovalPanelHarness(app)

	firstCtx, cancelFirst := context.WithCancel(context.Background())
	firstDone := make(chan bool, 1)
	secondDone := make(chan bool, 1)
	go func() { firstDone <- app.confirmCliExecutionCtx(firstCtx, "prod-web", "uptime") }()
	go func() { secondDone <- app.confirmCliExecutionCtx(context.Background(), "prod-web", "whoami") }()

	req := h.nextRequest(t)
	if len(req.Items) != 2 {
		t.Fatalf("the panel carried %d items, want 2", len(req.Items))
	}
	cancelFirst()

	select {
	case <-h.closed:
		t.Fatal("the panel was dismissed while a caller was still waiting")
	case <-time.After(50 * time.Millisecond):
	}

	ids := make([]string, 0, len(req.Items))
	for _, item := range req.Items {
		ids = append(ids, item.ID)
	}
	if err := app.ResolveCliApproval(req.ID, ids); err != nil {
		t.Fatal(err)
	}

	select {
	case allowed := <-firstDone:
		if allowed {
			t.Fatal("the disconnected caller was approved")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the disconnected caller stayed blocked")
	}
	select {
	case allowed := <-secondDone:
		if !allowed {
			t.Fatal("the surviving caller was denied")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the surviving caller stayed blocked")
	}
}

// A critical request reaches the panel alone, marked critical, with the risk
// context the native dialog used to spell out.
func TestCliCriticalPanelCarriesRiskContext(t *testing.T) {
	store, err := config.NewStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	app.ctx.Set(context.Background())
	app.store = store
	profile := types.Profile{ID: "prod", CliEnabled: true, CliAlias: "prod-web"}
	if err := store.SaveProfiles([]types.Profile{profile}); err != nil {
		t.Fatal(err)
	}
	h := newApprovalPanelHarness(app)

	done := make(chan bool, 1)
	go func() { done <- app.authorizeCliProfileExecution(profile, "rm -rf /etc").Allowed }()

	req := h.nextRequest(t)
	if !req.Critical {
		t.Fatal("a T3 request did not mark the panel critical")
	}
	if len(req.Items) != 1 {
		t.Fatalf("the critical panel carried %d items, want 1", len(req.Items))
	}
	item := req.Items[0]
	if item.RiskTier != "T3" {
		t.Fatalf("risk tier = %q, want T3", item.RiskTier)
	}
	if item.Text != "rm -rf /etc" {
		t.Fatalf("item text = %q, want the raw command so spans stay aligned", item.Text)
	}
	if len(item.RiskLines) == 0 || item.Detail == "" {
		t.Fatalf("critical item dropped its explanation: %#v", item)
	}

	if err := app.ResolveCliApproval(req.ID, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case allowed := <-done:
		if allowed {
			t.Fatal("a denied critical request was allowed")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the critical request stayed blocked")
	}
}

// While the panel is authoritative the decorative risk card must not also fire:
// it carries the same context and would double the prompt.
func TestApprovalPanelSupersedesInformationalCard(t *testing.T) {
	app := NewApp()
	app.ctx.Set(context.Background())
	cards := 0
	app.cliApprovalEventFn = func(cliApprovalEvent) { cards++ }
	app.frontendReady.Store(true)

	allowed := app.withCliApprovalEvent("prod-web", "uptime", riskAssessment{}, approvalClick, "", nil, func() bool {
		return true
	})
	if !allowed {
		t.Fatal("the confirmation result was not propagated")
	}
	if cards != 0 {
		t.Fatalf("the informational card fired %d times while the panel is active", cards)
	}
}

// The native dialog remains the fallback, so the informational card still fires
// when the renderer cannot serve a panel.
func TestInformationalCardStillFiresWithoutRenderer(t *testing.T) {
	app := NewApp()
	app.ctx.Set(context.Background())
	cards := 0
	app.cliApprovalEventFn = func(cliApprovalEvent) { cards++ }

	allowed := app.withCliApprovalEvent("prod-web", "uptime", riskAssessment{}, approvalClick, "", nil, func() bool {
		return true
	})
	if !allowed {
		t.Fatal("the confirmation result was not propagated")
	}
	if cards != 2 {
		t.Fatalf("the informational card fired %d times, want a pending and a resolved event", cards)
	}
}
