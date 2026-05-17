package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	osruntime "runtime"
	"strings"
	"sync"
	"time"

	"gxShell/backend/ai"
	"gxShell/backend/config"
	"gxShell/backend/docker"
	"gxShell/backend/localfs"
	"gxShell/backend/logger"
	"gxShell/backend/monitor"
	"gxShell/backend/network"
	"gxShell/backend/secrets"
	sftpmanager "gxShell/backend/sftp"
	sshmanager "gxShell/backend/ssh"
	"gxShell/backend/tunnel"
	"gxShell/backend/types"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx     context.Context
	store   *config.Store
	log     *logger.Logger
	ssh     *sshmanager.Manager
	sftp    *sftpmanager.Manager
	monitor *monitor.Manager
	secrets *secrets.Store
	net     *network.Manager
	tunnels *tunnel.Manager
	ai      *ai.Manager
	docker  *docker.Manager
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	store, err := config.NewStore()
	if err != nil {
		runtime.LogError(ctx, "failed to create config store: "+err.Error())
		runtime.Quit(ctx)
		return
	}
	a.store = store
	a.log = logger.New(store.DataDir())
	a.secrets = secrets.NewStore(a.store.DataDir())
	emit := func(event string, data any) {
		if a.ctx != nil {
			runtime.EventsEmit(a.ctx, event, data)
		}
	}
	confirm := func(host string, fingerprint string) bool {
	        if a.ctx == nil {
	                return false
	        }
	        res, _ := runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
	                Type:          runtime.QuestionDialog,
	                Title:         "Unknown Host Key",
	                Message:       fmt.Sprintf("The host key for %s is unknown.\nFingerprint: %s\n\nDo you want to trust this host and continue connecting?", host, fingerprint),
	                DefaultButton: "No",
	        })
	        return res == "Yes"
	}
	a.ssh = sshmanager.NewManager(filepath.Join(store.DataDir(), "known_hosts"), emit, confirm)       
	a.sftp = sftpmanager.NewManager(a.ssh, emit)
	a.monitor = monitor.NewManager(a.ssh, emit)
	a.net = network.NewManager(emit)
	a.net.SetLogDebug(func(format string, args ...any) {
		a.log.Info(fmt.Sprintf(format, args...))
	})
	a.tunnels = tunnel.NewManager(emit)
	a.ai = ai.NewManager()
	a.docker = docker.NewManager(a.ssh)
	a.docker.SetEmit(emit)
	if settings, err := a.store.GetSettings(); err == nil {
		a.ai.UpdateConfig(ai.Config{
			Provider: ai.Provider(settings.Ai.Provider),
			APIKey:   settings.Ai.APIKey,
			Endpoint: settings.Ai.Endpoint,
			Model:    settings.Ai.Model,
		})
	}
	a.migrateSecrets()
	a.log.Info("gxShell started")
}

func (a *App) domReady(ctx context.Context) {
	a.ctx = ctx
	runtime.WindowCenter(ctx)
}

func (a *App) shutdown(ctx context.Context) {
	a.ssh.Shutdown()
	a.net.StopAll()
	a.log.Info("gxShell stopped")
}

func (a *App) GetAppInfo() map[string]string {
	return map[string]string{
		"name":    "gxShell",
		"version": "1.0",
		"dataDir": a.store.DataDir(),
	}
}

func (a *App) ListProfiles() ([]types.Profile, error) {
	profiles, err := a.store.ListProfiles()
	if err != nil {
		return nil, err
	}
	return sanitizeProfiles(profiles), nil
}

func (a *App) GetProfile(id string) (types.Profile, error) {
	profiles, err := a.store.ListProfiles()
	if err != nil {
		return types.Profile{}, err
	}
	for _, profile := range profiles {
		if profile.ID == id {
			return sanitizeProfile(profile), nil
		}
	}
	return types.Profile{}, errors.New("profile not found")
}

