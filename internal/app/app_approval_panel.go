package app

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"gxShell/backend/types"

	runtime "gxShell/internal/desktop"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// The workbench enables approval windows when the desktop is ready. Each
// request then owns one native window, and the window pulls only its own items.
// Before desktop readiness callers may use their existing native confirmation.

// cliApprovalPanelTimeout bounds how long a panel may stay unanswered. It is a
// safety net for a renderer that is wedged without reloading — a reload denies
// pending panels immediately — so it is deliberately generous. Timing out
// DENIES; it never falls back to the native dialog.
const cliApprovalPanelTimeout = 10 * time.Minute

// cliApprovalItemTextLimit bounds one item's text. The item COUNT is not
// bounded on purpose: the panel scrolls, so hiding commands would hide exactly
// the ones the user needs to judge. Only a single pathological command is cut.
const cliApprovalItemTextLimit = 4000

// cliApprovalItemDetailLimit bounds the pre-formatted explanation carried
// alongside an item. It mirrors the native dialog's own command truncation.
const cliApprovalItemDetailLimit = 4000

// cliApprovalItem is one reviewable row. ID is stable for the lifetime of the
// request so the renderer can report a subset back; anything it does not name
// is denied.
type cliApprovalItem struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	// Text is the raw command, path or description. Risk spans are indexed
	// against it, so the renderer can highlight the tokens that drove the tier.
	Text string `json:"text"`
	// Detail is the formatted explanation the native dialog used to show. The
	// panel renders the structured fields instead, and the fallback dialog
	// prints this verbatim, so moving to the panel loses no context.
	Detail    string     `json:"detail,omitempty"`
	RiskTier  string     `json:"riskTier,omitempty"`
	RiskLabel string     `json:"riskLabel,omitempty"`
	RiskLines []string   `json:"riskLines,omitempty"`
	Spans     []riskSpan `json:"spans,omitempty"`
	Note      string     `json:"note,omitempty"`
}

// nativeText renders the item for the native fallback dialog, which has no
// structure to work with. Detail is preferred because it already carries the
// formatted explanation; otherwise the raw text stands alone.
func (item cliApprovalItem) nativeText() string {
	if strings.TrimSpace(item.Detail) != "" {
		return item.Detail
	}
	return item.Text
}

// cliApprovalPanelRequest holds the items a review window reads through GetWindowApproval.
type cliApprovalPanelRequest struct {
	ID       string            `json:"id"`
	Source   string            `json:"source"`
	Server   string            `json:"server"`
	Summary  string            `json:"summary"`
	Critical bool              `json:"critical"`
	Items    []cliApprovalItem `json:"items"`
}

// cliApprovalPanelResult is what the renderer returns through ResolveCliApproval.
type cliApprovalPanelResult struct {
	Approved []string
}

// mask maps the approved item ids onto the caller's index order. Ids the
// renderer did not name — including ids it invented — stay denied.
func (r cliApprovalPanelResult) mask(items []cliApprovalItem) []bool {
	approved := make(map[string]bool, len(r.Approved))
	for _, id := range r.Approved {
		if id != "" {
			approved[id] = true
		}
	}
	out := make([]bool, len(items))
	for i, item := range items {
		out[i] = approved[item.ID]
	}
	return out
}

// cliApprovalPanelRegistry tracks the panels awaiting an answer. A resolved or
// discarded id is removed immediately, so a stale renderer replaying an old id
// cannot approve anything.
type cliApprovalPanelRegistry struct {
	mu      sync.Mutex
	pending map[string]pendingApproval
}

type pendingApproval struct {
	request cliApprovalPanelRequest
	result  chan cliApprovalPanelResult
}

func newCliApprovalPanelRegistry() *cliApprovalPanelRegistry {
	return &cliApprovalPanelRegistry{pending: map[string]pendingApproval{}}
}

func (r *cliApprovalPanelRegistry) register(req cliApprovalPanelRequest) (string, chan cliApprovalPanelResult) {
	r.mu.Lock()
	defer r.mu.Unlock()
	id := types.NewID("panel")
	// Buffer of one so a resolve that races with a cancellation never blocks
	// the renderer's binding call.
	ch := make(chan cliApprovalPanelResult, 1)
	req.ID = id
	r.pending[id] = pendingApproval{request: req, result: ch}
	return id, ch
}

