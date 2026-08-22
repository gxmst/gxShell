package app

// Profile helpers shared by the connection, tunnel and CLI bindings: lookup,
// secret save/load, normalization, sanitization, and small string utilities.

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"gxShell/backend/types"
)

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
	// Sanitized profiles intentionally round-trip with empty credential fields.
	// Treat those empty values as "keep the stored value", not "replace it with
	// empty". Clearing both credentials remains an explicit operation: turn off
	// RememberPassword. Non-empty fields replace only the supplied secret kind.
	if password != "" {
		if err := a.secrets.SavePassword(profile.ID, password); err != nil {
			return err
		}
	}
	if passphrase != "" {
		return a.secrets.SavePassphrase(profile.ID, passphrase)
	}
	return nil
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
	a.profilesMu.Lock()
	defer a.profilesMu.Unlock()
	profiles, err := a.store.ListProfiles()
	if err != nil {
		return
	}
	for i := range profiles {
		if profiles[i].ID == id {
			// Coalesce write churn: every CLI exec may connect, and rewriting
			// profiles.json for a timestamp that moved by seconds is disk noise.
			if time.Since(profiles[i].LastConnectedAt) < time.Minute {
				return
			}
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
	if !profile.CliEnabled {
		profile.CliTrustUntil = time.Time{}
	}
}

func validateProfileCliSettings(profile types.Profile, profiles []types.Profile) error {
	if !profile.CliEnabled {
		return nil
	}
	alias := strings.TrimSpace(profile.CliAlias)
	if alias == "" {
		return errors.New("CLI alias is required when access is enabled")
	}
	if profile.CliTrustUntil.After(time.Now().Add(24*time.Hour + time.Minute)) {
		return errors.New("CLI automation trust cannot be granted for more than 24 hours")
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

// validateProfileProxyJump keeps the stored graph within the one-hop contract
// implemented by Connect. A profile may either use a jump host or serve as one,
// but not both; accepting a longer chain here would save successfully and then
// fail only when the user tried to connect.
func validateProfileProxyJump(profile types.Profile, profiles []types.Profile) error {
	jumpID := strings.TrimSpace(profile.ProxyJumpID)
	if jumpID == "" {
		return nil
	}
	if jumpID == profile.ID {
		return errors.New("a profile cannot use itself as a jump host")
	}
	var jumpProfile *types.Profile
	for i := range profiles {
		existing := &profiles[i]
		if existing.ID == jumpID {
			jumpProfile = existing
		}
		if existing.ID != profile.ID && existing.ProxyJumpID == profile.ID {
			return errors.New("a profile used as a jump host cannot use another jump host")
		}
	}
	if jumpProfile == nil {
		return errors.New("jump host profile not found")
	}
	if strings.TrimSpace(jumpProfile.ProxyJumpID) != "" {
		return errors.New("nested proxy jumps are not supported")
	}
	return nil
}

// normalizeImportedProxyJumps repairs only profiles touched by the current
// import. Existing relationships win: importing B -> C must not silently erase
// an existing A -> B. Among imported edges, the inner usable hop is retained
// and any outer edge that would require nesting is cleared.
func normalizeImportedProxyJumps(profiles []types.Profile, imported map[int]bool) {
	ids := make(map[string]bool, len(profiles))
	for i := range profiles {
		ids[profiles[i].ID] = true
	}
	for i := range imported {
		jumpID := strings.TrimSpace(profiles[i].ProxyJumpID)
		if jumpID == profiles[i].ID || !ids[jumpID] {
			profiles[i].ProxyJumpID = ""
		}
	}
	referencedByExisting := make(map[string]bool, len(profiles))
	for i := range profiles {
		if !imported[i] && profiles[i].ProxyJumpID != "" {
			referencedByExisting[profiles[i].ProxyJumpID] = true
		}
	}
	for i := range imported {
		if referencedByExisting[profiles[i].ID] {
			profiles[i].ProxyJumpID = ""
		}
	}
	targetUsesJump := make(map[string]bool, len(profiles))
	for i := range profiles {
		targetUsesJump[profiles[i].ID] = profiles[i].ProxyJumpID != ""
	}
	for i := range imported {
		if targetUsesJump[profiles[i].ProxyJumpID] {
			profiles[i].ProxyJumpID = ""
		}
	}
}

func cliProfileTrustActive(profile types.Profile, now time.Time) bool {
	return profile.CliEnabled && !profile.CliTrustUntil.IsZero() && profile.CliTrustUntil.After(now)
}

func cliTrustNeedsConfirmation(previous, next types.Profile, now time.Time) bool {
	if !cliProfileTrustActive(next, now) {
		return false
	}
	return !cliProfileTrustActive(previous, now) || next.CliTrustUntil.After(previous.CliTrustUntil)
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

// truncate limits a string to maxLen characters. It counts runes, not bytes:
// the truncated text lands in native dialogs, and cutting a multibyte
// character in half would end a Chinese command preview with mojibake.
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	return string(runes[:maxLen]) + "..."
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