func (a *App) CreateProfile(profile types.Profile) (types.Profile, error) {
	profiles, err := a.store.ListProfiles()
	if err != nil {
		return types.Profile{}, err
	}
	now := time.Now()
	profile.ID = types.NewID("profile")
	profile.CreatedAt = now
	profile.UpdatedAt = now
	normalizeProfile(&profile)
	if err := a.saveProfileSecrets(&profile); err != nil {
		return types.Profile{}, err
	}
	profiles = append(profiles, profile)
	if err := a.store.SaveProfiles(profiles); err != nil {
		return types.Profile{}, err
	}
	return sanitizeProfile(profile), nil
}

func (a *App) UpdateProfile(profile types.Profile) (types.Profile, error) {
	profiles, err := a.store.ListProfiles()
	if err != nil {
		return types.Profile{}, err
	}
	for i := range profiles {
		if profiles[i].ID == profile.ID {
			if profile.RememberPassword && profile.Password == "" {
				profile.Password = profiles[i].Password
			}
			if profile.RememberPassword && profile.PrivateKeyPassphrase == "" {
				profile.PrivateKeyPassphrase = profiles[i].PrivateKeyPassphrase
			}
			profile.CreatedAt = profiles[i].CreatedAt
			profile.UpdatedAt = time.Now()
			normalizeProfile(&profile)
			if err := a.saveProfileSecrets(&profile); err != nil {
				return types.Profile{}, err
			}
			profiles[i] = profile
			if err := a.store.SaveProfiles(profiles); err != nil {
				return types.Profile{}, err
			}
			return sanitizeProfile(profile), nil
		}
	}
	return types.Profile{}, errors.New("profile not found")
}

func (a *App) DeleteProfile(id string) error {
	profiles, err := a.store.ListProfiles()
	if err != nil {
		return err
	}
	next := profiles[:0]
	found := false
	for _, profile := range profiles {
		if profile.ID != id {
			if profile.ProxyJumpID == id {
				profile.ProxyJumpID = ""
			}
			next = append(next, profile)
		} else {
			found = true
		}
	}
	if found {
		a.secrets.Delete(id)
	}
	return a.store.SaveProfiles(next)
}

func (a *App) DuplicateProfile(id string) (types.Profile, error) {
	profile, err := a.GetProfile(id)
	if err != nil {
		return types.Profile{}, err
	}
	profile.ID = ""
	profile.Name = profile.Name + " Copy"
	return a.CreateProfile(profile)
}

func (a *App) Connect(profileID string, cols int, rows int) (types.SessionInfo, error) {
	return a.ConnectWithSecrets(profileID, "", "", cols, rows)
}

func (a *App) ConnectWithSecrets(profileID string, password string, privateKeyPassphrase string, cols int, rows int) (types.SessionInfo, error) {
	fullProfile, err := a.getProfileForConnect(profileID)
	if err != nil {
		return types.SessionInfo{}, err
	}
	if fullProfile.RememberPassword {
		if err := a.loadProfileSecrets(&fullProfile); err != nil {
			return types.SessionInfo{}, err
		}
	}
	if password != "" {
		fullProfile.Password = password
	}
	if privateKeyPassphrase != "" {
		fullProfile.PrivateKeyPassphrase = privateKeyPassphrase
	}

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
		if jumpProfile.ProxyJumpID != "" {
			return types.SessionInfo{}, errors.New("nested proxy jump is not supported")
		}
	}

	settings, settingsErr := a.store.GetSettings()
	if settingsErr != nil {
		a.log.Error("failed to read settings: " + settingsErr.Error())
		settings = config.DefaultSettings()
	}
	info, err := a.ssh.ConnectViaJump(fullProfile, jumpProfile, settings.ConnectionTimeout, cols, rows)
	if err != nil {
		a.log.Error("connect failed: " + err.Error())
		return info, err
	}
	a.touchProfile(profileID)
	if settings.MonitorEnabled {
		a.monitor.Start(info.ID, settings.MonitorIntervalSec)
	}
	if len(fullProfile.Tunnels) > 0 {
		client, clientErr := a.ssh.Client(info.ID)
		if clientErr == nil {
			statuses := a.tunnels.StartTunnels(info.ID, client, fullProfile.Tunnels)
			_ = statuses
		}
	}
	return info, nil
}

