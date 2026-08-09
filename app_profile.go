package main

import (
	"errors"
	"time"

	"gxShell/backend/logger"
	"gxShell/backend/types"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// ListProfiles returns all server profiles with sanitized credentials.
func (a *App) ListProfiles() ([]types.Profile, error) {
	profiles, err := a.store.ListProfiles()
	if err != nil {
		return nil, err
	}
	return sanitizeProfiles(profiles), nil
}

// GetProfile returns a single profile by ID with sanitized credentials.
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

// CreateProfile creates a new server profile.
func (a *App) CreateProfile(profile types.Profile) (types.Profile, error) {
	a.profilesMu.Lock()
	defer a.profilesMu.Unlock()
	profiles, err := a.store.ListProfiles()
	if err != nil {
		return types.Profile{}, err
	}
	now := time.Now()
	profile.ID = types.NewID("profile")
	profile.CreatedAt = now
	profile.UpdatedAt = now
	normalizeProfile(&profile)
	if err := validateProfileCliSettings(profile, profiles); err != nil {
		return types.Profile{}, err
	}
	trustChanged := cliTrustNeedsConfirmation(types.Profile{}, profile, now)
	if trustChanged && !a.confirmCliProfileTrust(profile) {
		return types.Profile{}, errors.New("CLI full-trust activation was not confirmed")
	}
	if err := a.saveProfileSecrets(&profile); err != nil {
		return types.Profile{}, err
	}
	profiles = append(profiles, profile)
	if err := a.store.SaveProfiles(profiles); err != nil {
		return types.Profile{}, err
	}
	if trustChanged {
		a.logCliTrustEnabled(profile)
	}
	return sanitizeProfile(profile), nil
}

// UpdateProfile updates an existing server profile.
func (a *App) UpdateProfile(profile types.Profile) (types.Profile, error) {
	a.profilesMu.Lock()
	defer a.profilesMu.Unlock()
	return a.updateProfileLocked(profile)
}

// updateProfileLocked is UpdateProfile's body for callers that already hold
// profilesMu around a larger read-modify-write cycle (tunnel rule persistence).
func (a *App) updateProfileLocked(profile types.Profile) (types.Profile, error) {
	profiles, err := a.store.ListProfiles()
	if err != nil {
		return types.Profile{}, err
	}
	for i := range profiles {
		if profiles[i].ID == profile.ID {
			previous := profiles[i]
			if profile.RememberPassword && profile.Password == "" {
				profile.Password = profiles[i].Password
			}
			if profile.RememberPassword && profile.PrivateKeyPassphrase == "" {
				profile.PrivateKeyPassphrase = profiles[i].PrivateKeyPassphrase
			}
			profile.CreatedAt = profiles[i].CreatedAt
			profile.UpdatedAt = time.Now()
			normalizeProfile(&profile)
			if err := validateProfileCliSettings(profile, profiles); err != nil {
				return types.Profile{}, err
			}
			trustChanged := cliTrustNeedsConfirmation(previous, profile, time.Now())
			if trustChanged && !a.confirmCliProfileTrust(profile) {
				return types.Profile{}, errors.New("CLI full-trust activation was not confirmed")
			}
			if err := a.saveProfileSecrets(&profile); err != nil {
				return types.Profile{}, err
			}
			profiles[i] = profile
			if err := a.store.SaveProfiles(profiles); err != nil {
				return types.Profile{}, err
			}
			if trustChanged {
				a.logCliTrustEnabled(profile)
			}
			return sanitizeProfile(profile), nil
		}
	}
	return types.Profile{}, errors.New("profile not found")
}

func (a *App) logCliTrustEnabled(profile types.Profile) {
	if a.log == nil {
		return
	}
	a.log.InfoFields("CLI full trust enabled", logger.LogFields{
		"profileID": profile.ID,
		"alias":     profile.CliAlias,
		"trustUntil": profile.CliTrustUntil.UTC().Format(time.RFC3339Nano),
	})
}

// confirmCliProfileTrust is the backend consent boundary for enabling or
// extending prompt-free CLI access. Keeping it here means a compromised
// renderer cannot bypass the warning by calling UpdateProfile directly.
func (a *App) confirmCliProfileTrust(profile types.Profile) bool {
	if a.cliTrustConfirmFn != nil {
		return a.cliTrustConfirmFn(profile)
	}
	ctx := a.ctx.Get()
	if ctx == nil {
		return false
	}
	zh := false
	if settings, err := a.store.GetSettings(); err == nil {
		zh = settings.Language == "zh-CN"
	}
	alias := profile.CliAlias
	until := profile.CliTrustUntil.Local().Format("2006-01-02 15:04:05")
	title := "Enable time-limited CLI full trust?"
	message := "Until " + until + ", any process that has the local gxShell CLI token can perform write operations on " + alias + " without another prompt.\n\n" +
		"Commands may use registered named secrets. A malicious command can encode and exfiltrate those values despite output redaction. Catastrophic-command and sensitive-path blocks remain enabled, but they are a limited last line of defence, not a sandbox.\n\nEnable full trust for this server?"
	if zh {
		title = "开启限时 CLI 完全信任？"
		message = "在 " + until + " 前，任何持有本机 gxShell CLI token 的进程都可以在 " + alias + " 上无提示执行写操作。\n\n" +
			"命令可以使用已经登记的命名 secret；恶意命令仍可能编码并外泄这些值，输出脱敏无法完全阻止。灾难性命令和敏感路径硬拦截仍然生效，但它们只是有限的最后防线，不是沙箱。\n\n是否为这台服务器开启完全信任？"
	}
	a.nativeDialogMu.Lock()
	defer a.nativeDialogMu.Unlock()
	res, err := runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
		Type:          runtime.QuestionDialog,
		Title:         title,
		Message:       message,
		Buttons:       []string{"Yes", "No"},
		DefaultButton: "No",
		CancelButton:  "No",
	})
	if err != nil {
		if a.log != nil {
			a.log.ErrorFields("CLI full-trust warning dialog failed", logger.LogFields{"error": err.Error()})
		}
		return false
	}
	return res == "Yes"
}

