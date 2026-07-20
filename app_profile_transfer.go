package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"gxShell/backend/types"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const maxProfileImportSize = 10 * 1024 * 1024

type profileExportBundle struct {
	Version         int             `json:"version"`
	ExportedAt      time.Time       `json:"exportedAt"`
	IncludesSecrets bool            `json:"includesSecrets"`
	Profiles        []types.Profile `json:"profiles"`
}

type profileImportCandidate struct {
	Profile  types.Profile
	ProxyRef string
}

type profileSecretUpdate struct {
	Password   string
	Passphrase string
}

// ExportProfiles writes a portable profile bundle. The normal UI passes false,
// so exported files do not contain credentials and imported copies prompt for
// them normally instead of claiming a missing password is already remembered.
func (a *App) ExportProfiles(includeSecrets bool) (string, error) {
	// Exporting credentials writes them to disk in plaintext, so it needs the
	// same native-dialog consent boundary as the other security-sensitive
	// actions: a compromised renderer can call this binding, but it cannot
	// forge the user's click. Declining behaves like a cancelled save dialog.
	if includeSecrets && !a.confirmPlaintextSecretExport() {
		return "", nil
	}
	profiles, err := a.store.ListProfiles()
	if err != nil {
		return "", err
	}
	for i := range profiles {
		if includeSecrets && profiles[i].RememberPassword {
			if err := a.loadProfileSecrets(&profiles[i]); err != nil {
				return "", fmt.Errorf("load credentials for %s: %w", profiles[i].Name, err)
			}
			if profiles[i].Password == "" && profiles[i].PrivateKeyPassphrase == "" {
				profiles[i].RememberPassword = false
			}
		} else {
			profiles[i].Password = ""
			profiles[i].PrivateKeyPassphrase = ""
			profiles[i].RememberPassword = false
		}
	}

	data, err := json.MarshalIndent(profileExportBundle{
		Version:         1,
		ExportedAt:      time.Now(),
		IncludesSecrets: includeSecrets,
		Profiles:        profiles,
	}, "", "  ")
	if err != nil {
		return "", err
	}

	filePath, err := runtime.SaveFileDialog(a.ctx.Get(), runtime.SaveDialogOptions{
		Title:           "Export gxShell profiles",
		DefaultFilename: "gxShell-profiles-" + time.Now().Format("20060102") + ".json",
		Filters: []runtime.FileFilter{
			{DisplayName: "gxShell profile bundle (*.json)", Pattern: "*.json"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil || filePath == "" {
		return filePath, err
	}
	if filepath.Ext(filePath) == "" {
		filePath += ".json"
	}
	if err := os.WriteFile(filePath, data, 0600); err != nil {
		return "", fmt.Errorf("write profile export: %w", err)
	}
	return filePath, nil
}

// confirmPlaintextSecretExport warns, via a native dialog, that the exported
// JSON will contain passwords and passphrases in plaintext. Mirrors the
// confirmHostKeyChange pattern: explicit wording, default answer No.
func (a *App) confirmPlaintextSecretExport() bool {
	ctx := a.ctx.Get()
	if ctx == nil {
		return false
	}
	a.nativeDialogMu.Lock()
	defer a.nativeDialogMu.Unlock()
	res, err := runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
		Type:  runtime.QuestionDialog,
		Title: "Export Credentials in Plaintext",
		Message: "This export will include saved passwords and private-key passphrases in PLAINTEXT inside the JSON file.\n\n" +
			"Anyone who can read the exported file can log in to your servers with it. Store and transfer the file carefully, and delete it after importing.\n\n" +
			"Continue with the export?",
		DefaultButton: "No",
	})
	if err != nil {
		a.log.ErrorFields("plaintext export confirm dialog failed", LogFields{"error": err.Error()})
		return false
	}
	return res == "Yes"
}

// ImportProfiles lets the user select a gxShell JSON bundle and merges it into
// the existing library. The returned counters are intentionally a plain map so
// the Wails API stays small and the frontend can localise the summary itself.
func (a *App) ImportProfiles() (map[string]int, error) {
	filePath, err := runtime.OpenFileDialog(a.ctx.Get(), runtime.OpenDialogOptions{
		Title: "Import gxShell profiles",
		Filters: []runtime.FileFilter{
			{DisplayName: "gxShell profile bundle (*.json)", Pattern: "*.json"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return nil, err
	}
	if filePath == "" {
		return map[string]int{"cancelled": 1}, nil
	}
	data, err := readSmallProfileFile(filePath)
	if err != nil {
		return nil, err
	}
	profiles, includesSecrets, err := decodeProfileBundle(data)
	if err != nil {
		return nil, err
	}
	candidates := make([]profileImportCandidate, 0, len(profiles))
	for _, profile := range profiles {
		if !includesSecrets {
			profile.Password = ""
			profile.PrivateKeyPassphrase = ""
			profile.RememberPassword = false
		} else if profile.Password == "" && profile.PrivateKeyPassphrase == "" {
			profile.RememberPassword = false
		}
		candidates = append(candidates, profileImportCandidate{Profile: profile, ProxyRef: profile.ProxyJumpID})
	}
	return a.mergeImportedProfiles(candidates)
}

// ImportOpenSSHConfig imports concrete Host aliases from an OpenSSH config.
// Wildcard blocks still contribute defaults, while wildcard-only hosts are not
// turned into unusable gxShell rows.
func (a *App) ImportOpenSSHConfig() (map[string]int, error) {
	home, _ := os.UserHomeDir()
	sshDir := filepath.Join(home, ".ssh")
	options := runtime.OpenDialogOptions{
		Title:           "Import OpenSSH config",
		DefaultFilename: "config",
		ShowHiddenFiles: true,
		Filters: []runtime.FileFilter{
			{DisplayName: "OpenSSH config", Pattern: "config;*.conf;*"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	}
	if info, err := os.Stat(sshDir); err == nil && info.IsDir() {
		options.DefaultDirectory = sshDir
	}
	filePath, err := runtime.OpenFileDialog(a.ctx.Get(), options)
	if err != nil {
		return nil, err
	}
	if filePath == "" {
		return map[string]int{"cancelled": 1}, nil
	}
	data, err := readSmallProfileFile(filePath)
	if err != nil {
		return nil, err
	}
	candidates, err := parseOpenSSHConfig(string(data))
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, errors.New("no concrete Host entries found in OpenSSH config")
	}
	return a.mergeImportedProfiles(candidates)
}

func readSmallProfileFile(filePath string) ([]byte, error) {
	info, err := os.Stat(filePath)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, errors.New("selected path is a directory")
	}
	if info.Size() > maxProfileImportSize {
		return nil, fmt.Errorf("profile file is too large (%d bytes, max %d)", info.Size(), maxProfileImportSize)
	}
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, errors.New("profile file is empty")
	}
	return data, nil
}

func decodeProfileBundle(data []byte) ([]types.Profile, bool, error) {
	var bundle profileExportBundle
	if err := json.Unmarshal(data, &bundle); err == nil && bundle.Profiles != nil {
		if bundle.Version > 1 {
			return nil, false, fmt.Errorf("profile bundle version %d is newer than this app supports", bundle.Version)
		}
		return bundle.Profiles, bundle.IncludesSecrets, nil
	}
	var profiles []types.Profile
	if err := json.Unmarshal(data, &profiles); err != nil {
		return nil, false, fmt.Errorf("invalid gxShell profile JSON: %w", err)
	}
	includesSecrets := false
	for _, profile := range profiles {
		if profile.Password != "" || profile.PrivateKeyPassphrase != "" {
			includesSecrets = true
			break
		}
	}
	return profiles, includesSecrets, nil
}

func profileIdentity(profile types.Profile) string {
	return strings.ToLower(strings.TrimSpace(profile.Username)) + "\x00" +
		strings.ToLower(strings.TrimSpace(profile.Host)) + "\x00" + strconv.Itoa(profile.Port)
}

func (a *App) mergeImportedProfiles(candidates []profileImportCandidate) (map[string]int, error) {
	// The file dialogs and reads happen in the callers; only the
	// read-merge-save cycle runs under the profiles lock.
	a.profilesMu.Lock()
	defer a.profilesMu.Unlock()
	existing, err := a.store.ListProfiles()
	if err != nil {
		return nil, err
	}
	result := map[string]int{"added": 0, "updated": 0, "skipped": 0}
	byID := make(map[string]int, len(existing)+len(candidates))
	byIdentity := make(map[string]int, len(existing)+len(candidates))
	for i, profile := range existing {
		byID[profile.ID] = i
		byIdentity[profileIdentity(profile)] = i
	}

	now := time.Now()
	idMap := make(map[string]string, len(candidates))
	secretUpdates := make(map[string]profileSecretUpdate)
	type pendingProxy struct {
		index int
		ref   string
	}
	proxies := make([]pendingProxy, 0, len(candidates))

	for _, candidate := range candidates {
		profile := candidate.Profile
		oldID := strings.TrimSpace(profile.ID)
		profile.Host = strings.TrimSpace(profile.Host)
		profile.Username = strings.TrimSpace(profile.Username)
		profile.Name = strings.TrimSpace(profile.Name)
		profile.Group = strings.TrimSpace(profile.Group)
		normalizeProfile(&profile)
		if profile.Host == "" || profile.Username == "" || profile.Port < 1 || profile.Port > 65535 {
			result["skipped"]++
			continue
		}

		hasSecret := profile.Password != "" || profile.PrivateKeyPassphrase != ""
		secret := profileSecretUpdate{Password: profile.Password, Passphrase: profile.PrivateKeyPassphrase}
		profile.Password = ""
		profile.PrivateKeyPassphrase = ""

		if index, ok := byID[oldID]; ok && oldID != "" {
			prior := existing[index]
			newIdentity := profileIdentity(profile)
			if owner, exists := byIdentity[newIdentity]; exists && owner != index {
				idMap[oldID] = prior.ID
				result["skipped"]++
				continue
			}
			delete(byIdentity, profileIdentity(prior))
			profile.ID = prior.ID
			profile.CreatedAt = prior.CreatedAt
			if profile.CreatedAt.IsZero() {
				profile.CreatedAt = now
			}
			if prior.LastConnectedAt.After(profile.LastConnectedAt) {
				profile.LastConnectedAt = prior.LastConnectedAt
			}
			if !hasSecret {
				profile.RememberPassword = prior.RememberPassword
			}
			profile.UpdatedAt = now
			existing[index] = profile
			byIdentity[newIdentity] = index
			idMap[oldID] = profile.ID
			if hasSecret {
				profile.RememberPassword = true
				existing[index].RememberPassword = true
				secretUpdates[profile.ID] = secret
			}
			proxies = append(proxies, pendingProxy{index: index, ref: candidate.ProxyRef})
			result["updated"]++
			continue
		}

		identity := profileIdentity(profile)
		if index, ok := byIdentity[identity]; ok {
			if oldID != "" {
				idMap[oldID] = existing[index].ID
			}
			result["skipped"]++
			continue
		}

		if oldID == "" {
			profile.ID = types.NewID("profile")
		} else {
			profile.ID = oldID
		}
		if _, collision := byID[profile.ID]; collision {
			profile.ID = types.NewID("profile")
		}
		profile.CreatedAt = now
		profile.UpdatedAt = now
		profile.LastConnectedAt = time.Time{}
		profile.RememberPassword = hasSecret
		index := len(existing)
		existing = append(existing, profile)
		byID[profile.ID] = index
		byIdentity[identity] = index
		if oldID != "" {
			idMap[oldID] = profile.ID
		}
		if hasSecret {
			secretUpdates[profile.ID] = secret
		}
		proxies = append(proxies, pendingProxy{index: index, ref: candidate.ProxyRef})
		result["added"]++
	}

	for _, pending := range proxies {
		ref := strings.TrimSpace(pending.ref)
		if mapped := idMap[ref]; mapped != "" {
			existing[pending.index].ProxyJumpID = mapped
		} else if _, ok := byID[ref]; ok {
			existing[pending.index].ProxyJumpID = ref
		} else {
			existing[pending.index].ProxyJumpID = ""
		}
	}
	// Preserve existing CLI aliases as authoritative and disable only later
	// conflicting imports, rather than persisting a library the CLI cannot use.
	aliases := map[string]bool{}
	for i := range existing {
		if !existing[i].CliEnabled {
			continue
		}
		alias := strings.ToLower(strings.TrimSpace(existing[i].CliAlias))
		if alias == "" || aliases[alias] {
			existing[i].CliEnabled = false
			existing[i].CliAlias = ""
			continue
		}
		aliases[alias] = true
	}

	if result["added"] == 0 && result["updated"] == 0 {
		return result, nil
	}
	if err := a.store.SaveProfiles(existing); err != nil {
		return nil, err
	}
	for profileID, secret := range secretUpdates {
		if secret.Password != "" {
			if err := a.secrets.SavePassword(profileID, secret.Password); err != nil {
				return nil, err
			}
		}
		if secret.Passphrase != "" {
			if err := a.secrets.SavePassphrase(profileID, secret.Passphrase); err != nil {
				return nil, err
			}
		}
	}
	return result, nil
}

type sshConfigOption struct {
	key   string
	value string
}

type sshConfigBlock struct {
	patterns []string
	options  []sshConfigOption
}

func parseOpenSSHConfig(content string) ([]profileImportCandidate, error) {
	blocks := []sshConfigBlock{{patterns: []string{"*"}}}
	current := 0
	aliases := []string{}
	seenAlias := map[string]bool{}

	scanner := bufio.NewScanner(strings.NewReader(content))
	scanner.Buffer(make([]byte, 1024), 1024*1024)
	for scanner.Scan() {
		fields := splitSSHFields(stripSSHComment(scanner.Text()))
		if len(fields) > 0 {
			if separator := strings.Index(fields[0], "="); separator > 0 {
				value := fields[0][separator+1:]
				fields[0] = fields[0][:separator]
				fields = append([]string{fields[0], value}, fields[1:]...)
			}
		}
		if len(fields) >= 3 && fields[1] == "=" {
			fields = append(fields[:1], fields[2:]...)
		}
		if len(fields) < 2 {
			continue
		}
		key := strings.ToLower(fields[0])
		switch key {
		case "host":
			patterns := append([]string(nil), fields[1:]...)
			blocks = append(blocks, sshConfigBlock{patterns: patterns})
			current = len(blocks) - 1
			for _, pattern := range patterns {
				name := strings.TrimPrefix(pattern, "!")
				if strings.HasPrefix(pattern, "!") || strings.ContainsAny(name, "*?%") || name == "" {
					continue
				}
				lower := strings.ToLower(name)
				if !seenAlias[lower] {
					seenAlias[lower] = true
					aliases = append(aliases, name)
				}
			}
		case "match":
			current = -1
		case "hostname", "user", "port", "identityfile", "proxyjump":
			if current >= 0 {
				blocks[current].options = append(blocks[current].options, sshConfigOption{key: key, value: fields[1]})
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	defaultUser := strings.TrimSpace(os.Getenv("USER"))
	if defaultUser == "" {
		defaultUser = strings.TrimSpace(os.Getenv("USERNAME"))
	}
	if slash := strings.LastIndexAny(defaultUser, `\\/`); slash >= 0 {
		defaultUser = defaultUser[slash+1:]
	}
	if defaultUser == "" {
		defaultUser = "root"
	}

	candidates := make([]profileImportCandidate, 0, len(aliases))
	aliasToID := make(map[string]string, len(aliases))
	for _, alias := range aliases {
		values := map[string]string{}
		for _, block := range blocks {
			if !sshHostBlockMatches(block.patterns, alias) {
				continue
			}
			for _, option := range block.options {
				if _, exists := values[option.key]; !exists {
					values[option.key] = option.value
				}
			}
		}
		host := strings.ReplaceAll(values["hostname"], "%h", alias)
		if host == "" {
			host = alias
		}
		username := values["user"]
		if username == "" {
			username = defaultUser
		}
		port := 22
		if parsed, err := strconv.Atoi(values["port"]); err == nil && parsed >= 1 && parsed <= 65535 {
			port = parsed
		}
		profileID := types.NewID("profile")
		profile := types.Profile{
			ID:          profileID,
			Name:        alias,
			Group:       "OpenSSH",
			Host:        host,
			Port:        port,
			Username:    username,
			AuthType:    types.AuthAgent,
			Description: "Imported from OpenSSH config",
			Tags:        []string{"openssh"},
			Tunnels:     []types.TunnelRule{},
		}
		if identity := values["identityfile"]; identity != "" {
			profile.AuthType = types.AuthPrivateKey
			profile.PrivateKeyPath = expandSSHIdentityPath(identity, host, username)
		}
		proxyRef := strings.TrimSpace(strings.Split(values["proxyjump"], ",")[0])
		candidates = append(candidates, profileImportCandidate{Profile: profile, ProxyRef: proxyRef})
		aliasToID[strings.ToLower(alias)] = profileID
	}

	// Resolve ProxyJump aliases and create a small agent-auth jump profile when
	// the config uses an inline user@host[:port] destination instead of a Host alias.
	inlineJumps := map[string]string{}
	for i := range candidates {
		ref := strings.TrimSpace(candidates[i].ProxyRef)
		if ref == "" || strings.EqualFold(ref, "none") {
			candidates[i].ProxyRef = ""
			continue
		}
		lookup := ref
		if at := strings.LastIndex(lookup, "@"); at >= 0 {
			lookup = lookup[at+1:]
		}
		lookup = strings.Trim(lookup, "[]")
		if colon := strings.LastIndex(lookup, ":"); colon > 0 && !strings.Contains(lookup[colon+1:], "]") {
			if _, err := strconv.Atoi(lookup[colon+1:]); err == nil {
				lookup = strings.Trim(lookup[:colon], "[]")
			}
		}
		if id := aliasToID[strings.ToLower(lookup)]; id != "" {
			candidates[i].ProxyRef = id
			continue
		}
		key := strings.ToLower(ref)
		if id := inlineJumps[key]; id != "" {
			candidates[i].ProxyRef = id
			continue
		}
		jump, ok := inlineProxyProfile(ref, defaultUser)
		if !ok {
			candidates[i].ProxyRef = ""
			continue
		}
		inlineJumps[key] = jump.ID
		candidates = append(candidates, profileImportCandidate{Profile: jump})
		candidates[i].ProxyRef = jump.ID
	}
	return candidates, nil
}

func sshHostBlockMatches(patterns []string, alias string) bool {
	positive := false
	lowerAlias := strings.ToLower(alias)
	for _, raw := range patterns {
		negated := strings.HasPrefix(raw, "!")
		pattern := strings.ToLower(strings.TrimPrefix(raw, "!"))
		matched, err := path.Match(pattern, lowerAlias)
		if err != nil {
			matched = pattern == lowerAlias
		}
		if matched && negated {
			return false
		}
		if matched {
			positive = true
		}
	}
	return positive
}

func stripSSHComment(line string) string {
	quote := rune(0)
	escaped := false
	for i, char := range line {
		if escaped {
			escaped = false
			continue
		}
		if char == '\\' {
			escaped = true
			continue
		}
		if quote != 0 {
			if char == quote {
				quote = 0
			}
			continue
		}
		if char == '\'' || char == '"' {
			quote = char
			continue
		}
		if char == '#' {
			return line[:i]
		}
	}
	return line
}

func splitSSHFields(line string) []string {
	fields := []string{}
	var current strings.Builder
	quote := rune(0)
	escaped := false
	flush := func() {
		if current.Len() > 0 {
			fields = append(fields, current.String())
			current.Reset()
		}
	}
	for _, char := range strings.TrimSpace(line) {
		if escaped {
			current.WriteRune(char)
			escaped = false
			continue
		}
		if char == '\\' {
			escaped = true
			continue
		}
		if quote != 0 {
			if char == quote {
				quote = 0
			} else {
				current.WriteRune(char)
			}
			continue
		}
		if char == '\'' || char == '"' {
			quote = char
			continue
		}
		if char == ' ' || char == '\t' {
			flush()
			continue
		}
		current.WriteRune(char)
	}
	if escaped {
		current.WriteRune('\\')
	}
	flush()
	return fields
}

func expandSSHIdentityPath(value, host, username string) string {
	home, _ := os.UserHomeDir()
	value = strings.ReplaceAll(value, "%d", home)
	value = strings.ReplaceAll(value, "%h", host)
	value = strings.ReplaceAll(value, "%r", username)
	value = os.ExpandEnv(value)
	if value == "~" {
		return home
	}
	if strings.HasPrefix(value, "~/") || strings.HasPrefix(value, `~\\`) {
		return filepath.Join(home, value[2:])
	}
	return value
}

func inlineProxyProfile(destination, defaultUser string) (types.Profile, bool) {
	destination = strings.TrimSpace(destination)
	if destination == "" || strings.EqualFold(destination, "none") {
		return types.Profile{}, false
	}
	username := defaultUser
	if at := strings.LastIndex(destination, "@"); at >= 0 {
		username = destination[:at]
		destination = destination[at+1:]
	}
	host := strings.Trim(destination, "[]")
	port := 22
	if strings.HasPrefix(destination, "[") {
		if close := strings.Index(destination, "]"); close > 0 {
			host = destination[1:close]
			if strings.HasPrefix(destination[close+1:], ":") {
				if parsed, err := strconv.Atoi(destination[close+2:]); err == nil {
					port = parsed
				}
			}
		}
	} else if colon := strings.LastIndex(destination, ":"); colon > 0 && strings.Count(destination, ":") == 1 {
		if parsed, err := strconv.Atoi(destination[colon+1:]); err == nil {
			host = destination[:colon]
			port = parsed
		}
	}
	if host == "" || username == "" || port < 1 || port > 65535 {
		return types.Profile{}, false
	}
	return types.Profile{
		ID:          types.NewID("profile"),
		Name:        "Jump: " + host,
		Group:       "OpenSSH",
		Host:        host,
		Port:        port,
		Username:    username,
		AuthType:    types.AuthAgent,
		Description: "Imported ProxyJump host",
		Tags:        []string{"openssh", "jump"},
		Tunnels:     []types.TunnelRule{},
	}, true
}
