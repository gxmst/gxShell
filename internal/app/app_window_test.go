package app

import (
	"context"
	"testing"

	"gxShell/backend/types"
	"gxShell/internal/desktop"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// The window-control bindings run before Wails publishes its context in tests
// (and, in the renderer, until the bindings inject). Every method must be a
// silent no-op there rather than a panic, and the state queries must fail
// closed to "not maximized" so the caption glyph stays on maximize.
func TestWindowControlsAreNoOpsWithoutContext(t *testing.T) {
	a := NewApp()

	a.MinimiseWindow()
	a.CloseWindow()
	a.RequestCloseWindow()
	a.SetWindowBackgroundColour(14, 18, 23)
	if a.ToggleMaximiseWindow() {
		t.Fatal("ToggleMaximiseWindow without a context should report false")
	}
	if a.IsWindowMaximised() {
		t.Fatal("IsWindowMaximised without a context should report false")
	}
	if a.forceClose.Load() {
		t.Fatal("CloseWindow without a context must not arm the confirmed-close bypass")
	}
}

// The close gate has three states, each load-bearing: before domReady there is
// no renderer to consult (and nothing to lose), so close proceeds; after
// domReady every close is routed through the renderer's unsaved-work check;
// and CloseWindow's confirmed quit must not be re-gated — Wails' Quit consults
// OnBeforeClose too, so without the force flag the app could never exit.
func TestBeforeCloseGateStates(t *testing.T) {
	a := NewApp()

	if a.beforeClose(context.Background()) {
		t.Fatal("close before domReady should proceed: there is no renderer to ask")
	}

	a.frontendReady.Store(true)
	if !a.beforeClose(context.Background()) {
		t.Fatal("close after domReady should be blocked pending the renderer's unsaved-work check")
	}

	a.forceClose.Store(true)
	if a.beforeClose(context.Background()) {
		t.Fatal("a confirmed quit must not be blocked again")
	}
}

func TestOnlyTheWorkbenchCanClaimAQuickConnection(t *testing.T) {
	a := NewApp()
	main := &application.WebviewWindow{}
	child := &application.WebviewWindow{}
	a.ctx.Set(desktop.WithWindow(context.Background(), main))
	mainCtx := context.WithValue(context.Background(), application.WindowKey, main)
	childCtx := context.WithValue(context.Background(), application.WindowKey, child)
	req := &quickWindowRequest{id: "once", profile: &types.Profile{Host: "example.test"}, claimed: make(chan struct{}), result: make(chan string, 1)}
	a.quickRequest = req
	if _, err := a.TakeQuickConnection(childCtx, req.id); err == nil {
		t.Fatal("another renderer claimed the connection")
	}
	if _, err := a.TakeQuickConnection(mainCtx, "old"); err == nil {
		t.Fatal("an old request claimed the connection")
	}
	profile, err := a.TakeQuickConnection(mainCtx, req.id)
	if err != nil || profile.Host != "example.test" {
		t.Fatalf("claim failed: %v", err)
	}
	if _, err := a.TakeQuickConnection(mainCtx, req.id); err == nil {
		t.Fatal("request was claimed twice")
	}

	a.FinishQuickConnection(childCtx, req.id, "unexpected")
	a.FinishQuickConnection(mainCtx, req.id, "done")
	select {
	case got := <-req.result:
		if got != "done" {
			t.Fatalf("wrong completion: %q", got)
		}
	default:
		t.Fatal("no completion")
	}
}

func TestOtherWindowsCannotReadOrResolveApproval(t *testing.T) {
	app := NewApp()
	id, result := app.approvalPanel.register(cliApprovalPanelRequest{Items: []cliApprovalItem{{ID: "one"}}})
	ctx := context.WithValue(context.Background(), application.WindowKey, &application.WebviewWindow{})
	if _, err := app.GetWindowApproval(ctx); err == nil {
		t.Fatal("another window read the approval")
	}
	if err := app.ResolveCliApproval(ctx, id, []string{"one"}); err == nil {
		t.Fatal("another window answered the approval")
	}
	select {
	case <-result:
		t.Fatal("an unauthorized decision was delivered")
	default:
	}
}
