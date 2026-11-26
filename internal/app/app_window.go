package app

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/url"
	"path"
	"strings"

	"gxShell/backend/types"
	runtime "gxShell/internal/desktop"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

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

// requestFrontendClose routes a close intent through the renderer so unsaved
// work can be confirmed there. Every close path must pass the same gate, or
// the confirmation would only protect the top-bar button and Alt+F4 would
// bypass it.
func (a *App) requestFrontendClose() {
	ctx := a.ctx.Get()
	if ctx == nil {
		return
	}
	a.windowMu.Lock()
	hasEditors := false
	for _, view := range a.viewWindows {
		if view.form {
			hasEditors = true
			break
		}
	}
	a.windowMu.Unlock()
	runtime.EventsEmit(ctx, "app:close-requested", hasEditors)
}

// RequestCloseWindow asks the renderer to close. The frontend checks unsaved
// documents, dirty settings, and open editors, confirms with the user when
// needed, and finishes with CloseWindow. The top-bar close button calls this
// rather than quitting directly.
func (a *App) RequestCloseWindow() {
	if !a.hideMainWithViews() {
		a.requestFrontendClose()
	}
}

// CloseWindow finishes a confirmed application exit. Detached windows close
// with the application after the workbench has checked for unsaved work.
func (a *App) CloseWindow() {
	ctx := a.ctx.Get()
	if ctx == nil {
		return
	}
	a.forceClose.Store(true)
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

// The workbench owns the shared workspace state. Keep it alive while an
// independent view is open, and restore it when the last view closes.
func (a *App) hideMainWithViews() bool {
	main := runtime.MainWindow(a.ctx.Get())
	if main == nil {
		return false
	}
	a.windowMu.Lock()
	hide := len(a.viewWindows) > 0
	if hide {
		a.restoreMainAfterViews = true
		main.Hide()
	}
	a.windowMu.Unlock()
	return hide
}

func (a *App) OpenTerminalWindow(id, title string) error {
	return a.openSessionView("terminal", id, title)
}

func (a *App) OpenSessionPanel(kind, id, title string) error {
	if kind != "sftp" && kind != "monitor" && kind != "transfers" {
		return errors.New("unknown session panel")
	}
	return a.openSessionView(kind, id, title)
}

// Only the session identifier enters the URL. Each view has an independent
// native frame; opening the same view twice focuses the existing window.
func (a *App) openSessionView(kind, id, title string) error {
	if runtime.MainWindow(a.ctx.Get()) == nil {
		return errors.New("desktop unavailable")
	}
	backend, err := a.terminalBackend(id)
	if err != nil {
		return err
	}
	if _, err = backend.Get(id); err != nil {
		return err
	}
	return a.openView(application.WebviewWindowOptions{
		Name: kind + "-" + id, Title: "gxShell · " + strings.TrimSpace(title),
		URL: "/?" + kind + "=" + url.QueryEscape(id), Width: 840, Height: 560, MinWidth: 320, MinHeight: 200,
	}, false)
}

type desktopView struct {
	window     *application.WebviewWindow
	form       bool
	guardClose bool
}

func (a *App) OpenConnectionWindow(kind, id, title string) error {
	if runtime.MainWindow(a.ctx.Get()) == nil {
		return errors.New("desktop unavailable")
	}
	key := "connection-" + kind
	params := url.Values{"connection": {kind}}
	width, height := 680, 730
	switch kind {
	case "new":
		key += "-" + types.NewID("draft")
	case "edit":
		if _, err := a.GetProfile(id); err != nil {
			return err
		}
		key += "-" + id
		params.Set("id", id)
	case "quick":
		width, height = 495, 400
	case "bulk":
	default:
		return errors.New("unknown connection form")
	}
	return a.openView(application.WebviewWindowOptions{
		Name: key, Title: "gxShell · " + title, URL: "/?" + params.Encode(),
		Width: width, Height: height, MinWidth: 390, MinHeight: 310,
	}, true)
}

func (a *App) openView(options application.WebviewWindowOptions, form bool) error {
	if runtime.MainWindow(a.ctx.Get()) == nil {
		return errors.New("desktop unavailable")
	}
	a.openViewMu.Lock()
	defer a.openViewMu.Unlock()
	key := options.Name
	a.windowMu.Lock()
	existing := a.viewWindows[key]
	a.windowMu.Unlock()
	if existing != nil {
		existing.window.Show()
		if existing.window.IsMinimised() {
			existing.window.UnMinimise()
		}
		existing.window.Focus()
		return nil
	}
	options.EnableFileDrop = strings.HasPrefix(key, "sftp-")
	options.Zoom = a.windowZoom()
	options.Hidden = true
	options.BackgroundColour = application.NewRGB(14, 18, 23)
	win := application.Get().Window.NewWithOptions(options)
	view := &desktopView{window: win, form: form}
	a.windowMu.Lock()
	if a.viewWindows == nil {
		a.viewWindows = make(map[string]*desktopView)
	}
	a.viewWindows[key] = view
	a.windowMu.Unlock()
	win.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		a.windowMu.Lock()
		if a.viewWindows[key] != view {
			a.windowMu.Unlock()
			return
		}
		if view.guardClose && !a.forceClose.Load() {
			e.Cancel()
			a.windowMu.Unlock()
			win.DispatchWailsEvent(&application.CustomEvent{Name: "connection:close-requested"})
			return
		}
		delete(a.viewWindows, key)
		restoreMain := len(a.viewWindows) == 0 && a.restoreMainAfterViews
		if restoreMain {
			a.restoreMainAfterViews = false
		}
		a.windowMu.Unlock()
		if id, ok := strings.CutPrefix(key, "approval-"); ok {
			a.approvalPanel.resolve(id, cliApprovalPanelResult{})
		}
		ctx := a.ctx.Get()
		if id, ok := strings.CutPrefix(key, "terminal-"); ok {
			runtime.EventsEmit(ctx, "terminal:window-closed", id)
		}
		if main := runtime.MainWindow(ctx); main != nil && restoreMain && !a.forceClose.Load() && !main.IsVisible() {
			main.Show()
			main.Focus()
		}
	})
	a.trackWindowLayout(win, options.MinWidth, options.MinHeight)
	if options.EnableFileDrop {
		a.watchFileDrops(win)
	}
	win.Show()
	win.Focus()
	return nil
}