func (a *App) Disconnect(sessionID string) error {
	a.monitor.Stop(sessionID)
	a.sftp.InvalidateClient(sessionID)
	a.tunnels.StopTunnels(sessionID)
	a.net.StopPing(sessionID)
	return a.ssh.Disconnect(sessionID)
}

func (a *App) Reconnect(sessionID string) (types.SessionInfo, error) {
	return a.ReconnectWithSecrets(sessionID, "", "")
}

func (a *App) ReconnectWithSecrets(sessionID string, password string, privateKeyPassphrase string) (types.SessionInfo, error) {
	old, err := a.ssh.Get(sessionID)
	if err != nil {
		return types.SessionInfo{}, err
	}
	_ = a.Disconnect(sessionID)
	return a.ConnectWithSecrets(old.ProfileID, password, privateKeyPassphrase, old.Cols, old.Rows)
}

func (a *App) WriteToTerminal(sessionID string, data string) error {
	return a.ssh.Write(sessionID, data)
}

func (a *App) ResizeTerminal(sessionID string, cols int, rows int) error {
	return a.ssh.Resize(sessionID, cols, rows)
}

func (a *App) ListSessions() []types.SessionInfo {
	return a.ssh.List()
}

func (a *App) SendCommandToTerminal(sessionID string, command string) error {
	if !strings.HasSuffix(command, "\n") {
		command += "\n"
	}
	return a.ssh.Write(sessionID, command)
}

func (a *App) ListRemoteDir(sessionID string, remotePath string) ([]types.RemoteFile, error) {
	return a.sftp.ListRemoteDir(sessionID, remotePath)
}

func (a *App) UploadFile(sessionID, localPath, remotePath string) error {
	return a.sftp.UploadFile(sessionID, localPath, remotePath)
}

func (a *App) DownloadFile(sessionID, remotePath, localPath string) error {
	return a.sftp.DownloadFile(sessionID, remotePath, localPath)
}

func (a *App) DownloadFolder(sessionID, remotePath, localDir string) error {
	return a.sftp.DownloadFolder(sessionID, remotePath, localDir)
}

func (a *App) DeleteRemoteFile(sessionID, remotePath string) error {
	return a.sftp.DeleteRemoteFile(sessionID, remotePath)
}

func (a *App) RenameRemoteFile(sessionID, oldPath, newPath string) error {
	return a.sftp.RenameRemoteFile(sessionID, oldPath, newPath)
}

func (a *App) CreateRemoteDir(sessionID, remotePath string) error {
	return a.sftp.CreateRemoteDir(sessionID, remotePath)
}

func (a *App) StartMonitor(sessionID string) error {
	settings, err := a.store.GetSettings()
	if err != nil {
		a.log.Error("failed to read settings: " + err.Error())
		settings = config.DefaultSettings()
	}
	a.monitor.Start(sessionID, settings.MonitorIntervalSec)
	return nil
}

func (a *App) StopMonitor(sessionID string) error {
	a.monitor.Stop(sessionID)
	return nil
}

func (a *App) GetLatestMetrics(sessionID string) types.Metrics {
	return a.monitor.Latest(sessionID)
}

func (a *App) ListCommands() ([]types.CommandTemplate, error) {
	return a.store.ListCommands()
}

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

func (a *App) GetSettings() (types.AppSettings, error) {
	return a.store.GetSettings()
}

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
			APIKey:   aiCfg.APIKey,
			Endpoint: aiCfg.Endpoint,
			Model:    aiCfg.Model,
		}
	}
	return settings, a.store.SaveSettings(settings)
}

func (a *App) ReadLogs(limit int) []types.LogEntry {
	return a.log.ReadLatest(limit)
}

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

