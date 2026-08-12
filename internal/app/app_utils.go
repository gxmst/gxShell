package app

// Miscellaneous app bindings: app info, monitoring, command templates,
// settings, logs, and terminal-backend helpers.

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	osruntime "runtime"
	"strings"
	"time"

	"gxShell/backend/config"
	"gxShell/backend/types"
	"gxShell/backend/version"
)

const logViewerTailBytes int64 = 1024 * 1024
const logViewerTruncationNotice = "[gxShell: older log output was omitted]\n"

// GetAppInfo returns application metadata.
func (a *App) GetAppInfo() map[string]string {
	return map[string]string{
		"name":    "gxShell",
		"version": version.Version,
		"dataDir": a.store.DataDir(),
	}
}

// StartMonitor begins system monitoring for a session.
func (a *App) StartMonitor(sessionID string) error {
	settings, err := a.store.GetSettings()
	if err != nil {
		if a.log != nil {
			a.log.Error("failed to read settings: " + err.Error())
		}
		settings = config.DefaultSettings()
	}
	if a.monitor == nil {
		return errors.New("monitor unavailable")
	}
	if !settings.MonitorEnabled {
		// StartMonitor is also called from connection events. Respect the saved
		// switch here, at the backend boundary, so a stale frontend callback
		// cannot silently turn monitoring back on.
		a.monitor.Stop(sessionID)
		return nil
	}
	a.monitor.Start(sessionID, settings.MonitorIntervalSec)
	return nil
}

// StopMonitor stops system monitoring for a session.
func (a *App) StopMonitor(sessionID string) error {
	if a.monitor == nil {
		return errors.New("monitor unavailable")
	}
	a.monitor.Stop(sessionID)
	return nil
}

// GetLatestMetrics returns the most recent monitoring metrics for a session.
func (a *App) GetLatestMetrics(sessionID string) types.Metrics {
	return a.monitor.Latest(sessionID)
}

// ListCommands returns all command templates.
func (a *App) ListCommands() ([]types.CommandTemplate, error) {
	return a.store.ListCommands()
}

// CreateCommand creates a new command template.
func (a *App) CreateCommand(command types.CommandTemplate) (types.CommandTemplate, error) {
	commands, err := a.store.ListCommands()
	if err != nil {
		return types.CommandTemplate{}, err
	}
	now := time.Now()
	command.ID = types.NewID("cmd")
	command.CreatedAt = now
	command.UpdatedAt = now
	commands = append(commands, command)
	return command, a.store.SaveCommands(commands)
}

// UpdateCommand updates an existing command template.
func (a *App) UpdateCommand(command types.CommandTemplate) (types.CommandTemplate, error) {
	commands, err := a.store.ListCommands()
	if err != nil {
		return types.CommandTemplate{}, err
	}
	for i := range commands {
		if commands[i].ID == command.ID {
			command.CreatedAt = commands[i].CreatedAt
			command.UpdatedAt = time.Now()
			commands[i] = command
			return command, a.store.SaveCommands(commands)
		}
	}
	return types.CommandTemplate{}, errors.New("command not found")
}

// DeleteCommand deletes a command template.
func (a *App) DeleteCommand(id string) error {
	commands, err := a.store.ListCommands()
	if err != nil {
		return err
	}
	next := commands[:0]
	for _, command := range commands {
		if command.ID != id {
			next = append(next, command)
		}
	}
	return a.store.SaveCommands(next)
}

// GetSettings returns application settings.
func (a *App) GetSettings() (types.AppSettings, error) {
	settings, err := a.store.GetSettings()
	// The removed permanent trust switch is intentionally never surfaced as
	// active, even when an older settings.json still contains true.
	settings.CliAutoApprove = false
	return settings, err
}

