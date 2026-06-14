package main

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
	"gxShell/backend/localfs"
	"gxShell/backend/types"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// GetAppInfo returns application metadata.
func (a *App) GetAppInfo() map[string]string {
	return map[string]string{
		"name":    "gxShell",
		"version": "1.1.1",
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

// TraceRoute performs a traceroute to the target server.
func (a *App) TraceRoute(sessionID string) (*types.NetworkPath, error) {
	info, err := a.ssh.Get(sessionID)
	if err != nil {
		return nil, err
	}
	profile, err := a.getProfileForConnect(info.ProfileID)
	if err != nil {
		return nil, err
	}
	return a.net.TraceRoute(profile.Host)
}

// PingHost pings the target server.
func (a *App) PingHost(sessionID string, count int) (*types.NetworkPath, error) {
	client, err := a.ssh.Client(sessionID)
	if err != nil {
		return nil, err
	}
	info, err := a.ssh.Get(sessionID)
	if err != nil {
		return nil, err
	}
	profile, err := a.getProfileForConnect(info.ProfileID)
	if err != nil {
		return nil, err
	}
	return a.net.Ping(client, profile.Host, count)
}

// StartNetworkPing starts continuous ping monitoring.
func (a *App) StartNetworkPing(sessionID string, intervalSec int) error {
	client, err := a.ssh.Client(sessionID)
	if err != nil {
		return err
	}
	info, err := a.ssh.Get(sessionID)
	if err != nil {
		return err
	}
	profile, err := a.getProfileForConnect(info.ProfileID)
	if err != nil {
		return err
	}
	a.net.StartPing(sessionID, client, profile.Host, intervalSec)
	return nil
}

// StopNetworkPing stops continuous ping monitoring.
func (a *App) StopNetworkPing(sessionID string) {
	a.net.StopPing(sessionID)
}

// GetNetworkPath returns cached network path information.
func (a *App) GetNetworkPath(sessionID string) (*types.NetworkPath, error) {
	client, err := a.ssh.Client(sessionID)
	if err != nil {
		return nil, err
	}
	info, err := a.ssh.Get(sessionID)
	if err != nil {
		return nil, err
	}
	profile, err := a.getProfileForConnect(info.ProfileID)
	if err != nil {
		return nil, err
	}
	path := a.net.GetPath(profile.Host)
	if path == nil {
		return a.net.Ping(client, profile.Host, 4)
	}
	return path, nil
}

// ListTunnelStatus returns SSH tunnel status for a session.
func (a *App) ListTunnelStatus(sessionID string) []types.TunnelStatus {
	return a.tunnels.ListStatus(sessionID)
}

// RestartTunnels restarts all SSH tunnels for a session.
func (a *App) RestartTunnels(sessionID string) ([]types.TunnelStatus, error) {
	info, err := a.ssh.Get(sessionID)
	if err != nil {
		return nil, err
	}
	profile, err := a.getProfileForConnect(info.ProfileID)
	if err != nil {
		return nil, err
	}
	client, err := a.ssh.Client(sessionID)
	if err != nil {
		return nil, err
	}
	a.tunnels.StopTunnels(sessionID)
	return a.tunnels.StartTunnels(sessionID, client, profile.Tunnels), nil
}

// AddTunnelRule adds a new SSH tunnel rule and starts it.
func (a *App) AddTunnelRule(sessionID string, rule types.TunnelRule) (types.TunnelStatus, error) {
	info, err := a.ssh.Get(sessionID)
	if err != nil {
		return types.TunnelStatus{}, err
	}
	client, err := a.ssh.Client(sessionID)
	if err != nil {
		return types.TunnelStatus{}, err
	}
	if rule.ID == "" {
		rule.ID = types.NewID("tunnel")
	}
	status := a.tunnels.AddTunnel(sessionID, client, rule)
	if status.Active {
		profile, perr := a.getProfileForConnect(info.ProfileID)
		if perr == nil {
			profile.Tunnels = append(profile.Tunnels, rule)
			_, _ = a.UpdateProfile(profile)
		}
	}
	return status, nil
}

// RemoveTunnelRule removes an SSH tunnel rule.
func (a *App) RemoveTunnelRule(sessionID string, ruleID string) error {
	info, err := a.ssh.Get(sessionID)
	if err != nil {
		return err
	}
	a.tunnels.RemoveTunnel(sessionID, ruleID)
	profile, perr := a.getProfileForConnect(info.ProfileID)
	if perr == nil {
		for i, r := range profile.Tunnels {
			if r.ID == ruleID {
				profile.Tunnels = append(profile.Tunnels[:i], profile.Tunnels[i+1:]...)
				_, _ = a.UpdateProfile(profile)
				break
			}
		}
	}
	return nil
}

// ListLocalDir lists files in a local directory.
func (a *App) ListLocalDir(dir string) ([]types.LocalFile, error) {
	return localfs.ListDir(dir)
}

// LocalHomeDir returns the user's home directory path.
func (a *App) LocalHomeDir() string {
	return localfs.HomeDir()
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

// getProfileForConnect retrieves a profile for connection.
func (a *App) getProfileForConnect(id string) (types.Profile, error) {
	profiles, err := a.store.ListProfiles()
	if err != nil {
		return types.Profile{}, err
	}
	for _, profile := range profiles {
		if profile.ID == id {
			return profile, nil
		}
	}
	return types.Profile{}, errors.New("profile not found")
}

// saveProfileSecrets stores profile credentials in secure storage.
func (a *App) saveProfileSecrets(profile *types.Profile) error {
	password := profile.Password
	passphrase := profile.PrivateKeyPassphrase
	profile.Password = ""
	profile.PrivateKeyPassphrase = ""
	if !profile.RememberPassword {
		a.secrets.Delete(profile.ID)
		return nil
	}
	if err := a.secrets.SavePassword(profile.ID, password); err != nil {
		return err
	}
	return a.secrets.SavePassphrase(profile.ID, passphrase)
}

// loadProfileSecrets retrieves profile credentials from secure storage.
func (a *App) loadProfileSecrets(profile *types.Profile) error {
	password, err := a.secrets.GetPassword(profile.ID)
	if err != nil {
		return err
	}
	passphrase, err := a.secrets.GetPassphrase(profile.ID)
	if err != nil {
		return err
	}
	if password != "" {
		profile.Password = password
	}
	if passphrase != "" {
		profile.PrivateKeyPassphrase = passphrase
	}
	return nil
}

// touchProfile updates the last connection timestamp for a profile.
func (a *App) touchProfile(id string) {
	profiles, err := a.store.ListProfiles()
	if err != nil {
		return
	}
	for i := range profiles {
		if profiles[i].ID == id {
			profiles[i].LastConnectedAt = time.Now()
			profiles[i].UpdatedAt = time.Now()
			_ = a.store.SaveProfiles(profiles)
			return
		}
	}
}

// normalizeProfile sets default values for a profile.
func normalizeProfile(profile *types.Profile) {
	if profile.Port <= 0 {
		profile.Port = 22
	}
	if profile.AuthType == "" {
		profile.AuthType = types.AuthPassword
	}
	if strings.TrimSpace(profile.Name) == "" {
		profile.Name = fmt.Sprintf("%s@%s", profile.Username, profile.Host)
	}
	if profile.Tags == nil {
		profile.Tags = []string{}
	}
	profile.CliAlias = strings.TrimSpace(profile.CliAlias)
}

func validateProfileCliSettings(profile types.Profile, profiles []types.Profile) error {
	if !profile.CliEnabled {
		return nil
	}
	alias := strings.TrimSpace(profile.CliAlias)
	if alias == "" {
		return errors.New("CLI alias is required when access is enabled")
	}
	for _, existing := range profiles {
		if existing.ID == profile.ID || !existing.CliEnabled {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(existing.CliAlias), alias) {
			return fmt.Errorf("CLI alias %q is already used", alias)
		}
	}
	return nil
}

// sanitizeProfiles removes sensitive data from a list of profiles.
func sanitizeProfiles(profiles []types.Profile) []types.Profile {
	out := make([]types.Profile, len(profiles))
	for i, profile := range profiles {
		out[i] = sanitizeProfile(profile)
	}
	return out
}

// sanitizeProfile removes sensitive data from a profile.
func sanitizeProfile(profile types.Profile) types.Profile {
	profile.Password = ""
	profile.PrivateKeyPassphrase = ""
	return profile
}

// truncate limits a string to maxLen characters.
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

// shellescape escapes a string for safe shell usage.
func shellescape(s string) string {
	if s == "" {
		return "''"
	}
	safe := true
	for _, c := range s {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '/') {
			safe = false
			break
		}
	}
	if safe {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

// allowFile records that the user has genuinely chosen to open this path, so
// ReadLocalFile/WriteLocalFile may subsequently operate on it.
func (a *App) allowFile(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return ""
	}
	abs = filepath.Clean(abs)
	a.allowedFilesMu.Lock()
	a.allowedFiles[abs] = true
	a.allowedFilesMu.Unlock()
	return abs
}

// isFileAllowed reports whether path was previously authorized via allowFile.
func (a *App) isFileAllowed(absPath string) bool {
	a.allowedFilesMu.Lock()
	defer a.allowedFilesMu.Unlock()
	return a.allowedFiles[absPath]
}

// ReadLocalFile reads a local file and returns its content. Only files the user
// has explicitly opened (see allowFile) may be read, so a compromised renderer
// cannot exfiltrate arbitrary files from disk.
func (a *App) ReadLocalFile(filePath string) (string, error) {
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		return "", fmt.Errorf("invalid file path: %w", err)
	}
	absPath = filepath.Clean(absPath)
	if !a.isFileAllowed(absPath) {
		return "", fmt.Errorf("access denied: file was not opened by the user")
	}

	info, err := os.Stat(absPath)
	if err != nil {
		return "", fmt.Errorf("file not found: %w", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("path is a directory, not a file")
	}

	const maxFileSize = 5 * 1024 * 1024
	if info.Size() > maxFileSize {
		return "", fmt.Errorf("file too large (max 5MB)")
	}

	data, err := os.ReadFile(absPath)
	if err != nil {
		return "", fmt.Errorf("failed to read file: %w", err)
	}

	return string(data), nil
}

// WriteLocalFile writes content to a local file, preserving its existing permissions.
func (a *App) WriteLocalFile(filePath string, content string) error {
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		return fmt.Errorf("invalid file path: %w", err)
	}
	absPath = filepath.Clean(absPath)
	// Writing is only permitted to a path the user already opened. We never
	// auto-allow on write, so the renderer cannot overwrite an arbitrary file.
	if !a.isFileAllowed(absPath) {
		return fmt.Errorf("access denied: file was not opened by the user")
	}

	const maxFileSize = 5 * 1024 * 1024
	if len(content) > maxFileSize {
		return fmt.Errorf("content too large (max 5MB)")
	}

	// Preserve existing file mode when the file already exists.
	mode := os.FileMode(0644)
	if info, statErr := os.Stat(absPath); statErr == nil {
		if info.IsDir() {
			return fmt.Errorf("path is a directory, not a file")
		}
		mode = info.Mode().Perm()
	}

	if err := os.WriteFile(absPath, []byte(content), mode); err != nil {
		return fmt.Errorf("failed to write file: %w", err)
	}
	return nil
}

// SelectMarkdownFile opens a file dialog to select a Markdown file.
func (a *App) SelectMarkdownFile() (string, error) {
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Markdown file",
		Filters: []runtime.FileFilter{
			{DisplayName: "Markdown Files (*.md)", Pattern: "*.md"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil || path == "" {
		return path, err
	}
	if !isMarkdownPath(path) {
		return "", fmt.Errorf("selected file is not a Markdown file")
	}
	return a.allowFile(path), nil
}

// ListMarkdownFilesInDir lists all .md files in the same directory as the given file.
// The returned siblings are authorized for reading, matching the viewer's behavior
// of letting the user step between markdown files in the opened folder.
func (a *App) ListMarkdownFilesInDir(filePath string) ([]string, error) {
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		return nil, fmt.Errorf("invalid file path: %w", err)
	}
	absPath = filepath.Clean(absPath)
	if !isMarkdownPath(absPath) {
		return nil, fmt.Errorf("file is not a Markdown file")
	}
	if !a.isFileAllowed(absPath) {
		return nil, fmt.Errorf("access denied: file was not opened by the user")
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return nil, fmt.Errorf("file not found: %w", err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("path is a directory, not a file")
	}

	dir := filepath.Dir(absPath)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	var mdFiles []string
	for _, entry := range entries {
		if !entry.IsDir() && isMarkdownPath(entry.Name()) {
			full := filepath.Join(dir, entry.Name())
			a.allowFile(full)
			mdFiles = append(mdFiles, full)
		}
	}
	return mdFiles, nil
}

func isMarkdownPath(path string) bool {
	return strings.EqualFold(filepath.Ext(path), ".md")
}
