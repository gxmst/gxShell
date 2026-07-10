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
	goruntime "runtime"
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
	cliCommandTimeout = 2 * time.Minute
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
		a.emitCliServerError("token setup failed: " + err.Error())
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
		a.emitCliServerError(err.Error())
	}
}

// emitCliServerError notifies the frontend that the local CLI HTTP server is
// unavailable (e.g. the port is already in use), so the user is not left
// assuming the external CLI works.
func (a *App) emitCliServerError(message string) {
	if a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, "cli:server-error", map[string]any{
		"address": cliAddress,
		"error":   message,
	})
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

	if block, ok := guardCommandReport(req.Command, true, func() bool {
		return a.confirmCliExecution(serverName, req.Command)
	}); !ok {
		fields := logger.CommandAuditFields(req.Command)
		fields["server"] = serverName
		fields["profileID"] = profile.ID
		fields["reason"] = block.Message()
		a.log.ErrorFields("CLI command blocked", fields)
		writeCliJSON(w, http.StatusForbidden, map[string]any{
			"alias":     serverName,
			"error":     "BLOCKED: " + block.Message(),
			"errorKind": "blocked",
			"blocked":   true,
			"blockedBy": block.Kind,
			"reason":    block.Reason,
			"detail":    block.Detail,
		})
		return
	}

	fields := logger.CommandAuditFields(req.Command)
	fields["server"] = serverName
	fields["profileID"] = profile.ID
	a.log.InfoFields("CLI executing command", fields)

	sessionID, reusedConnection, err := a.cliSessionForProfile(profile.ID)
	if err != nil {
		writeCliJSON(w, http.StatusBadGateway, map[string]any{
			"alias":     serverName,
			"error":     "failed to connect: " + err.Error(),
			"errorKind": "connect",
		})
		return
	}

	activityID := a.beginTerminalAutomation(sessionID, "cli", "execute_command", req.Command)
	result, err := a.ssh.ExecuteCommandResult(sessionID, req.Command, timeout, cliOutputLimit)
	if err != nil {
		a.finishTerminalAutomation(sessionID, activityID, "cli", "execute_command", "", err.Error(), 1, 0, false)
		writeCliJSON(w, http.StatusBadGateway, map[string]any{
			"alias":            serverName,
			"reusedConnection": reusedConnection,
			"error":            err.Error(),
			"errorKind":        "ssh",
		})
		return
	}
	automationError := result.Error
	if result.TimedOut && automationError == "" {
		automationError = "remote command timeout"
	}
	a.finishTerminalAutomation(sessionID, activityID, "cli", "execute_command", result.DisplayOutput(), automationError, result.ExitCode, result.Duration, result.Truncated)

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
		"timeoutMs":        int(timeout / time.Millisecond),
		"timedOut":         result.TimedOut,
		"truncated":        result.Truncated,
	}
	status := http.StatusOK
	if result.TimedOut {
		payload["error"] = "remote command timeout"
		payload["errorKind"] = "remote"
		payload["timeoutHint"] = cliTimeoutHint(timeout)
		status = http.StatusGatewayTimeout
	} else if result.Error != "" {
		payload["error"] = result.Error
		payload["errorKind"] = "remote"
	}
	writeCliJSON(w, status, payload)
}

func cliTimeoutHint(timeout time.Duration) string {
	return fmt.Sprintf("Command exceeded the %s remote timeout. The SSH exec channel was closed, but the remote command may have made partial changes or may still be running in the background. Check the remote service/process status before retrying, or rerun with --timeout 10m for expected long operations.", timeout.Round(time.Second))
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
		delay := a.cliApprovalDelay
		if delay <= 0 {
			delay = cliApprovalDelay
		}
		time.AfterFunc(delay, func() {
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

	commands := make([]string, 0, len(requests))
	for _, req := range requests {
		commands = append(commands, req.command)
	}
	confirmBatch := a.cliConfirmBatchFn
	if confirmBatch == nil {
		confirmBatch = a.confirmCliExecutionBatchNative
	}
	allowed := confirmBatch(batch.serverName, commands)
	for _, req := range requests {
		req.result <- allowed
		close(req.result)
	}
}

// confirmCliExecutionBatchNative shows the real native approval dialog for a
// batch of commands. It is the default confirmCliBatchFn; tests override that
// seam to exercise the batching logic without a renderer.
func (a *App) confirmCliExecutionBatchNative(serverName string, commands []string) bool {
	if a.ctx == nil || len(commands) == 0 {
		return false
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
		if !cliTokenFilePermsOK(path) {
			// The token may have been readable by other local users;
			// rotate it instead of trusting the existing value.
			_ = os.Remove(path)
		} else if token := strings.TrimSpace(string(raw)); token != "" {
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

// cliTokenFilePermsOK reports whether the token file is only accessible by the
// current user. On Windows, Unix permission bits are not meaningful (access is
// controlled by NTFS ACLs), so the check is skipped there.
func cliTokenFilePermsOK(path string) bool {
	if goruntime.GOOS == "windows" {
		return true
	}
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return info.Mode().Perm()&0o077 == 0
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