// UpdateSettings updates application settings.
func (a *App) UpdateSettings(settings types.AppSettings) (types.AppSettings, error) {
	previous, previousErr := a.store.GetSettings()
	settings = config.NormalizeSettings(settings)
	// Never persist or revive the deprecated permanent trust switch.
	settings.CliAutoApprove = false
	if settings.ConnectionTimeout <= 0 {
		settings.ConnectionTimeout = 15
	}
	if settings.MonitorIntervalSec <= 0 {
		settings.MonitorIntervalSec = 5
	}
	if settings.Ai.Provider == "" && settings.Ai.APIKey == "" && settings.Ai.Endpoint == "" && settings.Ai.Model == "" {
		aiCfg := a.ai.GetConfig()
		settings.Ai = types.AiConfig{
			Provider: string(aiCfg.Provider),
			Endpoint: aiCfg.Endpoint,
			Model:    aiCfg.Model,
		}
	}
	settings.Ai.APIKey = ""
	if err := a.store.SaveSettings(settings); err != nil {
		return settings, err
	}

	// Apply monitor settings only after persistence succeeds, keeping runtime
	// behaviour and the value shown after a restart in lockstep.
	if a.monitor != nil {
		if !settings.MonitorEnabled {
			a.monitor.StopAll()
		} else {
			a.monitor.RestartAll(settings.MonitorIntervalSec)
			// Re-enabling monitoring should also cover SSH sessions that stayed
			// connected while the feature was disabled. RestartAll only knows
			// about currently running pollers, so seed those sessions explicitly.
			if (previousErr != nil || !previous.MonitorEnabled) && a.ssh != nil {
				for _, session := range a.ssh.List() {
					if session.State == types.SessionConnected {
						a.monitor.Start(session.ID, settings.MonitorIntervalSec)
					}
				}
			}
		}
	}
	return settings, nil
}

// ReadLogs returns recent log entries.
func (a *App) ReadLogs(limit int) []types.LogEntry {
	return a.log.ReadLatest(limit)
}

// ListLogFiles returns all available log files.
func (a *App) ListLogFiles() []types.LogFile {
	logDir := filepath.Join(a.store.DataDir(), "logs")
	entries, err := os.ReadDir(logDir)
	if err != nil {
		return []types.LogFile{}
	}
	var files []types.LogFile
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, types.LogFile{
			Name:    entry.Name(),
			Path:    filepath.Join(logDir, entry.Name()),
			Size:    info.Size(),
			ModTime: info.ModTime(),
		})
	}
	return files
}

// ReadLogFile reads a specific log file by name.
func (a *App) ReadLogFile(name string) (string, error) {
	logDir := filepath.Join(a.store.DataDir(), "logs")
	cleanName := filepath.Base(name)
	path := filepath.Join(logDir, cleanName)
	absPath, err := filepath.Abs(path)
	if err != nil || !strings.HasPrefix(absPath, filepath.Clean(logDir)+string(os.PathSeparator)) {
		return "", fmt.Errorf("access denied")
	}
	file, err := os.Open(absPath)
	if err != nil {
		return "", err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	start := info.Size() - logViewerTailBytes
	truncated := start > 0
	if start < 0 {
		start = 0
	}
	if _, err := file.Seek(start, io.SeekStart); err != nil {
		return "", err
	}
	data, err := io.ReadAll(io.LimitReader(file, logViewerTailBytes))
	if err != nil {
		return "", err
	}
	if truncated {
		if newline := bytes.IndexByte(data, '\n'); newline >= 0 {
			data = data[newline+1:]
		}
		return logViewerTruncationNotice + string(data), nil
	}
	return string(data), nil
}

// OpenDataDir opens the application data directory in the file explorer.
func (a *App) OpenDataDir() error {
	dir := a.store.DataDir()
	switch osruntime.GOOS {
	case "windows":
		return exec.Command("explorer.exe", dir).Start()
	case "darwin":
		return exec.Command("open", dir).Start()
	default:
		return exec.Command("xdg-open", dir).Start()
	}
}

// terminalBackends returns all available terminal session backends.
func (a *App) terminalBackends() []terminalSessionBackend {
	backends := make([]terminalSessionBackend, 0, 2)
	if a.ssh != nil {
		backends = append(backends, a.ssh)
	}
	if a.local != nil {
		backends = append(backends, a.local)
	}
	return backends
}

// terminalBackend finds the backend managing a specific session.
func (a *App) terminalBackend(sessionID string) (terminalSessionBackend, error) {
	if sessionID == "" {
		return nil, errors.New("session not found")
	}
	for _, backend := range a.terminalBackends() {
		if _, err := backend.Get(sessionID); err == nil {
			return backend, nil
		}
	}
	return nil, errors.New("session not found")
}

// terminalInfo retrieves session information.
func (a *App) terminalInfo(sessionID string) (types.SessionInfo, error) {
	backend, err := a.terminalBackend(sessionID)
	if err != nil {
		return types.SessionInfo{}, err
	}
	return backend.Get(sessionID)
}
