package app

import (
	"context"
	"errors"
	"strings"
	"time"

	"gxShell/backend/config"
	sshmanager "gxShell/backend/ssh"
	"gxShell/backend/types"
	"gxShell/internal/desktop"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// The workbench owns terminal tabs, including in-memory reconnect credentials.
// Send an opaque request ID to that window. Only it can claim the profile once.
type quickWindowRequest struct {
	id      string
	profile *types.Profile
	claimed chan struct{}
	result  chan string
}

func callerWindow(ctx context.Context) *application.WebviewWindow {
	w, _ := ctx.Value(application.WindowKey).(*application.WebviewWindow)
	return w
}

// TestProfileConnection uses draft credentials only. Only the selected saved jump
// profile can load a stored secret, for its own configured endpoint.
func (a *App) TestProfileConnection(ctx context.Context, profile types.Profile) error {
	win := callerWindow(ctx)
	if win == nil || !strings.HasPrefix(win.Name(), "connection-new-") || profile.ID != "" {
		return errors.New("new server window required")
	}
	profile.Host = strings.TrimSpace(profile.Host)
	profile.Username = strings.TrimSpace(profile.Username)
	if profile.Host == "" || profile.Username == "" {
		return errors.New("host and username are required")
	}
	if profile.Port < 1 || profile.Port > 65535 {
		return errors.New("port must be between 1 and 65535")
	}
	if profile.AuthType == types.AuthPrivateKey && strings.TrimSpace(profile.PrivateKeyPath) == "" {
		return errors.New("private key path is required")
	}
	jump, err := a.connectionJumpProfile(profile.ProxyJumpID)
	if err != nil {
		return err
	}
	rateKey := "quick:" + strings.ToLower(profile.Username+"@"+profile.Host)
	if err := a.rateLimiter.CheckAndRecord(rateKey); err != nil {
		return err
	}
	settings, err := a.store.GetSettings()
	if err != nil || settings.ConnectionTimeout <= 0 {
		settings.ConnectionTimeout = config.DefaultSettings().ConnectionTimeout
	}
	dialogCtx := desktop.CallerContext(ctx, a.ctx.Get())
	emit := func(event string, payload map[string]any) {
		win.DispatchWailsEvent(&application.CustomEvent{Name: "connection:" + event, Data: payload})
	}
	err = a.ssh.TestConnection(ctx, profile, jump, settings.ConnectionTimeout, sshmanager.AuthenticationPrompts{
		ConfirmHostKey:       func(host, key string) bool { return a.confirmHostKey(dialogCtx, host, key) },
		ConfirmHostKeyChange: func(host, oldKey, newKey string) bool { return a.confirmHostKeyChange(dialogCtx, host, oldKey, newKey) },
		KeyboardInteractive: func(id, name, instruction string, questions []string, echos []bool) ([]string, error) {
			return a.promptKeyboardInteractive(ctx, emit, map[string]any{"sessionId": id}, name, instruction, questions, echos)
		},
	})
	if err == nil {
		a.rateLimiter.Reset(rateKey)
	}
	return err
}

func (a *App) SubmitQuickConnection(ctx context.Context, profile types.Profile) error {
	main := desktop.MainWindow(a.ctx.Get())
	win := callerWindow(ctx)
	if main == nil || win == nil || win.Name() != "connection-quick" {
		return errors.New("quick connection window required")
	}
	req := &quickWindowRequest{id: types.NewID("request"), profile: &profile, claimed: make(chan struct{}), result: make(chan string, 1)}
	a.windowMu.Lock()
	if a.quickRequest != nil {
		a.windowMu.Unlock()
		return errors.New("connection already in progress")
	}
	a.quickRequest = req
	a.windowMu.Unlock()
	defer func() {
		a.windowMu.Lock()
		if a.quickRequest == req {
			a.quickRequest = nil
		}
		a.windowMu.Unlock()
	}()
	desktop.WindowShow(a.ctx.Get())
	desktop.WindowUnminimise(a.ctx.Get())
	main.DispatchWailsEvent(&application.CustomEvent{Name: "connection:submit", Data: req.id})
	select {
	case <-req.claimed:
	case <-time.After(15 * time.Second):
		// If the workbench claimed the request just as the timer fired,
		// wait for its result instead of offering a duplicate retry.
		a.windowMu.Lock()
		unclaimed := req.profile != nil
		if unclaimed {
			a.quickRequest = nil
		}
		a.windowMu.Unlock()
		if unclaimed {
			win.Focus()
			return errors.New("workbench did not receive the connection request")
		}
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case message := <-req.result:
		if message != "" {
			win.Focus()
			return errors.New(message)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (a *App) TakeQuickConnection(ctx context.Context, id string) (*types.Profile, error) {
	main := desktop.MainWindow(a.ctx.Get())
	a.windowMu.Lock()
	defer a.windowMu.Unlock()
	req := a.quickRequest
	if main == nil || callerWindow(ctx) != main || req == nil || req.id != id || req.profile == nil {
		return nil, errors.New("connection request unavailable")
	}
	profile := req.profile
	req.profile = nil
	close(req.claimed)
	return profile, nil
}

func (a *App) FinishQuickConnection(ctx context.Context, id, message string) {
	main := desktop.MainWindow(a.ctx.Get())
	a.windowMu.Lock()
	defer a.windowMu.Unlock()
	if req := a.quickRequest; main != nil && callerWindow(ctx) == main && req != nil && req.id == id && req.profile == nil {
		select {
		case req.result <- message:
		default:
		}
	}
}
