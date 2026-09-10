package app

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
	"unicode/utf8"

	"gxShell/backend/ai"
	"gxShell/backend/config"
	"gxShell/backend/secrets"
	sshmanager "gxShell/backend/ssh"
	"gxShell/backend/types"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/crypto/pbkdf2"
)

const (
	backupFormat        = "gxShell-backup-v1"
	backupKDFRounds     = 210000
	backupSaltBytes     = 16
	backupMaxFileBytes  = 50 * 1024 * 1024
	backupMaxPlainBytes = 30 * 1024 * 1024
)

type backupPayload struct {
	Format         string                  `json:"format"`
	CreatedAt      time.Time               `json:"createdAt"`
	IncludesSecret bool                    `json:"includesSecrets"`
	Profiles       []types.Profile         `json:"profiles"`
	Settings       types.AppSettings       `json:"settings"`
	Commands       []types.CommandTemplate `json:"commands"`
	KnownHosts     string                  `json:"knownHosts"`
	Workspaces     string                  `json:"workspaces"`
	AiAPIKey       string                  `json:"aiApiKey,omitempty"`
	PrivateKeys    map[string][]byte       `json:"privateKeys,omitempty"`
	NamedSecrets   map[string]string       `json:"namedSecrets,omitempty"`
}

type backupEnvelope struct {
	Format     string `json:"format"`
	KDF        string `json:"kdf"`
	Iterations int    `json:"iterations"`
	Salt       string `json:"salt"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

type backupPreview struct {
	Token           string         `json:"token"`
	CreatedAt       time.Time      `json:"createdAt"`
	Profiles        int            `json:"profiles"`
	Commands        int            `json:"commands"`
	WorkspacesAdded int            `json:"workspacesAdded"`
	Skipped         int            `json:"skipped"`
	PrivateKeys     int            `json:"privateKeys"`
	NamedSecrets    int            `json:"namedSecrets"`
	KnownHosts      int            `json:"knownHosts"`
	Settings        bool           `json:"settings"`
	Workspaces      string         `json:"workspaces"`
	Warnings        []string       `json:"warnings"`
	Changes         []backupChange `json:"changes"`
}

type backupChange struct {
	Kind   string `json:"kind"`
	Name   string `json:"name"`
	Action string `json:"action"`
}

type backupPlan struct {
	preview            backupPreview
	before, after      map[string][]byte
	secrets            []secrets.Value
	settings           types.AppSettings
	aiKey              string
	previousWorkspaces string
	expires            time.Time
}

func readBackupFile(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errors.New("file is not regular or exceeds the size limit")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if len(data) > int(limit) {
		return nil, errors.New("file exceeds the size limit")
	}
	return data, err
}

func (a *App) ExportBackup(passphrase, workspaces string, includeSecrets, includePrivateKeys bool) (string, error) {
	if err := validateBackupPassphrase(passphrase); err != nil {
		return "", err
	}
	if (includeSecrets || includePrivateKeys) && !a.confirmEncryptedSecretExport() {
		return "", nil
	}
	payload, err := a.collectBackup(workspaces, includeSecrets, includePrivateKeys)
	if err != nil {
		return "", err
	}
	plain, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	envelope, err := encryptBackup(plain, passphrase)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(envelope)
	if err != nil {
		return "", err
	}
	if len(data) > backupMaxFileBytes {
		return "", errors.New("backup exceeds 50 MiB")
	}
	filePath, err := runtime.SaveFileDialog(a.ctx.Get(), runtime.SaveDialogOptions{Title: "Export gxShell backup", DefaultFilename: "gxShell-backup-" + time.Now().Format("20060102") + ".gxbak", Filters: backupFileFilters()})
	if err != nil || filePath == "" {
		return filePath, err
	}
	if filepath.Ext(filePath) == "" {
		filePath += ".gxbak"
	}
	file, err := os.CreateTemp(filepath.Dir(filePath), ".gxshell-backup-*")
	if err != nil {
		return "", err
	}
	tmp := file.Name()
	defer os.Remove(tmp)
	modeErr := file.Chmod(0600)
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	closeErr := file.Close()
	if err := errors.Join(modeErr, writeErr, syncErr, closeErr); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, filePath); err != nil {
		return "", err
	}
	return filePath, nil
}

func (a *App) collectBackup(workspaces string, includeSecrets, includePrivateKeys bool) (backupPayload, error) {
	if includeSecrets && a.secrets == nil {
		return backupPayload{}, errors.New("credential storage unavailable")
	}
	a.profilesMu.Lock()
	defer a.profilesMu.Unlock()
	var files map[string][]byte
	err := sshmanager.WithKnownHostsLock(func() error {
		var err error
		files, err = a.store.SnapshotFiles("profiles.json", "commands.json", "settings.json", "known_hosts")
		return err
	})
	if err != nil {
		return backupPayload{}, err
	}
	var profiles []types.Profile
	var commands []types.CommandTemplate
	var settings types.AppSettings
	if err := json.Unmarshal(files["profiles.json"], &profiles); err != nil {
		return backupPayload{}, err
	}
	if err := json.Unmarshal(files["commands.json"], &commands); err != nil {
		return backupPayload{}, err
	}
	if err := json.Unmarshal(files["settings.json"], &settings); err != nil {
		return backupPayload{}, err
	}
	settings = config.NormalizeSettings(settings)
	known := files["known_hosts"]
	payload := backupPayload{Format: backupFormat, CreatedAt: time.Now().UTC(), IncludesSecret: includeSecrets, Profiles: profiles, Settings: settings, Commands: commands, KnownHosts: string(known), Workspaces: workspaces, PrivateKeys: map[string][]byte{}}
	payload.Settings.Ai.APIKey = ""
	for i := range payload.Profiles {
		profile := &payload.Profiles[i]
		profile.CliTrustUntil = time.Time{}
		profile.Password, profile.PrivateKeyPassphrase = "", ""
		if includeSecrets && profile.RememberPassword {
			if err := a.loadProfileSecrets(profile); err != nil {
				return backupPayload{}, fmt.Errorf("read credentials for %s: %w", profile.Name, err)
			}
		} else {
			profile.RememberPassword = false
		}
		if includePrivateKeys && profile.AuthType == types.AuthPrivateKey {
			key, err := readBackupFile(profile.PrivateKeyPath, 1024*1024)
			if err != nil {
				return backupPayload{}, fmt.Errorf("read private key for %s: %w", profile.Name, err)
			}
			payload.PrivateKeys[profile.ID] = key
		}
	}
	if includeSecrets {
		if a.secrets == nil {
			return backupPayload{}, errors.New("credential storage unavailable")
		}
		payload.AiAPIKey, err = a.secrets.GetPassword(aiConfigSecretID)
		if err != nil {
			return backupPayload{}, err
		}
		payload.NamedSecrets, err = a.secrets.NamedValues(cliSecretNamespace)
		if err != nil {
			return backupPayload{}, err
		}
	}
	if err := validateBackup(&payload); err != nil {
		return backupPayload{}, err
	}
	return payload, nil
}

func backupFileFilters() []runtime.FileFilter {
	return []runtime.FileFilter{{DisplayName: "gxShell backup (*.gxbak)", Pattern: "*.gxbak"}}
}

func (a *App) confirmEncryptedSecretExport() bool {
	ctx := a.ctx.Get()
	if ctx == nil {
		return false
	}
	a.nativeDialogMu.Lock()
	defer a.nativeDialogMu.Unlock()
	res, err := runtime.MessageDialog(ctx, runtime.MessageDialogOptions{Type: runtime.QuestionDialog, Title: "Encrypted credential export", Message: "Include saved credentials or private key files in this encrypted backup? Anyone with the backup and its passphrase can use them.", Buttons: []string{"Yes", "No"}, DefaultButton: "No", CancelButton: "No"})
	return err == nil && res == "Yes"
}

// PreviewBackup keeps decrypted credentials inside the native process.
func (a *App) PreviewBackup(passphrase, workspaces, policy string, restoreSettings bool) (string, error) {
	a.backupMu.Lock()
	defer a.backupMu.Unlock()
	a.backupPending = nil
	if err := validateBackupPassphrase(passphrase); err != nil {
		return "", err
	}
	filePath, err := runtime.OpenFileDialog(a.ctx.Get(), runtime.OpenDialogOptions{Title: "Import gxShell backup", Filters: backupFileFilters()})
	if err != nil || filePath == "" {
		return "", err
	}
	data, err := readBackupFile(filePath, backupMaxFileBytes)
	if err != nil {
		return "", err
	}
	var envelope backupEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return "", errors.New("invalid backup envelope")
	}
	plain, err := decryptBackup(envelope, passphrase)
	if err != nil {
		return "", err
	}
	var payload backupPayload
	if err := json.Unmarshal(plain, &payload); err != nil {
		return "", errors.New("invalid backup content")
	}
	if err := validateBackup(&payload); err != nil {
		return "", err
	}
	plan, err := a.planBackup(payload, workspaces, policy, restoreSettings)
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(plan.preview)
	if err != nil {
		return "", err
	}
	a.backupPending = plan
	return string(encoded), nil
}

func (a *App) DiscardBackupPreview(token string) {
	a.backupMu.Lock()
	defer a.backupMu.Unlock()
	if a.backupPending != nil && a.backupPending.preview.Token == token {
		a.backupPending = nil
	}
}

func (a *App) ApplyBackup(token, previousWorkspaces string) error {
	a.backupMu.Lock()
	defer a.backupMu.Unlock()
	plan := a.backupPending
	if plan == nil || plan.preview.Token != token || time.Now().After(plan.expires) {
		a.backupPending = nil
		return errors.New("backup preview expired; preview again")
	}
	if previousWorkspaces != plan.previousWorkspaces {
		a.backupPending = nil
		return errors.New("workspaces changed since preview; preview again")
	}
	a.backupPending = nil
	a.profilesMu.Lock()
	defer a.profilesMu.Unlock()
	err := sshmanager.WithKnownHostsLock(func() error {
		commit := func() error { return a.store.ApplyMigration(plan.before, plan.after) }
		if len(plan.secrets) == 0 {
			return commit()
		}
		if a.secrets == nil {
			return errors.New("credential storage unavailable")
		}
		return a.secrets.ApplyMigration(plan.secrets, commit)
	})
	if err != nil {
		return err
	}
	if plan.preview.Settings {
		if a.ai != nil {
			cfg := plan.settings.Ai
			a.ai.UpdateConfig(ai.Config{Provider: ai.Provider(cfg.Provider), Endpoint: cfg.Endpoint, Model: cfg.Model, APIKey: plan.aiKey})
		}
		if a.monitor != nil {
			if !plan.settings.MonitorEnabled {
				a.monitor.StopAll()
			} else {
				a.monitor.RestartAll(plan.settings.MonitorIntervalSec)
				if a.ssh != nil {
					for _, session := range a.ssh.List() {
						if session.State == types.SessionConnected {
							a.monitor.Start(session.ID, plan.settings.MonitorIntervalSec)
						}
					}
				}
			}
		}
	}
	return nil
}

func validateBackupPassphrase(passphrase string) error {
	if !utf8.ValidString(passphrase) || utf8.RuneCountInString(passphrase) < 8 {
		return errors.New("backup passphrase must contain at least 8 characters")
	}
	if len(passphrase) > 1024 {
		return errors.New("backup passphrase is too long")
	}
	return nil
}

func encryptBackup(plain []byte, passphrase string) (backupEnvelope, error) {
	if len(plain) > backupMaxPlainBytes {
		return backupEnvelope{}, errors.New("backup content exceeds 30 MiB")
	}
	salt := make([]byte, backupSaltBytes)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return backupEnvelope{}, err
	}
	key := pbkdf2.Key([]byte(passphrase), salt, backupKDFRounds, 32, sha256.New)
	block, err := aes.NewCipher(key)
	if err != nil {
		return backupEnvelope{}, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return backupEnvelope{}, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return backupEnvelope{}, err
	}
	ciphertext := gcm.Seal(nil, nonce, plain, []byte(backupFormat))
	return backupEnvelope{Format: backupFormat, KDF: "PBKDF2-HMAC-SHA256", Iterations: backupKDFRounds, Salt: base64.RawStdEncoding.EncodeToString(salt), Nonce: base64.RawStdEncoding.EncodeToString(nonce), Ciphertext: base64.RawStdEncoding.EncodeToString(ciphertext)}, nil
}

func decryptBackup(envelope backupEnvelope, passphrase string) ([]byte, error) {
	if envelope.Format != backupFormat || envelope.KDF != "PBKDF2-HMAC-SHA256" || envelope.Iterations != backupKDFRounds {
		return nil, errors.New("unsupported backup encryption")
	}
	salt, err := base64.RawStdEncoding.DecodeString(envelope.Salt)
	if err != nil || len(salt) != backupSaltBytes {
		return nil, errors.New("invalid backup salt")
	}
	nonce, err := base64.RawStdEncoding.DecodeString(envelope.Nonce)
	if err != nil || len(nonce) != 12 {
		return nil, errors.New("invalid backup nonce")
	}
	if len(envelope.Ciphertext) > base64.RawStdEncoding.EncodedLen(backupMaxPlainBytes+16) {
		return nil, errors.New("backup content exceeds 30 MiB")
	}
	ciphertext, err := base64.RawStdEncoding.DecodeString(envelope.Ciphertext)
	if err != nil || len(ciphertext) < 16 {
		return nil, errors.New("invalid backup ciphertext")
	}
	key := pbkdf2.Key([]byte(passphrase), salt, envelope.Iterations, 32, sha256.New)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, nonce, ciphertext, []byte(backupFormat))
	if err != nil {
		return nil, errors.New("backup passphrase is incorrect or file is corrupt")
	}
	return plain, nil
}