func (a *App) ReadLogFile(name string) (string, error) {
	logDir := filepath.Join(a.store.DataDir(), "logs")
	cleanName := filepath.Base(name)
	path := filepath.Join(logDir, cleanName)
	absPath, err := filepath.Abs(path)
	if err != nil || !strings.HasPrefix(absPath, filepath.Clean(logDir)+string(os.PathSeparator)) {
		return "", fmt.Errorf("invalid log file path")
	}
	data, err := os.ReadFile(absPath)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

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

func (a *App) LogCommand(sessionID string, line string) {
	host := ""
	if session, err := a.ssh.Get(sessionID); err == nil {
		host = session.Name
	}
	a.log.LogCommand(sessionID, host, line)
}

func (a *App) ExportHistory() error {
	return a.log.OpenHistory()
}

func (a *App) SelectPrivateKey() (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select private key",
	})
}

func (a *App) SelectUploadFile() (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select file to upload",
	})
}

func (a *App) SelectDownloadPath(defaultName string) (string, error) {
	return runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Save downloaded file",
		DefaultFilename: filepath.Base(defaultName),
	})
}

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

func (a *App) migrateSecrets() {
	profiles, err := a.store.ListProfiles()
	if err != nil {
		return
	}
	changed := false
	for i := range profiles {
		if profiles[i].RememberPassword && (profiles[i].Password != "" || profiles[i].PrivateKeyPassphrase != "") {
			if err := a.saveProfileSecrets(&profiles[i]); err == nil {
				changed = true
			}
		}
		if !profiles[i].RememberPassword && (profiles[i].Password != "" || profiles[i].PrivateKeyPassphrase != "") {
			profiles[i].Password = ""
			profiles[i].PrivateKeyPassphrase = ""
			changed = true
		}
	}
	if changed {
		_ = a.store.SaveProfiles(profiles)
	}
	a.store.CleanupBackups()
}

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
}

func sanitizeProfiles(profiles []types.Profile) []types.Profile {
	out := make([]types.Profile, len(profiles))
	for i, profile := range profiles {
		out[i] = sanitizeProfile(profile)
	}
	return out
}

func sanitizeProfile(profile types.Profile) types.Profile {
	profile.Password = ""
	profile.PrivateKeyPassphrase = ""
	return profile
}

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
	a.net.StartPing(client, profile.Host, intervalSec)
	return nil
}

func (a *App) StopNetworkPing(sessionID string) {
	info, err := a.ssh.Get(sessionID)
	if err != nil {
		return
	}
	profile, err := a.getProfileForConnect(info.ProfileID)
	if err != nil {
		return
	}
	a.net.StopPing(profile.Host)
}

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

func (a *App) ListTunnelStatus(sessionID string) []types.TunnelStatus {
	return a.tunnels.ListStatus(sessionID)
}

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

func (a *App) ListLocalDir(dir string) ([]types.LocalFile, error) {
	return localfs.ListDir(dir)
}

func (a *App) LocalHomeDir() string {
	return localfs.HomeDir()
}

func (a *App) SaveAiConfig(provider, apiKey, endpoint, model string) error {
	if strings.Contains(apiKey, "****") {
		existing := a.ai.GetConfig()
		apiKey = existing.APIKey
	}
	a.log.Info(fmt.Sprintf("SaveAiConfig: provider=%q model=%q endpoint=%q apiKeyLen=%d", provider, model, endpoint, len(apiKey)))
	a.ai.UpdateConfig(ai.Config{
		Provider: ai.Provider(provider),
		APIKey:   apiKey,
		Endpoint: endpoint,
		Model:    model,
	})
	verifyCfg := a.ai.GetConfig()
	a.log.Info(fmt.Sprintf("SaveAiConfig memory verify: provider=%q model=%q endpoint=%q", verifyCfg.Provider, verifyCfg.Model, verifyCfg.Endpoint))
	settings, err := a.store.GetSettings()
	if err != nil {
		a.log.Error("SaveAiConfig: failed to read settings: " + err.Error())
		return err
	}
	settings.Ai = types.AiConfig{
		Provider: provider,
		APIKey:   apiKey,
		Endpoint: endpoint,
		Model:    model,
	}
	if err := a.store.SaveSettings(settings); err != nil {
		a.log.Error("SaveAiConfig: failed to save settings: " + err.Error())
		return err
	}
	a.log.Info("SaveAiConfig: saved to file successfully")
	return nil
}

