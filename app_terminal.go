package main

import (
	"errors"
	"fmt"
	"strings"

	"gxShell/backend/config"
	"gxShell/backend/types"
)

// Connect establishes an SSH connection to a server profile.
func (a *App) Connect(profileID string, cols int, rows int) (types.SessionInfo, error) {
	return a.ConnectWithSecrets(profileID, "", "", cols, rows)
}

// ConnectWithSecrets establishes an SSH connection with provided credentials.
func (a *App) ConnectWithSecrets(profileID string, password string, privateKeyPassphrase string, cols int, rows int) (types.SessionInfo, error) {
	// Check rate limit
	if err := a.rateLimiter.CheckAndRecord(profileID); err != nil {
		return types.SessionInfo{}, err
	}

	fullProfile, err := a.getProfileForConnect(profileID)
	if err != nil {
		return types.SessionInfo{}, err
	}

	// Load saved secrets if RememberPassword is enabled
	if fullProfile.RememberPassword {
		if err := a.loadProfileSecrets(&fullProfile); err != nil {
			return types.SessionInfo{}, err
		}
	}

	// Override with provided credentials
	if password != "" {
		fullProfile.Password = password
	}
	if privateKeyPassphrase != "" {
		fullProfile.PrivateKeyPassphrase = privateKeyPassphrase
	}

	// Clear sensitive data after connection attempt
	defer func() {
		fullProfile.Password = ""
		fullProfile.PrivateKeyPassphrase = ""
	}()

	// Handle ProxyJump if configured
	var jumpProfile types.Profile
	if fullProfile.ProxyJumpID != "" {
		jumpProfile, err = a.getProfileForConnect(fullProfile.ProxyJumpID)
		if err != nil {
			return types.SessionInfo{}, fmt.Errorf("jump host profile not found: %w", err)
		}
		if jumpProfile.RememberPassword {
			if err := a.loadProfileSecrets(&jumpProfile); err != nil {
				return types.SessionInfo{}, fmt.Errorf("jump host secrets load failed: %w", err)
			}
		}
		defer func() {
			jumpProfile.Password = ""
			jumpProfile.PrivateKeyPassphrase = ""
		}()
		if jumpProfile.ProxyJumpID != "" {
			return types.SessionInfo{}, errors.New("nested proxy jump is not supported")
		}
	}

	settings, settingsErr := a.store.GetSettings()
	if settingsErr != nil {
		a.log.Error("failed to read settings: " + settingsErr.Error())
		settings = config.DefaultSettings()
	}
	defaultSettings := config.DefaultSettings()
	if settings.ConnectionTimeout <= 0 {
		settings.ConnectionTimeout = defaultSettings.ConnectionTimeout
	}
	if settings.MonitorIntervalSec <= 0 {
		settings.MonitorIntervalSec = defaultSettings.MonitorIntervalSec
	}

	info, err := a.ssh.ConnectViaJump(fullProfile, jumpProfile, settings.ConnectionTimeout, cols, rows)
	if err != nil {
		a.log.Error("connect failed: " + err.Error())
		return info, err
	}

	// Reset rate limiter on successful connection
	a.rateLimiter.Reset(profileID)
	a.touchProfile(profileID)

	// Start monitoring if enabled
	if settings.MonitorEnabled {
		a.monitor.Start(info.ID, settings.MonitorIntervalSec)
	}

	// Start tunnels if configured
	if len(fullProfile.Tunnels) > 0 {
		client, clientErr := a.ssh.Client(info.ID)
		if clientErr == nil {
			a.tunnels.StartTunnels(info.ID, client, fullProfile.Tunnels)
		}
	}

	return info, nil
}

// Disconnect closes an SSH or local terminal session. Cross-subsystem cleanup
// (monitor, SFTP cache, tunnels, ping, AI tool grants, CLI session pins) is
// deliberately NOT repeated here: it lives in the ssh.Manager onClosed
// callback (see startup), which fires exactly once on every disconnect path —
// including server-initiated drops that never pass through this method.
func (a *App) Disconnect(sessionID string) error {
	backend, err := a.terminalBackend(sessionID)
	if err != nil {
		return err
	}
	return backend.Disconnect(sessionID)
}

// ConnectLocal establishes a local terminal session.
func (a *App) ConnectLocal(cols int, rows int) (types.SessionInfo, error) {
	settings, err := a.store.GetSettings()
	if err != nil {
		settings = config.DefaultSettings()
	}
	return a.local.ConnectWithOptions(settings.Terminal.LocalShell, settings.Terminal.LocalStartDirectory, cols, rows)
}

// Reconnect re-establishes a disconnected SSH session.
func (a *App) Reconnect(sessionID string) (types.SessionInfo, error) {
	return a.ReconnectWithSecrets(sessionID, "", "")
}

// ReconnectWithSecrets re-establishes a session with provided credentials.
func (a *App) ReconnectWithSecrets(sessionID string, password string, privateKeyPassphrase string) (types.SessionInfo, error) {
	old, err := a.ssh.Get(sessionID)
	if err != nil {
		return types.SessionInfo{}, err
	}
	_ = a.Disconnect(sessionID)
	return a.ConnectWithSecrets(old.ProfileID, password, privateKeyPassphrase, old.Cols, old.Rows)
}

// WriteToTerminal sends data to a terminal session.
func (a *App) WriteToTerminal(sessionID string, data string) error {
	backend, err := a.terminalBackend(sessionID)
	if err != nil {
		return err
	}
	return backend.Write(sessionID, data)
}

// ResizeTerminal adjusts the terminal dimensions.
func (a *App) ResizeTerminal(sessionID string, cols int, rows int) error {
	backend, err := a.terminalBackend(sessionID)
	if err != nil {
		return err
	}
	return backend.Resize(sessionID, cols, rows)
}

// ListSessions returns all active terminal sessions.
func (a *App) ListSessions() []types.SessionInfo {
	sessions := []types.SessionInfo{}
	for _, backend := range a.terminalBackends() {
		sessions = append(sessions, backend.List()...)
	}
	return sessions
}

// SendCommandToTerminal sends a command to a terminal with automatic newline.
func (a *App) SendCommandToTerminal(sessionID string, command string) error {
	if !strings.HasSuffix(command, "\n") {
		command += "\n"
	}
	backend, err := a.terminalBackend(sessionID)
	if err != nil {
		return err
	}
	return backend.Write(sessionID, command)
}

// SendCommandToAll broadcasts a command to all active SSH sessions.
func (a *App) SendCommandToAll(command string) error {
	sessions := a.ssh.List()
	if len(sessions) == 0 {
		return fmt.Errorf("no active sessions")
	}
	if !strings.HasSuffix(command, "\n") {
		command += "\n"
	}
	var errs []string
	for _, s := range sessions {
		if err := a.ssh.Write(s.ID, command); err != nil {
			errs = append(errs, fmt.Sprintf("%s: %s", s.Name, err.Error()))
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("partial failure: %s", strings.Join(errs, "; "))
	}
	return nil
}

// LogCommand records a command execution to the history log.
func (a *App) LogCommand(sessionID string, line string) {
	host := ""
	if session, err := a.terminalInfo(sessionID); err == nil {
		host = session.Name
	}
	a.log.LogCommand(sessionID, host, line)
}

// ExportHistory opens the command history file for viewing.
func (a *App) ExportHistory() error {
	return a.log.OpenHistory()
}
