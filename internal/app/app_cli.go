package app

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
	"regexp"
	goruntime "runtime"
	"strings"
	"time"

	"gxShell/backend/logger"
	sshmanager "gxShell/backend/ssh"
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

var cliHeredocPattern = regexp.MustCompile(`(?:^|[;&|]\s*|\s)<<-?\s*["']?[A-Za-z_][A-Za-z0-9_]*["']?`)

type cliApprovalDecision struct {
	Allowed  bool
	Source   string
	Strength string
	Err      error
}

const (
	cliApprovalNotRequired = "not-required"
	cliApprovalUser        = "user"
	cliApprovalTimedTrust  = "timed-trust"
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
	mux.HandleFunc("/cli/secrets", a.requireCliAuth(token, a.handleCliSecrets))
	mux.HandleFunc("/cli/jobs", a.requireCliAuth(token, a.handleCliJobs))
	mux.HandleFunc("/cli/copy", a.requireCliAuth(token, a.handleCliCopy))
	mux.HandleFunc("/cli/transfer", a.requireCliAuth(token, a.handleCliTransfer))
	mux.HandleFunc("/cli/tunnels", a.requireCliAuth(token, a.handleCliTunnels))
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
	a.cliServer.Store(server)

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
	ctx := a.ctx.Get()
	if ctx == nil {
		return
	}
	runtime.EventsEmit(ctx, "cli:server-error", map[string]any{
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
		Server    string            `json:"server"`
		Command   string            `json:"command"`
		Script    string            `json:"script,omitempty"`
		Shell     string            `json:"shell,omitempty"`
		Async     bool              `json:"async,omitempty"`
		TimeoutMs int               `json:"timeoutMs,omitempty"`
		Secrets   map[string]string `json:"secrets,omitempty"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, cliMaxRequestSize))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeCliError(w, http.StatusBadRequest, "validation", "invalid request body: "+err.Error())
		return
	}
	req.Server = strings.TrimSpace(req.Server)
	req.Command = strings.TrimSpace(req.Command)
	req.Shell = strings.TrimSpace(req.Shell)
	if req.Server == "" {
		writeCliError(w, http.StatusBadRequest, "validation", "server is required")
		return
	}
	if (req.Command == "") == (strings.TrimSpace(req.Script) == "") {
		writeCliError(w, http.StatusBadRequest, "validation", "provide exactly one of command or script")
		return
	}
	if req.Command != "" && (strings.ContainsAny(req.Command, "\r\n") || cliHeredocPattern.MatchString(req.Command)) {
		writeCliJSON(w, http.StatusBadRequest, map[string]any{
			"error":     "Multiline commands and heredocs must use script input so content travels over SSH stdin without nested shell quoting.",
			"errorKind": "script_input_required", "outcome": "validation_error", "blocked": false,
			"recommendedCommand": "gxshell-cli exec-stdin " + req.Server + " --shell bash",
		})
		return
	}
	if req.Script != "" {
		if !isAllowedCliShell(req.Shell) {
			writeCliError(w, http.StatusBadRequest, "validation", "script shell must be one of: sh, bash, dash, zsh, ksh")
			return
		}
	} else if req.Shell != "" {
		writeCliError(w, http.StatusBadRequest, "validation", "shell is only valid with script input")
		return
	}
	if req.Async && len(req.Secrets) > 0 {
		writeCliError(w, http.StatusBadRequest, "validation", "named secrets are supported only for synchronous execution; omit --follow/--detach")
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
		writeCliJSON(w, http.StatusNotFound, map[string]any{"error": err.Error(), "errorKind": "daemon", "outcome": "client_error", "blocked": false})
		return
	}
	serverName := cliProfileName(profile)
	secretValues, secretNames, err := a.resolveCliSecretRefs(req.Secrets)
	if err != nil {
		writeCliError(w, http.StatusBadRequest, "secret", err.Error())
		return
	}
	guardText := req.Command
	execCommand := req.Command
	var stdin *string
	if req.Script != "" {
		guardText = req.Script
		execCommand = req.Shell + " -s"
		script := req.Script
		stdin = &script
	}
	if len(secretValues) > 0 {
		displayShell := req.Shell
		if displayShell == "" {
			displayShell = "sh"
		}
		execCommand = displayShell + " -s"
		script := buildSecretExecutionScript(secretValues, req.Command, req.Script)
		stdin = &script
	}

	display := execCommand
	if req.Script != "" {
		display += " via SSH stdin:\n" + req.Script
	} else if len(secretValues) > 0 {
		display += " via SSH stdin:\n" + req.Command
	}
	if len(secretNames) > 0 {
		display += "\nNamed secrets: " + strings.Join(secretNames, ", ") + " (values hidden)"
	}
	assessment := classifyCommand(guardText)
	matchedUploads := a.applyCliUploadedFileRisk(profile.ID, guardText, &assessment)
	if len(matchedUploads) > 0 {
		display += formatCliUploadedFileContext(matchedUploads)
	}
	decision := a.authorizeCliProfileRiskExecution(profile, display, guardText, assessment)
	approvalSource := decision.Source
	if !decision.Allowed {
		if decision.Err != nil {
			fields := logger.CommandAuditFields(guardText)
			fields["server"] = serverName
			fields["profileID"] = profile.ID
			fields["approval"] = approvalSource
			fields["error"] = decision.Err.Error()
			for key, value := range tierAuditFields(assessment) {
				fields[key] = value
			}
			a.log.ErrorFields("CLI confirmation failed", fields)
			writeCliJSON(w, http.StatusInternalServerError, map[string]any{
				"alias":     serverName,
				"error":     "native confirmation failed: " + decision.Err.Error(),
				"errorKind": "confirmation",
				"blocked":   false,
				"outcome":   "client_error",
				"approval":  approvalSource,
				"riskTier":  assessment.Tier.String(), "riskLabel": assessment.Tier.Label(),
				"riskCategories": riskCategoryList(assessment), "approvalStrength": decision.Strength,
			})
			return
		}
		block := commandBlock{Kind: "confirmation", Reason: "user declined execution", Detail: describeTier(assessment)}
		fields := logger.CommandAuditFields(guardText)
		fields["server"] = serverName
		fields["profileID"] = profile.ID
		fields["approval"] = approvalSource
		fields["reason"] = block.Message()
		for key, value := range tierAuditFields(assessment) {
			fields[key] = value
		}
		a.log.ErrorFields("CLI command blocked", fields)
		writeCliJSON(w, http.StatusForbidden, map[string]any{
			"alias":     serverName,
			"error":     "BLOCKED: " + block.Message(),
			"errorKind": "blocked",
			"blocked":   true,
			"blockedBy": block.Kind,
			"reason":    block.Reason,
			"detail":    block.Detail,
			"outcome":   "blocked",
			"approval":  approvalSource,
			"riskTier":  assessment.Tier.String(), "riskLabel": assessment.Tier.Label(),
			"riskCategories": riskCategoryList(assessment), "approvalStrength": decision.Strength,
		})
		return
	}

	fields := logger.CommandAuditFields(guardText)
	fields["server"] = serverName
	fields["profileID"] = profile.ID
	fields["approval"] = approvalSource
	for key, value := range tierAuditFields(assessment) {
		fields[key] = value
	}
	a.log.InfoFields("CLI executing command", fields)

	sessionID, reusedConnection, err := a.cliSessionForProfile(profile.ID)
	if err != nil {
		writeCliJSON(w, http.StatusBadGateway, map[string]any{
			"alias":     serverName,
			"error":     "failed to connect: " + err.Error(),
			"errorKind": "connect",
			"outcome":   "transport_error",
			"blocked":   false,
		})
		return
	}

	// A CLI-created or otherwise backend-only session has no React tab yet.
	// Announce the selected session on every request; the frontend handles this
	// idempotently, so existing visible tabs are reused and hidden sessions are
	// surfaced before their automation output arrives.
	a.announceCliSession(sessionID)
	if req.Async {
		job := a.startCliJob(serverName, profile.ID, sessionID, execCommand, stdin, timeout, reusedConnection, assessment, approvalSource, decision.Strength)
		writeCliJSON(w, http.StatusAccepted, map[string]any{
			"alias": serverName, "reusedConnection": reusedConnection,
			"jobId": job.ID, "state": "queued", "timeoutMs": int(timeout / time.Millisecond),
			"approval": approvalSource, "approvalStrength": decision.Strength,
			"riskTier": assessment.Tier.String(), "riskLabel": assessment.Tier.Label(),
			"riskCategories": riskCategoryList(assessment),
		})
		return
	}

	safeActivityCommand := logger.RedactKnownSecrets(guardText, secretMapValues(secretValues))
	activityID := a.beginTerminalAutomationWithRisk(sessionID, "cli", "execute_command", safeActivityCommand, assessment, approvalSource)
	activityFinished := false
	// r.Context() ends when the CLI client disconnects, so an abandoned request
	// does not keep the remote command's exec channel open for up to 30 minutes.
	result, err := a.ssh.ExecuteCommandResultStream(r.Context(), sessionID, execCommand, stdin, timeout, cliOutputLimit, nil)
	reconnected := false
	reconnectAttempted := false
	reconnectFailed := false
	if err != nil && r.Context().Err() == nil && reusedConnection && sshmanager.IsRetryableCommandStartError(err) {
		reconnectAttempted = true
		a.finishTerminalAutomation(sessionID, activityID, "cli", "execute_command", "", err.Error(), 1, 0, false)
		activityFinished = true
		oldSessionID := sessionID
		a.announceCliSessionRecovering(oldSessionID)
		_ = a.ssh.Disconnect(oldSessionID)

		var reconnectErr error
		sessionID, _, reconnectErr = a.cliSessionForProfile(profile.ID)
		if reconnectErr == nil {
			reconnected = true
			a.announceCliSessionReplacement(oldSessionID, sessionID)
			activityID = a.beginTerminalAutomationWithRisk(sessionID, "cli", "execute_command", safeActivityCommand, assessment, approvalSource)
			activityFinished = false
			result, err = a.ssh.ExecuteCommandResultStream(r.Context(), sessionID, execCommand, stdin, timeout, cliOutputLimit, nil)
		} else {
			reconnectFailed = true
			err = fmt.Errorf("stale reused SSH connection was closed; reconnect failed: %w", reconnectErr)
		}
	}
	if err != nil {
		if !activityFinished {
			a.finishTerminalAutomation(sessionID, activityID, "cli", "execute_command", "", err.Error(), 1, 0, false)
		}
		writeCliJSON(w, http.StatusBadGateway, map[string]any{
			"alias":              serverName,
			"reusedConnection":   reusedConnection,
			"reconnectAttempted": reconnectAttempted,
			"reconnected":        reconnected,
			"error":              err.Error(),
			"errorKind":          map[bool]string{true: "connect", false: "ssh"}[reconnectFailed],
			"outcome":            "transport_error",
			"blocked":            false,
		})
		return
	}
	redactCommandExecutionResult(&result, secretValues)
	automationError := result.Error
	if result.TimedOut && automationError == "" {
		automationError = "remote command timeout"
	}
	a.finishTerminalAutomation(sessionID, activityID, "cli", "execute_command", result.DisplayOutput(), automationError, result.ExitCode, result.Duration, result.Truncated)

	payload := map[string]any{
		"alias":              serverName,
		"reusedConnection":   reusedConnection,
		"reconnectAttempted": reconnectAttempted,
		"reconnected":        reconnected,
		"exitCode":           result.ExitCode,
		"stdout":             result.Stdout,
		"stderr":             result.Stderr,
		"output":             result.Output,
		"summary":            result.Summary,
		"displayOutput":      result.DisplayOutput(),
		"durationMs":         result.Duration.Milliseconds(),
		"timeoutMs":          int(timeout / time.Millisecond),
		"timedOut":           result.TimedOut,
		"truncated":          result.Truncated,
		"blocked":            false,
		"approval":           approvalSource,
		"riskTier":           assessment.Tier.String(),
		"riskLabel":          assessment.Tier.Label(),
		"riskCategories":     riskCategoryList(assessment),
		"approvalStrength":   decision.Strength,
	}
	status := http.StatusOK
	if result.TimedOut {
		payload["outcome"] = "timeout"
		payload["error"] = "remote command timeout"
		payload["errorKind"] = "remote"
		payload["timeoutHint"] = cliTimeoutHint(timeout)
		status = http.StatusGatewayTimeout
	} else if result.Error != "" {
		payload["outcome"] = "transport_error"
		payload["error"] = result.Error
		payload["errorKind"] = "remote"
	} else if result.ExitCode != 0 {
		payload["outcome"] = "remote_failed"
		payload["errorKind"] = "remote_exit"
		payload["message"] = fmt.Sprintf("The remote shell returned exit code %d. gxShell did not block this command. Inspect stdout/stderr before retrying.", result.ExitCode)
	} else {
		payload["outcome"] = "succeeded"
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
	a.rememberCliSession(profileID, info.ID)
	call.res = cliConnectResult{sessionID: info.ID, reused: false}
	return info.ID, false, nil
}

// findCliSession returns the session ID of a connected SSH session for the
// given profile, or "" if none exists. Once a session is selected for a
// profile, keep using it while it remains connected instead of depending on
// Go map iteration order.
func (a *App) findCliSession(profileID string) string {
	a.cliSessionMu.Lock()
	defer a.cliSessionMu.Unlock()
	if a.cliPreferredSessions == nil {
		a.cliPreferredSessions = map[string]string{}
	}
	sessionID := chooseConnectedCliSession(profileID, a.cliPreferredSessions[profileID], a.ssh.List())
	if sessionID == "" {
		delete(a.cliPreferredSessions, profileID)
		return ""
	}
	a.cliPreferredSessions[profileID] = sessionID
	return sessionID
}

func chooseConnectedCliSession(profileID, preferredID string, sessions []types.SessionInfo) string {
	if preferredID != "" {
		for _, session := range sessions {
			if session.ID == preferredID && session.ProfileID == profileID && session.State == types.SessionConnected {
				return preferredID
			}
		}
	}
	for _, session := range sessions {
		if session.ProfileID == profileID && session.State == types.SessionConnected {
			return session.ID
		}
	}
	return ""
}

func (a *App) rememberCliSession(profileID, sessionID string) {
	if profileID == "" || sessionID == "" {
		return
	}
	a.cliSessionMu.Lock()
	if a.cliPreferredSessions == nil {
		a.cliPreferredSessions = map[string]string{}
	}
	a.cliPreferredSessions[profileID] = sessionID
	a.cliSessionMu.Unlock()
}

func (a *App) forgetCliSession(sessionID string) {
	if sessionID == "" {
		return
	}
	a.cliSessionMu.Lock()
	for profileID, preferredID := range a.cliPreferredSessions {
		if preferredID == sessionID {
			delete(a.cliPreferredSessions, profileID)
		}
	}
	a.cliSessionMu.Unlock()
}

func (a *App) announceCliSession(sessionID string) {
	info, err := a.ssh.Get(sessionID)
	if err != nil {
		return
	}
	a.emitCliSessionAvailable(info)
}

func (a *App) announceCliSessionReplacement(oldSessionID, newSessionID string) {
	info, err := a.ssh.Get(newSessionID)
	if err != nil {
		return
	}
	if a.cliSessionReplacementEventFn != nil {
		a.cliSessionReplacementEventFn(oldSessionID, info)
		return
	}
	if ctx := a.ctx.Get(); ctx != nil {
		runtime.EventsEmit(ctx, "terminal:cli-session-replaced", map[string]any{
			"oldSessionId": oldSessionID,
			"session":      info,
		})
	}
}

func (a *App) announceCliSessionRecovering(sessionID string) {
	if ctx := a.ctx.Get(); ctx != nil {
		runtime.EventsEmit(ctx, "terminal:cli-session-recovering", map[string]any{
			"sessionId": sessionID,
		})
	}
}

func (a *App) emitCliSessionAvailable(info types.SessionInfo) {
	if info.ID == "" {
		return
	}
	if a.cliSessionEventFn != nil {
		a.cliSessionEventFn(info)
		return
	}
	if ctx := a.ctx.Get(); ctx != nil {
		runtime.EventsEmit(ctx, "terminal:cli-session", info)
	}
}

func (a *App) confirmCliExecution(serverName, command string) bool {
	if a.ctx.Get() == nil {
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

// authorizeCliProfileExecution is the convenience entry point used by tests and
// non-script callers. The request handler classifies guardText separately so a
// script can display its transport command while still scoring its full body.
func (a *App) authorizeCliProfileExecution(profile types.Profile, command string) cliApprovalDecision {
	return a.authorizeCliProfileRiskExecution(profile, command, command, classifyCommand(command))
}

func (a *App) authorizeCliProfileRiskExecution(profile types.Profile, display, riskText string, assessment riskAssessment) cliApprovalDecision {
	trusted := a.cliProfilesTrustedNow([]string{profile.ID}, time.Now())
	strength := assessment.requiredApproval(trusted)
	if strength == approvalNone {
		source := cliApprovalNotRequired
		if trusted && assessment.Tier == tierRecoverable {
			source = cliApprovalTimedTrust
		}
		return cliApprovalDecision{Allowed: true, Source: source, Strength: strength.String()}
	}
	language := a.cliApprovalLanguage()
	riskLines := assessment.riskLinesForLanguage(language)
	display = formatRiskApprovalForLanguage(display, assessment, language, riskLines)
	var confirmationErr error
	allowed := a.withCliApprovalEvent(cliProfileName(profile), riskText, assessment, strength, language, riskLines, func() bool {
		if assessment.Tier == tierCritical {
			// Critical requests never join a batch: otherwise one dangerous command
			// can hide among ordinary T1/T2 requests behind a single Allow all click.
			var confirmed bool
			confirmed, confirmationErr = a.confirmCliCriticalExecution(cliProfileName(profile), display, assessment, strength)
			return confirmed
		}
		return a.confirmCliExecution(cliProfileName(profile), display)
	})
	return cliApprovalDecision{
		Allowed:  allowed,
		Source:   cliApprovalUser,
		Strength: strength.String(),
		Err:      confirmationErr,
	}
}

func formatRiskApproval(command string, assessment riskAssessment) string {
	return formatRiskApprovalForLanguage(command, assessment, "", assessment.riskLines())
}

func formatRiskApprovalForLanguage(command string, assessment riskAssessment, language string, lines []string) string {
	sections := []string{truncate(command, 800)}
	if len(lines) > 0 {
		const explanationLimit = 4
		visible := lines
		if len(visible) > explanationLimit {
			visible = visible[:explanationLimit]
		}
		items := make([]string, 0, len(visible)+1)
		for _, line := range visible {
			items = append(items, "- "+line)
		}
		if remaining := len(lines) - len(visible); remaining > 0 {
			if isChineseLanguage(language) {
				items = append(items, fmt.Sprintf("- 另有 %d 项作用", remaining))
			} else {
				items = append(items, fmt.Sprintf("- and %d additional effect(s)", remaining))
			}
		}
		heading := "What this does:"
		if isChineseLanguage(language) {
			heading = "作用说明："
		}
		sections = append(sections, heading+"\n"+strings.Join(items, "\n"))
	}
	if isChineseLanguage(language) {
		sections = append(sections, fmt.Sprintf("风险等级：%s（%s）", assessment.Tier, assessment.Tier.labelForLanguage(language)))
	} else {
		sections = append(sections, fmt.Sprintf("Risk level: %s (%s)", assessment.Tier, assessment.Tier.Label()))
	}
	return strings.Join(sections, "\n\n")
}

func (a *App) cliApprovalLanguage() string {
	if a.store == nil {
		return ""
	}
	settings, err := a.store.GetSettings()
	if err != nil {
		return ""
	}
	return settings.Language
}

func (a *App) confirmCliCriticalExecution(serverName, command string, assessment riskAssessment, strength approvalStrength) (bool, error) {
	if a.cliConfirmRiskFn != nil {
		return a.cliConfirmRiskFn(serverName, command, assessment, strength)
	}
	return a.confirmCliCriticalExecutionNative(serverName, command, assessment, strength)
}

func (a *App) confirmCliCriticalExecutionNative(serverName, command string, _ riskAssessment, _ approvalStrength) (bool, error) {
	ctx := a.ctx.Get()
	if ctx == nil {
		return false, fmt.Errorf("application context is unavailable")
	}
	title := "CLI critical command"
	message := fmt.Sprintf("An external CLI request wants to run a critical command on %s:\n\n%s\n\nAllow this?", serverName, truncate(command, 2000))
	a.nativeDialogMu.Lock()
	defer a.nativeDialogMu.Unlock()
	res, err := runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
		Type:          runtime.QuestionDialog,
		Title:         title,
		Message:       message,
		Buttons:       []string{"Allow", "Deny"},
		DefaultButton: "Deny",
		CancelButton:  "Deny",
	})
	if err != nil {
		return false, err
	}
	// Wails 2.x uses a native Yes/No MessageBox on Windows and ignores custom
	// button labels there. Other platforms return "Allow".
	return res == "Allow" || res == "Yes", nil
}

// authorizeCliCopy requires both endpoints to be inside their trust windows.
func (a *App) authorizeCliCopy(source, destination types.Profile, description string) cliApprovalDecision {
	now := time.Now()
	if a.cliProfilesTrustedNow([]string{source.ID, destination.ID}, now) {
		return cliApprovalDecision{Allowed: true, Source: cliApprovalTimedTrust}
	}
	serverName := cliProfileName(source) + " -> " + cliProfileName(destination)
	return cliApprovalDecision{
		Allowed: a.confirmCliExecution(serverName, description),
		Source:  cliApprovalUser,
	}
}

// cliProfilesTrustedNow re-reads profiles at the authorization boundary. A UI
// emergency revoke that commits before this short read therefore takes effect
// immediately; storage failures fail closed into native approval.
func (a *App) cliProfilesTrustedNow(profileIDs []string, now time.Time) bool {
	if a.store == nil || len(profileIDs) == 0 {
		return false
	}
	a.profilesMu.Lock()
	profiles, err := a.store.ListProfiles()
	a.profilesMu.Unlock()
	if err != nil {
		if a.log != nil {
			a.log.ErrorFields("CLI trust state could not be read", logger.LogFields{"error": err.Error()})
		}
		return false
	}
	wanted := make(map[string]bool, len(profileIDs))
	for _, id := range profileIDs {
		if id == "" {
			return false
		}
		wanted[id] = true
	}
	for _, profile := range profiles {
		if wanted[profile.ID] && cliProfileTrustActive(profile, now) {
			delete(wanted, profile.ID)
		}
	}
	return len(wanted) == 0
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
	ctx := a.ctx.Get()
	if ctx == nil || len(commands) == 0 {
		return false
	}
	title := "CLI wants to run commands"
	buttons := []string{"Allow all", "Deny"}
	message := fmt.Sprintf("An external CLI request wants to run %d command(s) on %s:\n\n%s\n\nAllow all of these?", len(commands), serverName, formatApprovalList(commands))
	if len(commands) == 1 {
		title = "CLI wants to run a command"
		buttons = []string{"Allow", "Deny"}
		message = fmt.Sprintf("An external CLI request wants to run this command on %s:\n\n%s\n\nAllow this?", serverName, truncate(commands[0], 2000))
	}
	a.nativeDialogMu.Lock()
	defer a.nativeDialogMu.Unlock()
	res, err := runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
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
	outcome := "client_error"
	if kind == "validation" || kind == "script_input_required" {
		outcome = "validation_error"
	} else if kind == "blocked" {
		outcome = "blocked"
	}
	writeCliJSON(w, status, map[string]any{"error": message, "errorKind": kind, "outcome": outcome, "blocked": kind == "blocked"})
}
