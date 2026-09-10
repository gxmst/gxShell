package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"

	"gxShell/backend/config"
	"gxShell/backend/types"

	"golang.org/x/crypto/ssh"
)

type backupWorkspaceItem struct {
	Key         string `json:"key"`
	Kind        string `json:"kind"`
	Target      string `json:"target"`
	InstanceID  string `json:"instanceId,omitempty"`
	Title       string `json:"title"`
	Pinned      bool   `json:"pinned,omitempty"`
	CustomTitle bool   `json:"customTitle,omitempty"`
}
type backupWorkspaceLayout struct {
	Keys      []string `json:"keys"`
	Direction string   `json:"direction"`
	Ratio     float64  `json:"ratio"`
	RowRatio  float64  `json:"rowRatio"`
}
type backupWorkspace struct {
	ID        string                 `json:"id"`
	Name      string                 `json:"name"`
	Items     []backupWorkspaceItem  `json:"items"`
	Active    string                 `json:"active"`
	Layout    *backupWorkspaceLayout `json:"layout"`
	UpdatedAt float64                `json:"updatedAt"`
}

var backupInstancePattern = regexp.MustCompile(`^[a-zA-Z0-9-]{0,64}$`)

func parseBackupWorkspaces(raw string) ([]backupWorkspace, error) {
	if len(raw) > 5*1024*1024 {
		return nil, errors.New("workspace data exceeds 5 MiB")
	}
	if strings.TrimSpace(raw) == "" {
		raw = "[]"
	}
	var items []backupWorkspace
	if err := json.Unmarshal([]byte(raw), &items); err != nil || items == nil || len(items) > 30 {
		return nil, errors.New("invalid workspace data")
	}
	ids := map[string]bool{}
	for _, workspace := range items {
		if workspace.ID == "" || ids[workspace.ID] || len(workspace.ID) > 256 || strings.TrimSpace(workspace.Name) == "" || len(utf16.Encode([]rune(workspace.Name))) > 64 || len(workspace.Items) < 1 || len(workspace.Items) > 30 {
			return nil, errors.New("invalid workspace identity or item count")
		}
		ids[workspace.ID] = true
		keys, targets := map[string]string{}, map[string]bool{}
		for _, item := range workspace.Items {
			identity := item.Kind + "\x00" + item.Target + "\x00" + item.InstanceID
			if (item.Kind != "profile" && item.Kind != "file") || item.Key == "" || len(item.Key) > 4200 || item.Target == "" || len(item.Target) > 4096 || strings.ContainsRune(item.Target, 0) || len(item.Title) > 4096 || keys[item.Key] != "" || targets[identity] || !backupInstancePattern.MatchString(item.InstanceID) {
				return nil, errors.New("invalid workspace item")
			}
			keys[item.Key] = item.Kind
			targets[identity] = true
		}
		if keys[workspace.Active] == "" {
			return nil, errors.New("invalid active workspace item")
		}
		if layout := workspace.Layout; layout != nil {
			if (len(layout.Keys) != 2 && len(layout.Keys) != 4) || (layout.Direction != "grid" && layout.Direction != "vertical" && layout.Direction != "horizontal") || math.IsNaN(layout.Ratio) || layout.Ratio < 0 || layout.Ratio > 1 || layout.RowRatio < 0 || layout.RowRatio > 1 {
				return nil, errors.New("invalid workspace split layout")
			}
			seen := map[string]bool{}
			for _, key := range layout.Keys {
				if keys[key] != "profile" || seen[key] {
					return nil, errors.New("invalid workspace split reference")
				}
				seen[key] = true
			}
		}
	}
	return items, nil
}

