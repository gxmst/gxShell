package app

// Interactive-authentication bridge between the SSH layer and the frontend:
// keyboard-interactive (2FA/OTP) prompts raised mid-handshake, the
// host-key-changed decision dialog, and the known-hosts management bindings
// used by the settings panel.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"maps"
	"strings"
	"sync"
	"time"

	sshmanager "gxShell/backend/ssh"

	runtime "gxShell/internal/desktop"
)

// kiPromptTimeout bounds how long a handshake waits for the user to answer an
// interactive prompt. Servers enforce their own LoginGraceTime (~2 minutes on
// OpenSSH), so waiting much longer only delays the inevitable failure.
const kiPromptTimeout = 3 * time.Minute

type kiAnswer struct {
	answers   []string
	cancelled bool
}

type kiRegistry struct {
	mu      sync.Mutex
	pending map[string]chan kiAnswer
}

func newKiRegistry() *kiRegistry {
	return &kiRegistry{pending: map[string]chan kiAnswer{}}
}

func (r *kiRegistry) register(id string) chan kiAnswer {
	ch := make(chan kiAnswer, 1)
	r.mu.Lock()
	r.pending[id] = ch
	r.mu.Unlock()
	return ch
}

func (r *kiRegistry) remove(id string) {
	r.mu.Lock()
	delete(r.pending, id)
	r.mu.Unlock()
}

func (r *kiRegistry) resolve(id string, answer kiAnswer) bool {
	r.mu.Lock()
	ch := r.pending[id]
	delete(r.pending, id)
	r.mu.Unlock()
	if ch == nil {
		return false
	}
	ch <- answer
	return true
}

// handleKeyboardInteractive is registered as the ssh.Manager prompt bridge. It
// pushes the server's questions to the frontend and blocks the handshake until
// the user answers, cancels, or the timeout expires.
func (a *App) handleKeyboardInteractive(sessionID, name, instruction string, questions []string, echos []bool) ([]string, error) {
	ctx := a.ctx.Get()
	if ctx == nil {
		return nil, errors.New("interactive authentication unavailable")
	}
	emit := func(event string, payload map[string]any) { runtime.EmitToWindow(ctx, "terminal:"+event, payload) }
	return a.promptKeyboardInteractive(ctx, emit, a.terminalEventEnvelope(sessionID), name, instruction, questions, echos)
}

func (a *App) promptKeyboardInteractive(ctx context.Context, emit func(string, map[string]any), payload map[string]any, name, instruction string, questions []string, echos []bool) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	requestID := newKiRequestID()
	ch := a.kiRequests.register(requestID)
	defer a.kiRequests.remove(requestID)
	payload["requestId"] = requestID
	closed := maps.Clone(payload)
	payload["name"] = name
	payload["instruction"] = instruction
	payload["prompts"] = questions
	payload["echos"] = echos
	emit("keyboard-interactive", payload)
	a.log.InfoFields("keyboard-interactive prompt raised", LogFields{
		"session": payload["sessionId"], "prompts": len(questions),
	})

	select {
	case answer := <-ch:
		if answer.cancelled {
			return nil, errors.New("authentication cancelled by user")
		}
		if len(answer.answers) != len(questions) {
			return nil, fmt.Errorf("expected %d answers, got %d", len(questions), len(answer.answers))
		}
		return answer.answers, nil
	case <-time.After(kiPromptTimeout):
		emit("keyboard-interactive:closed", closed)
		return nil, errors.New("interactive authentication prompt timed out")
	case <-ctx.Done():
		emit("keyboard-interactive:closed", closed)
		return nil, ctx.Err()
	}
}

// AnswerKeyboardInteractive delivers the user's answers for a pending
// keyboard-interactive prompt. cancelled=true aborts the authentication.
func (a *App) AnswerKeyboardInteractive(requestID string, answers []string, cancelled bool) error {
	if answers == nil {
		answers = []string{}
	}
	if !a.kiRequests.resolve(requestID, kiAnswer{answers: answers, cancelled: cancelled}) {
		return errors.New("no pending authentication prompt for this request")
	}
	return nil
}

func (a *App) confirmHostKey(ctx context.Context, host, fingerprint string) bool {
	a.nativeDialogMu.Lock()
	defer a.nativeDialogMu.Unlock()
	if ctx == nil || ctx.Err() != nil {
		return false
	}
	res, _ := runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
		Type:          runtime.QuestionDialog,
		Title:         "Unknown Host Key",
		Message:       fmt.Sprintf("The host key for %s is unknown.\nFingerprint: %s\n\nDo you want to trust this host and continue connecting?", host, fingerprint),
		DefaultButton: "No",
	})
	return res == "Yes"
}

// confirmHostKeyChange shows the native host-key-changed dialog. This is the
// most security-sensitive prompt in the app, so the wording is explicit about
// the interception possibility and defaults to rejecting.
func (a *App) confirmHostKeyChange(ctx context.Context, host, oldFingerprint, newFingerprint string) bool {
	a.nativeDialogMu.Lock()
	defer a.nativeDialogMu.Unlock()
	if ctx == nil || ctx.Err() != nil {
		return false
	}
	message := fmt.Sprintf(
		"WARNING: the host key for %s has CHANGED.\n\n"+
			"Previously trusted: %s\n"+
			"Server now presents: %s\n\n"+
			"This happens after a server reinstall or key rotation, but it can also mean the connection is being intercepted.\n\n"+
			"Trust the new key and update known_hosts?",
		host, oldFingerprint, newFingerprint)
	res, err := runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
		Type:          runtime.QuestionDialog,
		Title:         "Host Key Changed",
		Message:       truncate(message, 1200),
		DefaultButton: "No",
	})
	if err != nil {
		a.log.ErrorFields("host key change dialog failed", LogFields{"error": err.Error()})
		return false
	}
	accepted := res == "Yes"
	a.log.InfoFields("host key change decision", LogFields{
		"host": host, "accepted": accepted,
	})
	return accepted
}

// ListKnownHosts returns the trusted host keys for the settings panel.
func (a *App) ListKnownHosts() ([]sshmanager.KnownHostEntry, error) {
	return a.ssh.ListKnownHosts()
}

// RemoveKnownHost forgets a trusted host key; the next connection to that host
// goes through trust-on-first-use again.
func (a *App) RemoveKnownHost(hosts string, fingerprint string) error {
	if strings.TrimSpace(hosts) == "" || strings.TrimSpace(fingerprint) == "" {
		return errors.New("hosts and fingerprint are required")
	}
	err := a.ssh.RemoveKnownHost(hosts, fingerprint)
	if err == nil {
		a.log.InfoFields("known-hosts entry removed", LogFields{"hosts": hosts})
	}
	return err
}

func newKiRequestID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "ki-" + hex.EncodeToString(b)
}
