package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode/utf16"

	"gxShell/backend/config"
	"gxShell/backend/secrets"
	sshmanager "gxShell/backend/ssh"
	"gxShell/backend/types"
)

func (a *App) planBackup(payload backupPayload, workspaces, policy string, restoreSettings bool) (*backupPlan, error) {
	if policy != "keep" && policy != "copy" {
		return nil, errors.New("invalid backup conflict policy")
	}
	if err := validateBackup(&payload); err != nil {
		return nil, err
	}
	existingWorkspaces, err := parseBackupWorkspaces(workspaces)
	if err != nil {
		return nil, err
	}
	plan := &backupPlan{preview: backupPreview{Token: types.NewID("backup"), CreatedAt: payload.CreatedAt, Settings: restoreSettings, Warnings: []string{}}, after: map[string][]byte{}, previousWorkspaces: workspaces, expires: time.Now().Add(15 * time.Minute)}
	err = sshmanager.WithKnownHostsLock(func() error {
		var err error
		plan.before, err = a.store.SnapshotFiles("profiles.json", "commands.json", "settings.json", "known_hosts")
		return err
	})
	if err != nil {
		return nil, err
	}
	var profiles []types.Profile
	var commands []types.CommandTemplate
	var settings types.AppSettings
	if err := json.Unmarshal(plan.before["profiles.json"], &profiles); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(plan.before["commands.json"], &commands); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(plan.before["settings.json"], &settings); err != nil {
		return nil, err
	}
	byID, byIdentity := map[string]int{}, map[string]int{}
	for i, profile := range profiles {
		byID[profile.ID] = i
		byIdentity[profileIdentity(profile)] = i
	}
	idMap := map[string]string{}
	start := len(profiles)
	for _, profile := range payload.Profiles {
		oldID := profile.ID
		index, conflict := byID[oldID]
		if !conflict {
			index, conflict = byIdentity[profileIdentity(profile)]
		}
		if conflict && policy == "keep" {
			idMap[oldID] = profiles[index].ID
			plan.preview.Skipped++
			plan.preview.Changes = append(plan.preview.Changes, backupChange{"profile", profile.Name, "keep"})
			continue
		}
		profile.ID = types.NewID("profile")
		idMap[oldID] = profile.ID
		if conflict {
			profile.Name += " (imported)"
		}
		profile.CliEnabled, profile.LegacyAIEnabled = false, false
		profile.CliTrustUntil = time.Time{}
		profile.LegacyAIAlias = ""
		profile.LastConnectedAt = time.Time{}
		profile.RememberPassword = payload.IncludesSecret && (profile.Password != "" || profile.PrivateKeyPassphrase != "")
		if profile.RememberPassword {
			if profile.Password != "" {
				plan.secrets = append(plan.secrets, secrets.Value{ID: profile.ID, Kind: "password", Text: profile.Password})
			}
			if profile.PrivateKeyPassphrase != "" {
				plan.secrets = append(plan.secrets, secrets.Value{ID: profile.ID, Kind: "passphrase", Text: profile.PrivateKeyPassphrase})
			}
		}
		profile.Password, profile.PrivateKeyPassphrase = "", ""
		if profile.AuthType == types.AuthPrivateKey {
			profile.PrivateKeyPath = ""
			if key := payload.PrivateKeys[oldID]; len(key) > 0 {
				name := "imported-keys/" + types.NewID("key") + ".key"
				plan.after[name] = key
				plan.before[name] = nil
				profile.PrivateKeyPath = filepath.Join(a.store.DataDir(), filepath.FromSlash(name))
				plan.preview.PrivateKeys++
			} else {
				plan.preview.Warnings = append(plan.preview.Warnings, "Private key must be selected again: "+profile.Name)
			}
		}
		profiles = append(profiles, profile)
		plan.preview.Profiles++
		plan.preview.Changes = append(plan.preview.Changes, backupChange{"profile", profile.Name, "add"})
	}
	for i := start; i < len(profiles); i++ {
		profiles[i].ProxyJumpID = idMap[profiles[i].ProxyJumpID]
	}
	for i := start; i < len(profiles); i++ {
		if err := validateProfileProxyJump(profiles[i], profiles); err != nil {
			return nil, fmt.Errorf("imported jump host for %s: %w", profiles[i].Name, err)
		}
	}
	for _, command := range payload.Commands {
		conflict := false
		for _, existing := range commands {
			if existing.ID == command.ID || (existing.Name == command.Name && existing.Category == command.Category) {
				conflict = true
				break
			}
		}
		if conflict && policy == "keep" {
			plan.preview.Skipped++
			plan.preview.Changes = append(plan.preview.Changes, backupChange{"command", command.Name, "keep"})
			continue
		}
		command.ID = types.NewID("cmd")
		if conflict {
			command.Name += " (imported)"
		}
		commands = append(commands, command)
		plan.preview.Commands++
		plan.preview.Changes = append(plan.preview.Changes, backupChange{"command", command.Name, "add"})
	}
	importedWorkspaces, _ := parseBackupWorkspaces(payload.Workspaces)
	for _, workspace := range importedWorkspaces {
		conflict := false
		for _, existing := range existingWorkspaces {
			if existing.ID == workspace.ID || strings.EqualFold(existing.Name, workspace.Name) {
				conflict = true
				break
			}
		}
		if conflict && policy == "keep" {
			plan.preview.Skipped++
			plan.preview.Changes = append(plan.preview.Changes, backupChange{"workspace", workspace.Name, "keep"})
			continue
		}
		workspace.ID = types.NewID("workspace")
		if conflict {
			base := []rune(workspace.Name)
			for len(utf16.Encode(base)) > 45 {
				base = base[:len(base)-1]
			}
			for suffix := 1; ; suffix++ {
				workspace.Name = fmt.Sprintf("%s (import %d)", string(base), suffix)
				found := false
				for _, existing := range existingWorkspaces {
					if strings.EqualFold(existing.Name, workspace.Name) {
						found = true
						break
					}
				}
				if !found {
					break
				}
			}
		}
		keyMap, usedKeys := map[string]string{}, map[string]bool{}
		for i := range workspace.Items {
			item := &workspace.Items[i]
			oldKey := item.Key
			if item.Kind == "profile" {
				mapped := idMap[item.Target]
				if mapped == "" {
					return nil, errors.New("workspace references a missing profile")
				}
				item.Target = mapped
				item.Key = "p:" + mapped
				if item.InstanceID != "" {
					item.Key += ":terminal:" + item.InstanceID
				}
				// Keeping an existing profile can map two source profiles to one.
				// Preserve both panes as independent terminals in that case.
				if usedKeys[item.Key] {
					item.InstanceID = types.NewID("terminal")
					item.Key = "p:" + mapped + ":terminal:" + item.InstanceID
				}
			} else {
				item.InstanceID = ""
				pathKey := strings.ReplaceAll(item.Target, "\\", "/")
				if runtime.GOOS == "windows" {
					pathKey = strings.ToLower(pathKey)
				}
				item.Key = "f:" + pathKey
				if usedKeys[item.Key] {
					return nil, errors.New("workspace contains duplicate file paths on this computer")
				}
				if info, err := os.Stat(item.Target); err != nil || !info.Mode().IsRegular() {
					plan.preview.Warnings = append(plan.preview.Warnings, "External document is unavailable; copy it separately: "+item.Target)
				} else {
					plan.preview.Warnings = append(plan.preview.Warnings, "External document needs authorization when opened: "+item.Target)
				}
			}
			keyMap[oldKey], usedKeys[item.Key] = item.Key, true
		}
		workspace.Active = keyMap[workspace.Active]
		if workspace.Layout != nil {
			for i, key := range workspace.Layout.Keys {
				workspace.Layout.Keys[i] = keyMap[key]
			}
		}
		existingWorkspaces = append(existingWorkspaces, workspace)
		plan.preview.WorkspacesAdded++
		plan.preview.Changes = append(plan.preview.Changes, backupChange{"workspace", workspace.Name, "add"})
	}
	if len(existingWorkspaces) > 30 {
		return nil, errors.New("import would exceed 30 workspaces; remove unused workspaces or keep existing conflicts")
	}
	encodedWorkspaces, err := json.Marshal(existingWorkspaces)
	if err != nil {
		return nil, err
	}
	plan.preview.Workspaces = string(encodedWorkspaces)
	if _, err := parseBackupWorkspaces(plan.preview.Workspaces); err != nil {
		return nil, fmt.Errorf("invalid merged workspaces: %w", err)
	}
	if restoreSettings {
		imported := config.NormalizeSettings(payload.Settings)
		if imported.ConnectionTimeout <= 0 {
			imported.ConnectionTimeout = config.DefaultSettings().ConnectionTimeout
		}
		if imported.MonitorIntervalSec <= 0 {
			imported.MonitorIntervalSec = config.DefaultSettings().MonitorIntervalSec
		}
		imported.CliServerEnabled = settings.CliServerEnabled
		imported.CliAutoApprove = false
		imported.UpdateCheckEnabled = settings.UpdateCheckEnabled
		imported.ConsentDefaultsVersion = config.DefaultSettings().ConsentDefaultsVersion
		imported.RestoreWorkspace = false
		imported.Terminal.LocalShell = settings.Terminal.LocalShell
		imported.Terminal.LocalStartDirectory = settings.Terminal.LocalStartDirectory
		imported.Ai.APIKey = ""
		if payload.IncludesSecret {
			plan.aiKey = payload.AiAPIKey
		}
		if plan.aiKey == "" && imported.Ai.Provider != "" {
			plan.preview.Warnings = append(plan.preview.Warnings, "AI credentials are not included; enter an API key after restoring settings")
		}
		if a.secrets != nil {
			previous, err := a.secrets.GetPassword(aiConfigSecretID)
			if err != nil {
				return nil, err
			}
			plan.secrets = append(plan.secrets, secrets.Value{ID: aiConfigSecretID, Kind: "password", Text: plan.aiKey, Expected: &previous})
		} else if plan.aiKey != "" {
			return nil, errors.New("credential storage unavailable")
		}
		settings = imported
	}
	plan.settings = settings
	if payload.IncludesSecret && len(payload.NamedSecrets) > 0 {
		if a.secrets == nil {
			return nil, errors.New("credential storage unavailable")
		}
		names := make([]string, 0, len(payload.NamedSecrets))
		for name := range payload.NamedSecrets {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			existing, err := a.secrets.GetNamed(cliSecretNamespace, name)
			if err != nil {
				return nil, err
			}
			if existing != "" {
				plan.preview.Skipped++
				plan.preview.Changes = append(plan.preview.Changes, backupChange{"credential", "secret://" + name, "keep"})
				plan.preview.Warnings = append(plan.preview.Warnings, "Existing named credential retained: secret://"+name)
				continue
			}
			plan.secrets = append(plan.secrets, secrets.Value{ID: "named:" + cliSecretNamespace + ":" + name, Kind: "value", Text: payload.NamedSecrets[name], Expected: &existing})
			plan.preview.NamedSecrets++
			plan.preview.Changes = append(plan.preview.Changes, backupChange{"credential", "secret://" + name, "add"})
		}
	}
	merged, count, warnings, err := mergeBackupKnownHosts(string(plan.before["known_hosts"]), payload.KnownHosts)
	if err != nil {
		return nil, err
	}
	plan.preview.KnownHosts = count
	plan.preview.Warnings = append(plan.preview.Warnings, warnings...)
	plan.after["known_hosts"] = []byte(merged)
	for name, value := range map[string]any{"profiles.json": profiles, "commands.json": commands, "settings.json": settings} {
		data, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			return nil, err
		}
		if len(data) > 10*1024*1024 {
			return nil, fmt.Errorf("%s would exceed 10 MiB", name)
		}
		plan.after[name] = data
	}
	return plan, nil
}
