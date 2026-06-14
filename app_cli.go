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
	cliMaxRequestSize = 32 * 1024
	cliCommandTimeout = 30 * time.Second
	cliOutputLimit    = 1024 * 1024
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
		WriteTimeout:      5 * time.Minute,
		IdleTimeout:       60 * time.Second,
	}

	a.log.Info("CLI server listening on " + cliAddress)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		a.log.ErrorFields("CLI server failed", logger.LogFields{"error": err.Error()})
	}
}

func (a *App) requireCliAuth(token string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isAuthorizedCliRequest(r, token) {
			writeCliJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized CLI request"})
			return
		}
		next(w, r)
	}
}

func (a *App) handleCliExec(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeCliJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var req struct {
		Server  string `json:"server"`
		Command string `json:"command"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, cliMaxRequestSize))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeCliJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body: " + err.Error()})
		return
	}
	req.Server = strings.TrimSpace(req.Server)
	req.Command = strings.TrimSpace(req.Command)
	if req.Server == "" || req.Command == "" {
		writeCliJSON(w, http.StatusBadRequest, map[string]string{"error": "server and command are required"})
		return
	}

	profile, err := a.findCliProfile(req.Server)
	if err != nil {
		writeCliJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
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
			"error":   "BLOCKED: " + reason,
			"blocked": true,
			"reason":  reason,
		})
		return
	}

	a.log.InfoFields("CLI executing command", logger.LogFields{
		"server":    serverName,
		"profileID": profile.ID,
		"command":   req.Command,
	})

	sessionID, err := a.cliSessionForProfile(profile.ID)
	if err != nil {
		writeCliJSON(w, http.StatusBadGateway, map[string]string{"error": "failed to connect: " + err.Error()})
		return
	}

	result, err := a.ssh.ExecuteCommandResult(sessionID, req.Command, cliCommandTimeout, cliOutputLimit)
	if err != nil {
		writeCliJSON(w, http.StatusBadGateway, map[string]any{
			"error": err.Error(),
		})
		return
	}

	payload := map[string]any{
		"output":    result.Output,
		"exitCode":  result.ExitCode,
		"timedOut":  result.TimedOut,
		"truncated": result.Truncated,
	}
	status := http.StatusOK
	if result.TimedOut {
		payload["error"] = "remote command timeout"
		status = http.StatusGatewayTimeout
	}
	writeCliJSON(w, status, payload)
}

func (a *App) handleCliList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeCliJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
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
		writeCliJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
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
		writeCliJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
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

func (a *App) cliSessionForProfile(profileID string) (string, error) {
	a.cliMu.Lock()
	defer a.cliMu.Unlock()

	for _, session := range a.ssh.List() {
		if session.ProfileID == profileID && session.State == types.SessionConnected {
			return session.ID, nil
		}
	}

	info, err := a.Connect(profileID, 120, 34)
	if err != nil {
		return "", err
	}
	return info.ID, nil
}

func (a *App) confirmCliExecution(serverName, command string) bool {
	if a.ctx == nil {
		return false
	}
	res, err := runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
		Type:          runtime.QuestionDialog,
		Title:         "CLI wants to run a command",
		Message:       fmt.Sprintf("An external CLI request wants to run this command on %s:\n\n%s\n\nAllow this?", serverName, truncate(command, 500)),
		Buttons:       []string{"Allow", "Deny"},
		DefaultButton: "Deny",
		CancelButton:  "Deny",
	})
	if err != nil {
		a.log.ErrorFields("CLI confirm dialog failed", logger.LogFields{"error": err.Error()})
		return false
	}
	return res == "Allow" || res == "Yes"
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
