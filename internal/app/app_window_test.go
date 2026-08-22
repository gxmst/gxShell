package app

import "testing"

// The window-control bindings run before Wails publishes its context in tests
// (and, in the renderer, until the bindings inject). Every method must be a
// silent no-op there rather than a panic, and the state queries must fail
// closed to "not maximized" so the caption glyph stays on maximize.
func TestWindowControlsAreNoOpsWithoutContext(t *testing.T) {
	a := NewApp()

	a.MinimiseWindow()
	a.CloseWindow()
	a.SetWindowBackgroundColour(14, 18, 23)
	if a.ToggleMaximiseWindow() {
		t.Fatal("ToggleMaximiseWindow without a context should report false")
	}
	if a.IsWindowMaximised() {
		t.Fatal("IsWindowMaximised without a context should report false")
	}
}