func (a *App) GetAiConfig() types.AiConfig {
	cfg := a.ai.GetConfig()
	maskedKey := ""
	if cfg.APIKey != "" {
		if len(cfg.APIKey) > 8 {
			maskedKey = cfg.APIKey[:4] + "****" + cfg.APIKey[len(cfg.APIKey)-4:]
		} else {
			maskedKey = "****"
		}
	}
	return types.AiConfig{
		Provider: string(cfg.Provider),
		APIKey:   maskedKey,
		Endpoint: cfg.Endpoint,
		Model:    cfg.Model,
	}
}

func (a *App) AiChat(req types.AiChatRequest) error {
	cfg := a.ai.GetConfig()
	a.log.Info(fmt.Sprintf("AI chat request: provider=%s model=%s endpoint=%s msgs=%d contextLen=%d", cfg.Provider, cfg.Model, cfg.Endpoint, len(req.Messages), len(req.Context)))

	go func() {
		aiReq := ai.ChatRequest{
			Messages: make([]ai.Message, len(req.Messages)),
			Context:  req.Context,
		}
		for i, m := range req.Messages {
			aiReq.Messages[i] = ai.Message{Role: m.Role, Content: m.Content}
		}
		if len(aiReq.Messages) > 0 {
			lastMsg := aiReq.Messages[len(aiReq.Messages)-1]
			a.log.Info(fmt.Sprintf("AI chat last msg: role=%s contentLen=%d contentPreview=%q", lastMsg.Role, len(lastMsg.Content), truncate(lastMsg.Content, 200)))
		}
		err := a.ai.Chat(aiReq, func(resp ai.ChatResponse) {
			if a.ctx != nil {
				event := map[string]any{
					"content":          resp.Content,
					"finish":           resp.Finish,
					"promptTokens":     resp.PromptTk,
					"completionTokens": resp.CompleteTk,
				}
				if resp.ReasoningContent != "" {
					event["reasoningContent"] = resp.ReasoningContent
				}
				if len(resp.ToolCalls) > 0 {
					tcData := make([]map[string]any, len(resp.ToolCalls))
					for i, tc := range resp.ToolCalls {
						tcData[i] = map[string]any{
							"id":   tc.ID,
							"type": tc.Type,
							"function": map[string]any{
								"name":      tc.Function.Name,
								"arguments": tc.Function.Arguments,
							},
						}
					}
					event["toolCalls"] = tcData
				}
				runtime.EventsEmit(a.ctx, "ai:chunk", event)
			}
		})
		if err != nil && a.ctx != nil {
			a.log.Error("AI chat error: " + err.Error())
			runtime.EventsEmit(a.ctx, "ai:error", map[string]any{"error": err.Error()})
		}
	}()
	return nil
}

