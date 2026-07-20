package main

import (
	"errors"
	"time"

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
	if err := a.saveProfileSecrets(&profile); err != nil {
		return types.Profile{}, err
	}
	profiles = append(profiles, profile)
	if err := a.store.SaveProfiles(profiles); err != nil {
		return types.Profile{}, err
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