func validateBackup(payload *backupPayload) error {
	if payload.Format != backupFormat {
		return errors.New("unsupported gxShell backup")
	}
	if len(payload.Profiles) > 10000 || len(payload.Commands) > 10000 || len(payload.NamedSecrets) > 10000 || len(payload.KnownHosts) > 5*1024*1024 {
		return errors.New("backup contains too many items")
	}
	ids := map[string]bool{}
	for i := range payload.Profiles {
		p := &payload.Profiles[i]
		if p.ID == "" || len(p.ID) > 256 || strings.ContainsRune(p.ID, 0) || ids[p.ID] || strings.TrimSpace(p.Host) == "" || strings.TrimSpace(p.Username) == "" || strings.ContainsAny(p.Host+p.Username, "\r\n\x00") || p.Port < 1 || p.Port > 65535 {
			return errors.New("invalid or duplicate profile")
		}
		ids[p.ID] = true
		if p.AuthType != types.AuthPassword && p.AuthType != types.AuthPrivateKey && p.AuthType != types.AuthAgent {
			return errors.New("invalid authentication type")
		}
		if !payload.IncludesSecret && (p.Password != "" || p.PrivateKeyPassphrase != "") {
			return errors.New("backup credential flag is inconsistent")
		}
		for _, tunnel := range p.Tunnels {
			if err := validateBackupTunnel(tunnel); err != nil {
				return err
			}
		}
		normalizeProfile(p)
	}
	for _, profile := range payload.Profiles {
		if err := validateProfileProxyJump(profile, payload.Profiles); err != nil {
			return fmt.Errorf("invalid proxy jump: %w", err)
		}
	}
	if err := config.ValidateHighlightRules(payload.Settings.HighlightRules); err != nil {
		return err
	}
	if payload.Settings.ConnectionTimeout < 0 || payload.Settings.ConnectionTimeout > 3600 || payload.Settings.MonitorIntervalSec < 0 || payload.Settings.MonitorIntervalSec > 86400 {
		return errors.New("invalid connection or monitor interval")
	}
	commandIDs := map[string]bool{}
	for _, command := range payload.Commands {
		if command.ID == "" || commandIDs[command.ID] || strings.TrimSpace(command.Name) == "" || strings.TrimSpace(command.Command) == "" || len(command.Command) > 1024*1024 {
			return errors.New("invalid or duplicate command")
		}
		commandIDs[command.ID] = true
	}
	for profileID, key := range payload.PrivateKeys {
		if !ids[profileID] || len(key) == 0 || len(key) > 1024*1024 {
			return errors.New("invalid private key entry")
		}
		_, err := ssh.ParseRawPrivateKey(key)
		var encrypted *ssh.PassphraseMissingError
		if err != nil && !errors.As(err, &encrypted) {
			return fmt.Errorf("invalid private key for %s", profileID)
		}
	}
	if !payload.IncludesSecret && (payload.AiAPIKey != "" || len(payload.NamedSecrets) > 0) {
		return errors.New("backup credential flag is inconsistent")
	}
	for name, value := range payload.NamedSecrets {
		if !cliSecretAliasPattern.MatchString(name) || value == "" || strings.ContainsAny(value, "\r\n\x00") {
			return errors.New("invalid named credential")
		}
	}
	workspaces, err := parseBackupWorkspaces(payload.Workspaces)
	if err != nil {
		return err
	}
	for _, workspace := range workspaces {
		for _, item := range workspace.Items {
			if item.Kind == "profile" && !ids[item.Target] {
				return errors.New("workspace references a missing profile")
			}
		}
	}
	_, _, _, err = mergeBackupKnownHosts("", payload.KnownHosts)
	return err
}

func validateBackupTunnel(rule types.TunnelRule) error {
	validAddress := func(address string, listening bool) bool {
		if strings.ContainsAny(address, "\r\n\x00") || len(address) > 4096 {
			return false
		}
		port := address
		if strings.Contains(address, ":") {
			var err error
			_, port, err = net.SplitHostPort(address)
			if err != nil {
				return false
			}
		}
		n, err := strconv.Atoi(port)
		return err == nil && n <= 65535 && (n > 0 || (listening && n == 0))
	}
	valid := false
	switch rule.Type {
	case types.TunnelLocal:
		valid = validAddress(rule.Local, true) && validAddress(rule.Remote, false)
	case types.TunnelRemote:
		valid = validAddress(rule.Remote, true) && validAddress(rule.Local, false)
	case types.TunnelDynamic:
		valid = validAddress(rule.Local, true)
	}
	if !valid || strings.ContainsAny(rule.BindHost, "\r\n\x00") {
		return errors.New("invalid tunnel type or address")
	}
	return nil
}
