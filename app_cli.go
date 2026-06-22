package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gxShell/backend/logger"
	"gxShell/backend/types"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	cliAddress        = "127.0.0.1:56789"
	cliTokenFilename  = "cli_token"
	cliMaxRequestSize = 2 * 1024 * 1024
	cliCommandTimeout = 30 * time.Second
	cliMaxTimeout     = 30 * time.Minute
	cliOutputLimit    = 1024 * 1024
	cliApprovalDelay  = time.Second
)

// startCliServer starts an authenticated localhost HTTP server for CLI access.
// Profiles must opt in with CliEnabled before the CLI can see or execute them.
func (a *App) startCliServer() {
	token, err := loadOrCreateCliToken(a.store.DataDir())
	if err != nil {
		a.log.ErrorFields("CLI server token setup failed", logger.LogFields{"error": err.Error()})
		return
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/cli/exec", a.requireCliAuth(token, a.handleCliExec))
	mux.HandleFunc("/cli/list", a.requireCliAuth(token, a.handleCliList))
	mux.HandleFunc("/cli/status", a.requireCliAuth(token, a.handleCliStatus))
	mux.HandleFunc("/cli/ping", a.handleCliPing)

	server := &http.Server{
		Addr:              cliAddress,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      cliMaxTimeout + time.Minute,
		IdleTimeout:       60 * time.Second,
	}
	a.cliServer = server

	a.log.Info("CLI server listening on " + cliAddress)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		a.log.ErrorFields("CLI server failed", logger.LogFields{"error": err.Error()})
	}
}

func (a *App) requireCliAuth(token string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isAuthorizedCliRequest(r, token) {
			writeCliError(w, http.StatusUnauthorized, "auth", "unauthorized CLI request")
			return
		}
		next(w, r)
	}
}