// The editor handles native X and Alt+F4 after its discard listener is ready.
// During startup a window with no form mounted can always be closed.
func (a *App) RegisterConnectionWindow(ctx context.Context) {
	a.setFormCloseGuard(ctx, true)
}

func (a *App) CloseConnectionWindow(ctx context.Context) {
	if win := a.setFormCloseGuard(ctx, false); win != nil {
		win.Close()
	}
}

func (a *App) setFormCloseGuard(ctx context.Context, guarded bool) *application.WebviewWindow {
	win, _ := ctx.Value(application.WindowKey).(*application.WebviewWindow)
	if win == nil {
		return nil
	}
	a.windowMu.Lock()
	defer a.windowMu.Unlock()
	if view := a.viewWindows[win.Name()]; view != nil && view.window == win && view.form {
		view.guardClose = guarded
		return win
	}
	return nil
}

func (a *App) CloseTerminalWindow(id string) {
	a.windowMu.Lock()
	win := a.viewWindows["terminal-"+id]
	a.windowMu.Unlock()
	if win != nil {
		win.window.Close()
	}
}

func (a *App) DockTerminalWindow(ctx context.Context) {
	if w, ok := ctx.Value(application.WindowKey).(application.Window); ok && strings.HasPrefix(w.Name(), "terminal-") {
		ctxMain := a.ctx.Get()
		runtime.WindowShow(ctxMain)
		runtime.WindowUnminimise(ctxMain)
		w.Close()
	}
}

// OpenPanelDocument obtains the session from the SFTP window that owns it.
func (a *App) OpenPanelDocument(ctx context.Context, remotePath string) error {
	w := callerWindow(ctx)
	if w == nil || !strings.HasPrefix(w.Name(), "sftp-") {
		return errors.New("file window required")
	}
	return a.OpenRemoteDocumentWindow(strings.TrimPrefix(w.Name(), "sftp-"), remotePath)
}

func (a *App) OpenRemoteDocumentWindow(id, remotePath string) error {
	remotePath = cleanRemoteMarkdownPath(remotePath)
	if !isRemoteSupportedDocumentPath(remotePath) {
		return errors.New("unsupported remote document")
	}
	info, err := a.ssh.Get(id)
	if err != nil {
		return err
	}
	key := fmt.Sprintf("document-%x", sha256.Sum256([]byte(id+"\x00"+remotePath)))
	params := url.Values{"document": {id}, "path": {remotePath}, "profile": {info.ProfileID}}
	err = a.openView(application.WebviewWindowOptions{
		Name: key, Title: path.Base(remotePath) + " · " + info.Name + " · gxShell", URL: "/?" + params.Encode(),
		Width: 920, Height: 680, MinWidth: 400, MinHeight: 320,
	}, true)
	if err == nil {
		if main := runtime.MainWindow(a.ctx.Get()); main != nil {
			main.DispatchWailsEvent(&application.CustomEvent{Name: "workspace:remote-opened", Data: map[string]string{"id": id, "path": remotePath}})
		}
	}
	return err
}
