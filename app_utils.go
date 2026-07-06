package main

// Miscellaneous app bindings: app info, monitoring, command templates,
// settings, logs, and terminal-backend helpers.

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	osruntime "runtime"
	"strings"
	"time"

	"gxShell/backend/config"
	"gxShell/backend/types"
)

// GetAppInfo returns application metadata.
func (a *App) GetAppInfo() map[string]string {
	return map[string]string{
		"name":    "gxShell",
		"version": "1.2.0",
		"dataDir": a.store.DataDir(),
	}
}

// StartMonitor begins system monitoring for a session.
func (a *App) StartMonitor(sessionID string) error {
	settings, err := a.store.GetSettings()
	if err != nil {
		a.log.Error("failed to read settings: " + err.Error())
		settings = config.DefaultSettings()
	}
	a.monitor.Start(sessionID, settings.MonitorIntervalSec)
	return nil
}

// StopMonitor stops system monitoring for a session.
func (a *App) StopMonitor(sessionID string) error {
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
	return a.store.GetSettings()
}

// UpdateSettings updates application settings.
func (a *App) UpdateSettings(settings types.AppSettings) (types.AppSettings, error) {
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
	return settings, a.store.SaveSettings(settings)
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
	data, err := os.ReadFile(absPath)
	if err != nil {
		return "", err
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
