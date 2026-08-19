package app

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
	a.log.InfoFields("CLI automation trust enabled", logger.LogFields{
		"profileID":  profile.ID,
		"alias":      profile.CliAlias,
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
	title := "Enable time-limited CLI automation trust?"
	message := "Until " + until + ", processes with the local gxShell CLI token may run T1 scoped, recoverable changes on " + alias + " without another prompt. T2 and T3 commands still require native approval, and every T3 command is confirmed separately. Trusted remote-to-remote copies may also skip their prompt.\n\n" +
		"Scripts, build tools, and interpreters can run arbitrary code, so this classifier is not a sandbox. Only enable automation trust for a controlled workflow whose code and dependencies you accept. Local file transfers, secret changes, and tunnels still require confirmation.\n\nEnable automation trust for this server?"
	if zh {
		title = "开启限时 CLI 自动化信任？"
		message = "在 " + until + " 前，持有本机 gxShell CLI token 的进程可以在 " + alias + " 上无提示执行 T1 级、范围明确且可恢复的变更。T2 和 T3 命令仍需原生框授权，每条 T3 命令都必须单独确认。受信任服务器之间的远程复制也可以跳过确认。\n\n" +
			"脚本、构建工具和解释器都能执行任意代码，风险分类器不是沙箱。只有在你认可工作流代码及依赖时才开启自动化信任。本地文件传输、secret 变更和隧道仍需确认。\n\n是否为这台服务器开启自动化信任？"
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
			a.log.InfoFields("CLI automation trust revoked", logger.LogFields{"profileID": profileID, "alias": profiles[i].CliAlias})
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