func (r *cliApprovalPanelRegistry) resolve(id string, result cliApprovalPanelResult) bool {
	r.mu.Lock()
	panel, ok := r.pending[id]
	if ok {
		delete(r.pending, id)
	}
	r.mu.Unlock()
	if !ok {
		return false
	}
	panel.result <- result
	close(panel.result)
	return true
}

func (r *cliApprovalPanelRegistry) discard(id string) {
	r.mu.Lock()
	delete(r.pending, id)
	r.mu.Unlock()
}

// denyAll resolves every pending panel as a denial.
//
// Used when the renderer re-registers: a fresh page means any panel still
// pending belongs to a page that no longer exists, so the user will never see
// it. Denying is the only safe reading — an unanswered panel must never become
// an approval.
func (r *cliApprovalPanelRegistry) denyAll() {
	r.mu.Lock()
	pending := r.pending
	r.pending = map[string]pendingApproval{}
	r.mu.Unlock()
	for _, panel := range pending {
		// Buffered, so this never blocks on a caller that already gave up.
		panel.result <- cliApprovalPanelResult{}
		close(panel.result)
	}
}

func (r *cliApprovalPanelRegistry) len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.pending)
}

// approvalPanelAvailable reports whether the renderer can serve a panel right
// now. A renderer that has not signalled readiness falls back to the native
// dialog rather than showing nothing.
func (a *App) approvalPanelAvailable() bool {
	return a.ctx.Get() != nil && a.frontendReady.Load()
}