func (a *App) AiExecuteTool(sessionID string, toolCallID string, toolName string, arguments string) string {
	a.log.Info(fmt.Sprintf("AI execute tool: session=%s tool=%s args=%s", sessionID, toolName, truncate(arguments, 200)))

	var output string
	switch toolName {
	case "execute_command":
		var args struct {
			Command string `json:"command"`
		}
		if err := json.Unmarshal([]byte(arguments), &args); err != nil {
			output = "Error parsing command arguments: " + err.Error()
			break
		}
		if warn, blocked := checkDangerousCommand(args.Command); blocked {
			output = "BLOCKED: " + warn
			a.log.Error("AI tool blocked dangerous command: " + args.Command)
			break
		}
		result, err := a.ssh.ExecuteCommand(sessionID, args.Command)
		if err != nil {
			output = "Error executing command: " + err.Error()
		} else {
			if result == "" {
				output = "(command produced no output)"
			} else {
				output = result
			}
		}
		a.log.Info(fmt.Sprintf("AI tool result: tool=%s outputLen=%d", toolName, len(output)))

	case "read_file":
		var args struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal([]byte(arguments), &args); err != nil {
			output = "Error parsing file path arguments: " + err.Error()
			break
		}
		if warn, blocked := checkSensitivePath(args.Path); blocked {
			output = "BLOCKED: " + warn
			a.log.Error("AI tool blocked sensitive file read: " + args.Path)
			break
		}
		cmd := "cat " + shellescape(args.Path)
		result, err := a.ssh.ExecuteCommand(sessionID, cmd)
		if err != nil {
			output = "Error reading file: " + err.Error()
		} else {
			if result == "" {
				output = "(file is empty)"
			} else {
				output = result
			}
		}
		a.log.Info(fmt.Sprintf("AI tool result: tool=%s path=%s outputLen=%d", toolName, args.Path, len(output)))

	default:
		output = "Unknown tool: " + toolName
	}

	return output
}

func (a *App) AiContinueChat(req types.AiChatRequest) error {
	a.log.Info(fmt.Sprintf("AI continue chat: msgs=%d", len(req.Messages)))

	go func() {
		aiReq := ai.ChatRequest{
			Messages: make([]ai.Message, len(req.Messages)),
			Context:  req.Context,
		}
		for i, m := range req.Messages {
			aiReq.Messages[i] = ai.Message{
				Role:             m.Role,
				Content:          m.Content,
				ReasoningContent: m.ReasoningContent,
				ToolCallID:       m.ToolCallID,
			}
			for _, tc := range m.ToolCalls {
				aiReq.Messages[i].ToolCalls = append(aiReq.Messages[i].ToolCalls, ai.ToolCall{
					ID:   tc.ID,
					Type: tc.Type,
					Function: ai.FunctionCall{
						Name:      tc.Function.Name,
						Arguments: tc.Function.Arguments,
					},
				})
			}
		}

		err := a.ai.Chat(aiReq, func(resp ai.ChatResponse) {
			if a.ctx != nil {
				event := map[string]any{
					"content":          resp.Content,
					"finish":           resp.Finish,
					"promptTokens":     resp.PromptTk,
					"completionTokens": resp.CompleteTk,
				}
				if resp.ReasoningContent != "" {
					event["reasoningContent"] = resp.ReasoningContent
				}
				if len(resp.ToolCalls) > 0 {
					tcData := make([]map[string]any, len(resp.ToolCalls))
					for i, tc := range resp.ToolCalls {
						tcData[i] = map[string]any{
							"id":   tc.ID,
							"type": tc.Type,
							"function": map[string]any{
								"name":      tc.Function.Name,
								"arguments": tc.Function.Arguments,
							},
						}
					}
					event["toolCalls"] = tcData
				}
				runtime.EventsEmit(a.ctx, "ai:chunk", event)
			}
		})
		if err != nil && a.ctx != nil {
			a.log.Error("AI continue chat error: " + err.Error())
			runtime.EventsEmit(a.ctx, "ai:error", map[string]any{"error": err.Error()})
		}
	}()
	return nil
}

