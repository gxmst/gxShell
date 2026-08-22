package app

import "github.com/wailsapp/wails/v2/pkg/runtime"

// Window chrome controls for the frameless top bar (AppTopBar.tsx). With
// Frameless enabled there is no native caption, so minimise / maximise /
// close and the drag surface are frontend concerns; these bound methods are
// the narrow bridge the webview gets. Everything here drives only this
// window — no window handle, position, or title input crosses the boundary.
//
// Methods read the context from a.ctx rather than declaring a context param:
// Wails would inject one either way, and the stored-context pattern is what
// the rest of the package uses after startup published it.

// MinimiseWindow minimises the main window.
func (a *App) MinimiseWindow() {
	ctx := a.ctx.Get()
	if ctx == nil {
		return
	}
	runtime.WindowMinimise(ctx)
}

// ToggleMaximiseWindow maximises or restores the main window and reports the
// resulting state so the caption button glyph can switch without a follow-up
// query. Double-clicking a top-bar drag region is the other caller; Wails
// deliberately does not treat a second click as a drag start, which is what
// leaves the double-click free for the platform's maximize convention.
func (a *App) ToggleMaximiseWindow() bool {
	ctx := a.ctx.Get()
	if ctx == nil {
		return false
	}
	runtime.WindowToggleMaximise(ctx)
	return runtime.WindowIsMaximised(ctx)
}

// IsWindowMaximised reports whether the main window is currently maximised.
// The frontend re-queries on window resize so state changes made outside the
// app (Win+Up, snap layouts) are reflected too.
func (a *App) IsWindowMaximised() bool {
	ctx := a.ctx.Get()
	if ctx == nil {
		return false
	}
	return runtime.WindowIsMaximised(ctx)
}

// CloseWindow quits the app. The runtime has no per-window close call, and
// Quit is exactly what the removed native caption close button did: the app
// is single-window, so quitting and closing coincide.
func (a *App) CloseWindow() {
	ctx := a.ctx.Get()
	if ctx == nil {
		return
	}
	runtime.Quit(ctx)
}

// SetWindowBackgroundColour syncs the native window background with the
// active theme's --bg. It is called on mount and on every theme switch: the
// window background is what shows through before the webview paints and at
// the edges during a resize, and no single hardcoded value can match six
// themes. Alpha mirrors the startup value in main.go — the window is opaque;
// the flag only keeps the channel uniform.
func (a *App) SetWindowBackgroundColour(r, g, b uint8) {
	ctx := a.ctx.Get()
	if ctx == nil {
		return
	}
	runtime.WindowSetBackgroundColour(ctx, r, g, b, 1)
}
