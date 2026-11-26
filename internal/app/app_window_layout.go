package app

import (
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"gxShell/backend/config"
	"gxShell/internal/desktop"
)

type windowLayout struct {
	mu    sync.Mutex
	saved map[string]config.WindowPlacement
	timer *time.Timer
	dirty bool
}

// Session IDs, document paths and draft IDs never become persistent keys.
func layoutKey(name string) string {
	parts := strings.SplitN(name, "-", 3)
	if parts[0] == "connection" && len(parts) >= 2 {
		return "connection-" + parts[1]
	}
	return parts[0]
}

func restoredBounds(saved config.WindowPlacement, screens []*application.Screen, minW, minH int) (application.Rect, bool) {
	if saved.Width <= 0 || saved.Height <= 0 {
		return application.Rect{}, false
	}
	var screen, primary, byID *application.Screen
	for _, s := range screens {
		if s == nil || s.WorkArea.Width <= 0 || s.WorkArea.Height <= 0 {
			continue
		}
		if primary == nil || s.IsPrimary {
			primary = s
		}
		if s.ID == saved.ScreenID {
			byID = s
		}
		if saved.ScreenName != "" && s.Name == saved.ScreenName {
			screen = s
			if s.ID == saved.ScreenID {
				break
			}
		}
	}
	if screen == nil && saved.ScreenName == "" {
		screen = byID
	}
	if screen == nil {
		screen = primary
	}
	if screen == nil {
		return application.Rect{}, false
	}
	work := screen.WorkArea
	width := min(work.Width, max(minW, saved.Width))
	height := min(work.Height, max(minH, saved.Height))
	return application.Rect{X: work.X + min(max(0, saved.X), work.Width-width), Y: work.Y + min(max(0, saved.Y), work.Height-height), Width: width, Height: height}, true
}

// Only move a live window when the user can no longer reach its title bar.
// This preserves intentional placements spanning two connected screens.
func recoverWindow(win application.Window, screens []*application.Screen) {
	if !win.IsVisible() || win.IsMinimised() || win.IsMaximised() || win.IsFullscreen() {
		return
	}
	r := win.Bounds()
	if r.Width <= 0 || r.Height <= 0 || titleBarReachable(r, screens) {
		return
	}
	size := config.WindowPlacement{Width: r.Width, Height: r.Height}
	if bounds, ok := restoredBounds(size, screens, 1, 1); ok {
		win.SetBounds(bounds)
	}
}

func titleBarReachable(r application.Rect, screens []*application.Screen) bool {
	for _, s := range screens {
		if s == nil {
			continue
		}
		w := s.WorkArea
		width := min(r.X+r.Width, w.X+w.Width) - max(r.X, w.X)
		height := min(r.Y+32, w.Y+w.Height) - max(r.Y, w.Y)
		if width >= min(48, r.Width) && height >= 12 {
			return true
		}
	}
	return false
}

// Wails updates its screen cache after the Windows message interceptor runs.
// Coalesce broadcasts and inspect the refreshed work areas on the UI thread.
func DisplayChangeOptions() application.WindowsOptions {
	const wmDisplayChange, wmSettingChange, spiSetWorkArea = 0x007e, 0x001a, 0x002f
	var pending atomic.Bool
	return application.WindowsOptions{WndProcInterceptor: func(_ uintptr, msg uint32, wParam, _ uintptr) (uintptr, bool) {
		if (msg == wmDisplayChange || (msg == wmSettingChange && wParam == spiSetWorkArea)) && pending.CompareAndSwap(false, true) {
			time.AfterFunc(200*time.Millisecond, func() {
				application.InvokeAsync(func() {
					pending.Store(false)
					host := application.Get()
					screens := host.Screen.GetAll()
					for _, win := range host.Window.GetAll() {
						recoverWindow(win, screens)
					}
				})
			})
		}
		return 0, false
	}}
}