// RevokeCliTrust immediately blocks new prompt-free requests for one profile.
// Commands and jobs that already passed authorization continue running.
func (a *App) RevokeCliTrust(profileID string) error {
	a.profilesMu.Lock()
	defer a.profilesMu.Unlock()
	profiles, err := a.store.ListProfiles()
	if err != nil {
		return err
	}
	for i := range profiles {
		if profiles[i].ID != profileID {
			continue
		}
		profiles[i].CliTrustUntil = time.Time{}
		profiles[i].UpdatedAt = time.Now()
		if err := a.store.SaveProfiles(profiles); err != nil {
			return err
		}
		if a.log != nil {
			a.log.InfoFields("CLI full trust revoked", logger.LogFields{"profileID": profileID, "alias": profiles[i].CliAlias})
		}
		return nil
	}
	return errors.New("profile not found")
}

// DeleteProfile deletes a server profile and clears references.
func (a *App) DeleteProfile(id string) error {
	a.profilesMu.Lock()
	defer a.profilesMu.Unlock()
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

// DuplicateProfile creates a copy of an existing profile.
func (a *App) DuplicateProfile(id string) (types.Profile, error) {
	profile, err := a.GetProfile(id)
	if err != nil {
		return types.Profile{}, err
	}
	profile.ID = ""
	profile.Name = profile.Name + " Copy"
	// Trust is an explicit local, time-bound consent and never follows a copy.
	profile.CliTrustUntil = time.Time{}
	// GetProfile never exposes credentials. Keeping RememberPassword=true on a
	// copy would therefore create a misleading profile that claims to have a
	// saved secret but cannot connect without prompting. Copies deliberately
	// start with credential saving disabled and can be opted in after re-entry.
	profile.RememberPassword = false
	return a.CreateProfile(profile)
}

// SelectPrivateKey opens a file dialog to select an SSH private key.
func (a *App) SelectPrivateKey() (string, error) {
	return runtime.OpenFileDialog(a.ctx.Get(), runtime.OpenDialogOptions{
		Title: "Select private key",
	})
}