func (a *App) GetAiUsage() types.AiTokenUsage {
	u := a.ai.GetUsage()
	return types.AiTokenUsage{
		PromptTokens:     u.PromptTokens,
		CompletionTokens: u.CompletionTokens,
		TotalTokens:      u.TotalTokens,
	}
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

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

func (a *App) ResetAiUsage() {
	a.ai.ResetUsage()
}

func (a *App) ListAiModels(provider, apiKey, endpoint string) ([]string, error) {
	if strings.Contains(apiKey, "****") {
		apiKey = a.ai.GetConfig().APIKey
	}
	return a.ai.ListModels(ai.Config{
		Provider: ai.Provider(provider),
		APIKey:   apiKey,
		Endpoint: endpoint,
	})
}

func (a *App) ListContainers(sessionID string, all bool) ([]types.ContainerInfo, error) {
	return a.docker.ListContainers(sessionID, all)
}

func (a *App) ContainerLogs(sessionID, containerID string, tail int) (string, error) {
	return a.docker.ContainerLogs(sessionID, containerID, tail)
}

func (a *App) StreamContainerLogs(sessionID, containerID string, tail int) error {
	return a.docker.StreamContainerLogs(sessionID, containerID, tail)
}

func (a *App) StopContainerLogs(sessionID, containerID string) {
	a.docker.StopContainerLogs(sessionID, containerID)
}

func (a *App) RestartContainer(sessionID, containerID string) error {
	return a.docker.RestartContainer(sessionID, containerID)
}

func (a *App) StopContainer(sessionID, containerID string) error {
	return a.docker.StopContainer(sessionID, containerID)
}

func (a *App) StartContainer(sessionID, containerID string) error {
	return a.docker.StartContainer(sessionID, containerID)
}

func (a *App) RemoveContainer(sessionID, containerID string, force bool) error {
	return a.docker.RemoveContainer(sessionID, containerID, force)
}

var dangerousCmdPatterns = []struct {
	pattern string
	reason  string
}{
	{`rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|/)`, "destructive rm command"},
	{`mkfs`, "filesystem format"},
	{`dd\s+`, "raw disk write"},
	{`:\(\)\{\s*:\|:\&\s*\}\s*;`, "fork bomb"},
	{`>\s*/dev/sd`, "direct disk write"},
	{`chmod\s+(-R\s+)?0?777\s+/`, "overly permissive chmod on root"},
	{`shutdown`, "system shutdown"},
	{`reboot`, "system reboot"},
	{`init\s+[06]`, "init to runlevel 0/6"},
	{`systemctl\s+(stop|disable)\s+(ssh|sshd|network|systemd)`, "stopping critical services"},
	{`iptables\s+-F`, "flushing firewall rules"},
	{`crontab\s+-r`, "removing crontab"},
	{`userdel`, "deleting user"},
	{`passwd\s+root`, "changing root password"},
	{`mv\s+.*\s*/dev/null`, "moving files to /dev/null"},
}

var dangerousCmdRegexps = sync.OnceValue(func() []struct {
	*regexp.Regexp
	reason string
} {
	result := make([]struct {
		*regexp.Regexp
		reason string
	}, len(dangerousCmdPatterns))
	for i, p := range dangerousCmdPatterns {
		result[i].Regexp = regexp.MustCompile(p.pattern)
		result[i].reason = p.reason
	}
	return result
})

func checkDangerousCommand(cmd string) (string, bool) {
	trimmed := strings.TrimSpace(cmd)
	base := trimmed
	if idx := strings.Index(trimmed, " "); idx > 0 {
		base = trimmed[:idx]
	}
	directDangerous := map[string]string{
		"mkfs": "filesystem format", "shutdown": "system shutdown", "reboot": "system reboot",
		"userdel": "deleting user", "fdisk": "disk partitioning",
	}
	if reason, ok := directDangerous[base]; ok {
		return reason, true
	}
	for _, dr := range dangerousCmdRegexps() {
		if dr.MatchString(cmd) {
			return dr.reason, true
		}
	}
	return "", false
}

var sensitivePaths = []struct {
	pattern string
	reason  string
}{
	{"/etc/shadow", "password hashes"},
	{"/etc/gshadow", "group password hashes"},
	{"/etc/ssh/ssh_host_", "SSH private host keys"},
	{"/root/.ssh/id_", "SSH private keys"},
	{"/home/", "user home SSH private keys"},
}

func checkSensitivePath(p string) (string, bool) {
	lower := strings.ToLower(p)
	for _, sp := range sensitivePaths {
		if strings.Contains(lower, strings.ToLower(sp.pattern)) {
			if sp.pattern == "/home/" {
				if strings.Contains(lower, "/.ssh/id_") && !strings.Contains(lower, ".pub") {
					return sp.reason, true
				}
				continue
			}
			return sp.reason, true
		}
	}
	return "", false
}