// requestCliApprovalPanel opens the review window and blocks until the renderer
// answers. Panels are serialised, so at most one is on screen at a time.
//
// ok distinguishes "the panel decided" from "the panel could not be used":
//
//   - ok == false means the renderer is not serving panels right now (not
//     registered, or nothing to review). The caller must fall back to the
//     native dialog, so a missing renderer degrades to a prompt rather than to
//     an implicit approval.
//   - ok == true means the result is authoritative, and an empty Approved list
//     is a real denial — the user denied, the caller disconnected, the renderer
//     reloaded, or the panel sat unanswered past its timeout.
//
// Once the panel is in use there is deliberately NO fallback to the native
// dialog: that dialog is the thing this panel replaced, and a batch too long to
// read is exactly what it cannot show.
func (a *App) requestCliApprovalPanel(ctx context.Context, req cliApprovalPanelRequest) (cliApprovalPanelResult, bool) {
	if ctx != nil && ctx.Err() != nil {
		return cliApprovalPanelResult{}, true
	}
	if !a.approvalPanelAvailable() || len(req.Items) == 0 {
		return cliApprovalPanelResult{}, false
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if !a.acquireApprovalGate(ctx) {
		// The caller went away while another panel was up. Deny rather than
		// queue a prompt for a request nobody is waiting for.
		return cliApprovalPanelResult{}, true
	}
	defer a.releaseApprovalGate()
	if ctx.Err() != nil {
		return cliApprovalPanelResult{}, true
	}

	panelID, ch := a.approvalPanel.register(req)
	req.ID = panelID

	if a.cliApprovalPanelFn != nil {
		a.cliApprovalPanelFn(req)
	} else {
		title := "Approval"
		if a.store != nil {
			if settings, err := a.store.GetSettings(); err == nil && settings.Language == "zh-CN" {
				title = "审批"
			}
		}
		err := a.openView(application.WebviewWindowOptions{
			Name: "approval-" + panelID, Title: "gxShell · " + title, URL: "/?approval=1",
			Width: 680, Height: 510, MinWidth: 380, MinHeight: 300, AlwaysOnTop: true,
		}, false)
		if err != nil {
			a.approvalPanel.discard(panelID)
			return cliApprovalPanelResult{}, true
		}
	}
	defer a.closeApprovalView(panelID)

	timeout := a.approvalPanelTimeout
	if timeout <= 0 {
		timeout = cliApprovalPanelTimeout
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case result := <-ch:
		if ctx.Err() != nil {
			return cliApprovalPanelResult{}, true
		}
		return result, true
	case <-ctx.Done():
		// The caller disconnected. Showing a native dialog now would prompt for
		// a request nobody is waiting for, so this resolves as a denial.
		a.approvalPanel.discard(panelID)
		return cliApprovalPanelResult{}, true
	case <-timer.C:
		// The renderer never answered. Deny: falling back to the native dialog
		// would hand the user the very prompt this panel exists to replace.
		a.approvalPanel.discard(panelID)
		if a.log != nil {
			a.log.ErrorFields("Approval panel timed out; the request was denied",
				LogFields{"panel": panelID, "items": fmt.Sprintf("%d", len(req.Items))})
		}
		return cliApprovalPanelResult{}, true
	}
}

// acquireApprovalGate takes the single panel slot, waiting for it to free up.
//
// The gate is a buffered channel rather than a mutex because acquiring it has
// to be interruptible: a caller that disconnects while queued must not hold a
// place, and must not be left blocking on a panel that will never be shown to
// it.
func (a *App) acquireApprovalGate(ctx context.Context) bool {
	select {
	case a.approvalGate <- struct{}{}:
		return true
	case <-ctx.Done():
		return false
	}
}

func (a *App) releaseApprovalGate() {
	select {
	case <-a.approvalGate:
	default:
		// Unbalanced release; nothing is holding the gate.
	}
}

// liveRequestsContext returns a context that is cancelled once every caller in
// the batch has gone away.
//
// The panel must stay open while at least one caller is still waiting, so one
// disconnect cannot deny another caller's request; and it must come down once
// nobody is waiting, so the user is never asked to review a dead request.
func liveRequestsContext(callers []context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	var live []context.Context
	hasCallers := false
	for _, caller := range callers {
		if caller != nil {
			hasCallers = true
			if caller.Err() == nil {
				live = append(live, caller)
			}
		}
	}
	if len(live) == 0 {
		if hasCallers {
			cancel()
		}
		// A genuinely context-free request waits for the user or timeout.
		return ctx, cancel
	}
	gone := make(chan struct{}, len(live))
	for _, caller := range live {
		go func(c context.Context) {
			select {
			case <-c.Done():
				gone <- struct{}{}
			case <-ctx.Done():
			}
		}(caller)
	}
	go func() {
		for range live {
			select {
			case <-gone:
			case <-ctx.Done():
				return
			}
		}
		cancel()
	}()
	return ctx, cancel
}

// ResolveCliApproval is called by the approval panel with the items the user
// accepted. An empty list denies the whole request. Unknown or already-resolved
// ids are ignored so a stale renderer cannot approve anything.
func (a *App) ResolveCliApproval(ctx context.Context, requestID string, approvedItemIDs []string) error {
	win := callerWindow(ctx)
	if win == nil || win.Name() != "approval-"+requestID {
		return fmt.Errorf("this window does not own the approval request")
	}
	return a.resolveCliApproval(requestID, approvedItemIDs)
}

func (a *App) GetWindowApproval(ctx context.Context) (*cliApprovalPanelRequest, error) {
	win := callerWindow(ctx)
	if win == nil {
		return nil, fmt.Errorf("approval window required")
	}
	id, ok := strings.CutPrefix(win.Name(), "approval-")
	if !ok {
		return nil, fmt.Errorf("approval window required")
	}
	a.approvalPanel.mu.Lock()
	defer a.approvalPanel.mu.Unlock()
	panel, ok := a.approvalPanel.pending[id]
	if !ok {
		return nil, fmt.Errorf("approval request has ended")
	}
	return &panel.request, nil
}

func (a *App) resolveCliApproval(requestID string, approvedItemIDs []string) error {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return fmt.Errorf("approval request id is required")
	}
	// Already answered, cancelled or timed out. Not an error: the renderer may
	// legitimately race with a caller disconnect.
	a.approvalPanel.resolve(requestID, cliApprovalPanelResult{Approved: approvedItemIDs})
	return nil
}

// RegisterApprovalPanel marks the workbench ready to open independent approval windows.
func (a *App) RegisterApprovalPanel(ctx context.Context) error {
	if main := runtime.MainWindow(a.ctx.Get()); main == nil || callerWindow(ctx) != main {
		return fmt.Errorf("workbench required")
	}
	return a.registerApprovalPanel()
}

func (a *App) registerApprovalPanel() error {
	// A fresh workbench starts a new review generation. Retire old requests
	// before enabling presentation for the first time.
	a.approvalPanel.denyAll()
	a.frontendReady.Store(true)
	return nil
}

func (a *App) closeApprovalView(id string) {
	if a.cliApprovalPanelClosedFn != nil {
		a.cliApprovalPanelClosedFn(id)
		return
	}
	a.windowMu.Lock()
	view := a.viewWindows["approval-"+id]
	a.windowMu.Unlock()
	if view != nil {
		view.window.Close()
	}
}