func (a *App) rememberPlacement(key string, value config.WindowPlacement) {
	l := &a.layout
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.saved == nil {
		l.saved = map[string]config.WindowPlacement{}
	}
	if l.saved[key] == value {
		return
	}
	l.saved[key] = value
	l.dirty = true
	if l.timer == nil {
		l.timer = time.AfterFunc(400*time.Millisecond, a.flushWindowLayout)
	} else {
		l.timer.Reset(400 * time.Millisecond)
	}
}

func (a *App) flushWindowLayout() {
	l := &a.layout
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.dirty || a.store == nil {
		return
	}
	if err := a.store.SaveWindowLayout(l.saved); err != nil {
		if a.log != nil {
			a.log.ErrorFields("Could not save window layout", LogFields{"error": err.Error()})
		}
		return
	}
	l.dirty = false
}

// Each native window owns its normal rectangle even when several views share
// the same kind. A maximised or minimised rectangle must never replace it.
func (a *App) trackWindowLayout(win *application.WebviewWindow, minW, minH int) {
	key := layoutKey(win.Name())
	ready := false
	var normal config.WindowPlacement
	readNormal := func() bool {
		r := win.Bounds()
		s, err := win.GetScreen()
		if err != nil || s == nil || r.Width <= 0 || r.Height <= 0 {
			return false
		}
		normal = config.WindowPlacement{ScreenID: s.ID, ScreenName: s.Name, X: r.X - s.WorkArea.X, Y: r.Y - s.WorkArea.Y, Width: r.Width, Height: r.Height}
		return true
	}
	capture := func() {
		if !ready || !win.IsVisible() || win.IsMinimised() || win.IsFullscreen() {
			return
		}
		if win.IsMaximised() {
			if normal.Width > 0 {
				saved := normal
				saved.Maximised = true
				a.rememberPlacement(key, saved)
			}
			return
		}
		if readNormal() {
			a.rememberPlacement(key, normal)
		}
	}
	initialize := func(*application.WindowEvent) {
		application.InvokeSync(func() {
			if ready || win.Bounds().Width <= 0 {
				return
			}
			a.layout.mu.Lock()
			saved := a.layout.saved[key]
			a.layout.mu.Unlock()
			if bounds, ok := restoredBounds(saved, application.Get().Screen.GetAll(), minW, minH); ok {
				win.SetMinSize(min(minW, bounds.Width), min(minH, bounds.Height))
				win.SetBounds(bounds)
				if saved.Maximised {
					readNormal()
					win.Maximise()
				}
			}
			ready = true
			capture()
		})
	}
	win.OnWindowEvent(events.Common.WindowRuntimeReady, initialize)
	if key != "main" {
		initialize(nil)
	}
	save := func(*application.WindowEvent) { application.InvokeSync(capture) }
	win.OnWindowEvent(events.Common.WindowDidMove, save)
	win.OnWindowEvent(events.Common.WindowDidResize, save)
	win.OnWindowEvent(events.Common.WindowShow, save)
	win.OnWindowEvent(events.Common.WindowMaximise, save)
	win.OnWindowEvent(events.Common.WindowRestore, save)
	win.OnWindowEvent(events.Common.WindowFocus, func(*application.WindowEvent) {
		application.InvokeSync(func() {
			if ready {
				recoverWindow(win, application.Get().Screen.GetAll())
			}
		})
	})
	win.RegisterHook(events.Common.WindowClosing, save)
}

func (a *App) windowZoom() float64 {
	if a.store != nil {
		if settings, err := a.store.GetSettings(); err == nil {
			return float64(settings.UIScale) / 100
		}
	}
	return 1
}

func (a *App) applyWindowZoom(percent int) {
	if desktop.MainWindow(a.ctx.Get()) == nil {
		return
	}
	application.InvokeSync(func() {
		for _, w := range application.Get().Window.GetAll() {
			w.SetZoom(float64(percent) / 100)
		}
	})
}
