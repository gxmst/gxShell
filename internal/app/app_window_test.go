package app

import (
	"context"
	"testing"
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

	a.domReadyFired.Store(true)
	if !a.beforeClose(context.Background()) {
		t.Fatal("close after domReady should be blocked pending the renderer's unsaved-work check")
	}

	a.CloseWindow()
	if a.beforeClose(context.Background()) {
		t.Fatal("the confirmed quit from CloseWindow must not be blocked again")
	}
}