func (a *App) handleCliExec(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeCliError(w, http.StatusMethodNotAllowed, "validation", "method not allowed")
		return
	}

	var req struct {
		Server    string `json:"server"`
		Command   string `json:"command"`
		TimeoutMs int    `json:"timeoutMs,omitempty"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, cliMaxRequestSize))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeCliError(w, http.StatusBadRequest, "validation", "invalid request body: "+err.Error())
		return
	}
	req.Server = strings.TrimSpace(req.Server)
	req.Command = strings.TrimSpace(req.Command)
	if req.Server == "" || req.Command == "" {
		writeCliError(w, http.StatusBadRequest, "validation", "server and command are required")
		return
	}
	timeout := cliCommandTimeout
	if req.TimeoutMs > 0 {
		timeout = time.Duration(req.TimeoutMs) * time.Millisecond
		if timeout < time.Second {
			writeCliError(w, http.StatusBadRequest, "validation", "timeout must be at least 1 second")
			return
		}
		if timeout > cliMaxTimeout {
			writeCliError(w, http.StatusBadRequest, "validation", "timeout must be 30 minutes or less")
			return
		}
	}

	profile, err := a.findCliProfile(req.Server)
	if err != nil {
		writeCliJSON(w, http.StatusNotFound, map[string]any{"error": err.Error(), "errorKind": "daemon"})
		return
	}
	serverName := cliProfileName(profile)

	if reason, ok := guardCommand(req.Command, true, func() bool {
		return a.confirmCliExecution(serverName, req.Command)
	}); !ok {
		a.log.ErrorFields("CLI command blocked", logger.LogFields{
			"server":  serverName,
			"command": req.Command,
			"reason":  reason,
		})
		writeCliJSON(w, http.StatusForbidden, map[string]any{
			"alias":     serverName,
			"error":     "BLOCKED: " + reason,
			"errorKind": "blocked",
			"blocked":   true,
			"reason":    reason,
		})
		return
	}

	a.log.InfoFields("CLI executing command", logger.LogFields{
		"server":    serverName,
		"profileID": profile.ID,
		"command":   req.Command,
	})

	sessionID, reusedConnection, err := a.cliSessionForProfile(profile.ID)
	if err != nil {
		writeCliJSON(w, http.StatusBadGateway, map[string]any{
			"alias":     serverName,
			"error":     "failed to connect: " + err.Error(),
			"errorKind": "connect",
		})
		return
	}

	result, err := a.ssh.ExecuteCommandResult(sessionID, req.Command, timeout, cliOutputLimit)
	if err != nil {
		writeCliJSON(w, http.StatusBadGateway, map[string]any{
			"alias":            serverName,
			"reusedConnection": reusedConnection,
			"error":            err.Error(),
			"errorKind":        "ssh",
		})
		return
	}

	payload := map[string]any{
		"alias":            serverName,
		"reusedConnection": reusedConnection,
		"exitCode":         result.ExitCode,
		"stdout":           result.Stdout,
		"stderr":           result.Stderr,
		"output":           result.Output,
		"summary":          result.Summary,
		"displayOutput":    result.DisplayOutput(),
		"durationMs":       result.Duration.Milliseconds(),
		"timedOut":         result.TimedOut,
		"truncated":        result.Truncated,
	}
	status := http.StatusOK
	if result.TimedOut {
		payload["error"] = "remote command timeout"
		payload["errorKind"] = "remote"
		status = http.StatusGatewayTimeout
	} else if result.Error != "" {
		payload["error"] = result.Error
		payload["errorKind"] = "remote"
	}
	writeCliJSON(w, status, payload)
}

func (a *App) handleCliList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeCliError(w, http.StatusMethodNotAllowed, "validation", "method not allowed")
		return
	}

	profiles, err := a.store.ListProfiles()
	if err != nil {
		writeCliJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load profiles: " + err.Error()})
		return
	}

	servers := make([]map[string]string, 0, len(profiles))
	for _, profile := range profiles {
		if !profile.CliEnabled {
			continue
		}
		name := cliProfileName(profile)
		if name == "" {
			continue
		}
		servers = append(servers, map[string]string{"name": name})
	}
	writeCliJSON(w, http.StatusOK, map[string]any{"servers": servers, "count": len(servers)})
}

func (a *App) handleCliStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeCliError(w, http.StatusMethodNotAllowed, "validation", "method not allowed")
		return
	}

	profiles, err := a.store.ListProfiles()
	if err != nil {
		writeCliJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load profiles: " + err.Error()})
		return
	}
	allowedProfiles := make(map[string]string)
	for _, profile := range profiles {
		if !profile.CliEnabled {
			continue
		}
		name := cliProfileName(profile)
		if name != "" {
			allowedProfiles[profile.ID] = name
		}
	}

	active := make([]map[string]string, 0)
	for _, session := range a.ssh.List() {
		name, ok := allowedProfiles[session.ProfileID]
		if !ok || session.State != types.SessionConnected {
			continue
		}
		active = append(active, map[string]string{
			"name":  name,
			"state": string(session.State),
		})
	}
	writeCliJSON(w, http.StatusOK, map[string]any{"active": active, "count": len(active)})
}

func (a *App) handleCliPing(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeCliError(w, http.StatusMethodNotAllowed, "validation", "method not allowed")
		return
	}
	writeCliJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *App) findCliProfile(name string) (types.Profile, error) {
	profiles, err := a.store.ListProfiles()
	if err != nil {
		return types.Profile{}, fmt.Errorf("failed to load profiles: %w", err)
	}

	var match *types.Profile
	for i := range profiles {
		profile := profiles[i]
		if !profile.CliEnabled {
			continue
		}
		if !strings.EqualFold(cliProfileName(profile), name) {
			continue
		}
		if match != nil {
			return types.Profile{}, fmt.Errorf("server alias %q is ambiguous", name)
		}
		match = &profiles[i]
	}
	if match == nil {
		return types.Profile{}, fmt.Errorf("server %q is not available to CLI", name)
	}
	return *match, nil
}

// cliConnectCall represents an in-flight connection attempt for a profile.
// The leader stores its result in res and closes done; waiters block on done
// then read res, so every caller observes the same sessionID/error rather than
// a generic "no session" message.
type cliConnectCall struct {
	done chan struct{}
	res  cliConnectResult
}

type cliConnectResult struct {
	sessionID string
	reused    bool
	err       error
}

type cliApprovalRequest struct {
	serverName string
	command    string
	result     chan bool
}

type cliApprovalBatch struct {
	serverName string
	requests   []*cliApprovalRequest
}

func (a *App) cliSessionForProfile(profileID string) (string, bool, error) {
	// Fast path: reuse an existing connected session without holding cliMu.
	if sid := a.findCliSession(profileID); sid != "" {
		return sid, true, nil
	}

	// Deduplicate concurrent connection attempts for the same profile. The
	// leader registers a *cliConnectCall, performs Connect outside the lock,
	// stores the result, and closes done. Waiters block on done and read the
	// shared result, so they receive the real error (auth failure, network
	// timeout, etc.) instead of a generic message.
	a.cliMu.Lock()
	if call, ok := a.cliConnecting[profileID]; ok {
		a.cliMu.Unlock()
		<-call.done
		return call.res.sessionID, call.res.reused, call.res.err
	}
	call := &cliConnectCall{done: make(chan struct{})}
	a.cliConnecting[profileID] = call
	a.cliMu.Unlock()

	defer func() {
		a.cliMu.Lock()
		// Only delete the map entry if it still points at this call. A later
		// caller cannot have replaced it (the leader is the only one that
		// creates entries and it's still in flight), but the guard keeps the
		// invariant explicit.
		if cur, ok := a.cliConnecting[profileID]; ok && cur == call {
			delete(a.cliConnecting, profileID)
		}
		a.cliMu.Unlock()
		close(call.done)
	}()

	// Double-check after claiming the slot: another goroutine may have just
	// finished connecting.
	if sid := a.findCliSession(profileID); sid != "" {
		call.res = cliConnectResult{sessionID: sid, reused: true}
		return sid, true, nil
	}

	info, err := a.Connect(profileID, 120, 34)
	if err != nil {
		call.res = cliConnectResult{err: err}
		return "", false, err
	}
	call.res = cliConnectResult{sessionID: info.ID, reused: false}
	return info.ID, false, nil
}

// findCliSession returns the session ID of a connected SSH session for the
// given profile, or "" if none exists.
func (a *App) findCliSession(profileID string) string {
	for _, session := range a.ssh.List() {
		if session.ProfileID == profileID && session.State == types.SessionConnected {
			return session.ID
		}
	}
	return ""
}

func (a *App) confirmCliExecution(serverName, command string) bool {
	if a.ctx == nil {
		return false
	}
	req := &cliApprovalRequest{
		serverName: serverName,
		command:    command,
		result:     make(chan bool, 1),
	}
	key := strings.ToLower(serverName)
	a.cliApprovalMu.Lock()
	if a.cliApprovals == nil {
		a.cliApprovals = map[string]*cliApprovalBatch{}
	}
	batch := a.cliApprovals[key]
	if batch == nil {
		batch = &cliApprovalBatch{serverName: serverName}
		a.cliApprovals[key] = batch
		time.AfterFunc(cliApprovalDelay, func() {
			a.flushCliApprovalBatch(key)
		})
	}
	batch.requests = append(batch.requests, req)
	a.cliApprovalMu.Unlock()

	return <-req.result
}

func (a *App) flushCliApprovalBatch(key string) {
	a.cliApprovalMu.Lock()
	batch := a.cliApprovals[key]
	if batch == nil {
		a.cliApprovalMu.Unlock()
		return
	}
	delete(a.cliApprovals, key)
	requests := append([]*cliApprovalRequest(nil), batch.requests...)
	a.cliApprovalMu.Unlock()

	allowed := a.confirmCliExecutionBatch(batch.serverName, requests)
	for _, req := range requests {
		req.result <- allowed
		close(req.result)
	}
}

func (a *App) confirmCliExecutionBatch(serverName string, requests []*cliApprovalRequest) bool {
	if a.ctx == nil || len(requests) == 0 {
		return false
	}
	commands := make([]string, 0, len(requests))
	for _, req := range requests {
		commands = append(commands, req.command)
	}
	title := "CLI wants to run commands"
	buttons := []string{"Allow all", "Deny"}
	message := fmt.Sprintf("An external CLI request wants to run %d command(s) on %s:\n\n%s\n\nAllow all of these?", len(commands), serverName, formatApprovalList(commands))
	if len(commands) == 1 {
		title = "CLI wants to run a command"
		buttons = []string{"Allow", "Deny"}
		message = fmt.Sprintf("An external CLI request wants to run this command on %s:\n\n%s\n\nAllow this?", serverName, truncate(commands[0], 500))
	}
	a.nativeDialogMu.Lock()
	defer a.nativeDialogMu.Unlock()
	res, err := runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
		Type:          runtime.QuestionDialog,
		Title:         title,
		Message:       message,
		Buttons:       buttons,
		DefaultButton: "Deny",
		CancelButton:  "Deny",
	})
	if err != nil {
		a.log.ErrorFields("CLI confirm dialog failed", logger.LogFields{"error": err.Error()})
		return false
	}
	return res == "Allow all" || res == "Allow" || res == "Yes"
}

func cliProfileName(profile types.Profile) string {
	return strings.TrimSpace(profile.CliAlias)
}

func isAuthorizedCliRequest(r *http.Request, token string) bool {
	if token == "" {
		return false
	}
	provided := strings.TrimSpace(r.Header.Get("X-GxShell-CLI-Token"))
	if auth := strings.TrimSpace(r.Header.Get("Authorization")); auth != "" {
		parts := strings.SplitN(auth, " ", 2)
		if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
			provided = strings.TrimSpace(parts[1])
		}
	}
	if provided == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(token)) == 1
}

func loadOrCreateCliToken(dataDir string) (string, error) {
	path := filepath.Join(dataDir, cliTokenFilename)
	if raw, err := os.ReadFile(path); err == nil {
		if token := strings.TrimSpace(string(raw)); token != "" {
			return token, nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}

	token, err := newCliToken()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(token+"\n"), 0600); err != nil {
		return "", err
	}
	return token, nil
}

func newCliToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func writeCliJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeCliError(w http.ResponseWriter, status int, kind string, message string) {
	writeCliJSON(w, status, map[string]any{"error": message, "errorKind": kind})
}
