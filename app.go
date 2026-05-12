package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	osruntime "runtime"
	"strings"
	"time"

	"gxShell/backend/config"
	"gxShell/backend/logger"
	"gxShell/backend/monitor"
	"gxShell/backend/secrets"
	sftpmanager "gxShell/backend/sftp"
	sshmanager "gxShell/backend/ssh"
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
	a.migrateSecrets()
	a.log.Info("gxShell started")
}

func (a *App) domReady(ctx context.Context) {
	a.ctx = ctx
	runtime.WindowCenter(ctx)
}

func (a *App) shutdown(ctx context.Context) {
	a.ssh.Shutdown()
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
	profile.ID = newID("profile")
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
	settings, settingsErr := a.store.GetSettings()
	if settingsErr != nil {
		a.log.Error("failed to read settings: " + settingsErr.Error())
		settings = config.DefaultSettings()
	}
	info, err := a.ssh.Connect(fullProfile, settings.ConnectionTimeout, cols, rows)
	if err != nil {
		a.log.Error("connect failed: " + err.Error())
		return info, err
	}
	a.touchProfile(profileID)
	if settings.MonitorEnabled {
		a.monitor.Start(info.ID, settings.MonitorIntervalSec)
	}
	return info, nil
}

func (a *App) Disconnect(sessionID string) error {
	a.monitor.Stop(sessionID)
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
	command.ID = newID("cmd")
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
	return settings, a.store.SaveSettings(settings)
}

func (a *App) ReadLogs(limit int) []types.LogEntry {
	return a.log.ReadLatest(limit)
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

func newID(prefix string) string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%s-%d-%s", prefix, time.Now().UnixNano(), hex.EncodeToString(b))
}
