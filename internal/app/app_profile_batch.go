package app

import (
	"fmt"
	"strings"
	"time"

	"gxShell/backend/types"
)

// UpdateProfilesBatch applies explicit non-secret fields in one atomic store
// write. It never rewrites credentials or grants CLI access/trust.
func (a *App) UpdateProfilesBatch(ids []string, patch types.ProfileBatchPatch) ([]types.Profile, error) {
	if len(ids) == 0 || len(ids) > 500 {
		return nil, fmt.Errorf("select between 1 and 500 profiles")
	}
	if patch.Port != nil && (*patch.Port < 1 || *patch.Port > 65535) {
		return nil, fmt.Errorf("port must be between 1 and 65535")
	}
	if patch.Username != nil && (strings.TrimSpace(*patch.Username) == "" || len(*patch.Username) > 256 || strings.ContainsAny(*patch.Username, "\r\n\x00")) {
		return nil, fmt.Errorf("invalid username")
	}
	if patch.Group != nil && (len(*patch.Group) > 256 || strings.ContainsAny(*patch.Group, "\r\n\x00")) {
		return nil, fmt.Errorf("invalid group")
	}
	if patch.Group == nil && patch.Username == nil && patch.Port == nil && patch.AutoReconnect == nil && patch.Favorite == nil && !patch.InheritTerminal {
		return nil, fmt.Errorf("no changes selected")
	}
	a.profilesMu.Lock()
	defer a.profilesMu.Unlock()
	profiles, err := a.store.ListProfiles()
	if err != nil {
		return nil, err
	}
	selected := map[string]bool{}
	for _, id := range ids {
		selected[id] = true
	}
	now := time.Now()
	for i := range profiles {
		profile := &profiles[i]
		if !selected[profile.ID] {
			continue
		}
		delete(selected, profile.ID)
		if patch.Group != nil {
			profile.Group = strings.TrimSpace(*patch.Group)
		}
		if patch.Username != nil {
			profile.Username = strings.TrimSpace(*patch.Username)
		}
		if patch.Port != nil {
			profile.Port = *patch.Port
		}
		if patch.AutoReconnect != nil {
			profile.AutoReconnect = *patch.AutoReconnect
		}
		if patch.Favorite != nil {
			profile.Favorite = *patch.Favorite
		}
		if patch.InheritTerminal {
			profile.Terminal = nil
		}
		profile.UpdatedAt = now
	}
	if len(selected) != 0 {
		return nil, fmt.Errorf("one or more selected profiles no longer exist; no changes saved")
	}
	if err := a.store.SaveProfiles(profiles); err != nil {
		return nil, err
	}
	return sanitizeProfiles(profiles), nil
}
