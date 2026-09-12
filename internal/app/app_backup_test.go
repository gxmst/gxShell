package app

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gxShell/backend/config"
	"gxShell/backend/types"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

type backupTestSecrets struct {
	secretStore
	passwords   map[string]string
	passphrases map[string]string
	readErr     error
}

func (s *backupTestSecrets) GetPassword(id string) (string, error) {
	return s.passwords[id], s.readErr
}

func (s *backupTestSecrets) GetPassphrase(id string) (string, error) {
	return s.passphrases[id], s.readErr
}

func (s *backupTestSecrets) NamedValues(string) (map[string]string, error) {
	return nil, s.readErr
}

func backupTestApp(t *testing.T) *App {
	t.Helper()
	store, err := config.NewStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return &App{store: store}
}

func backupTestPayload() backupPayload {
	return backupPayload{
		Format: backupFormat, CreatedAt: time.Now().UTC(), Settings: config.DefaultSettings(), Workspaces: "[]",
		Profiles: []types.Profile{{ID: "source", Name: "Server", Host: "server.test", Port: 22, Username: "ops", AuthType: types.AuthAgent}},
		Commands: []types.CommandTemplate{{ID: "source-command", Name: "Status", Command: "uptime", Category: "Imported"}},
	}
}

func backupTestKey(t *testing.T) (ssh.PublicKey, []byte) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(private, "backup test")
	if err != nil {
		t.Fatal(err)
	}
	return key, pem.EncodeToMemory(block)
}

func TestBackupRoundTripAndWrongPassphrase(t *testing.T) {
	plain := []byte(`{"format":"gxShell-backup-v1","profiles":[{"id":"one"}]}`)
	envelope, err := encryptBackup(plain, "correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	got, err := decryptBackup(envelope, "correct horse battery")
	if err != nil || string(got) != string(plain) {
		t.Fatalf("round trip failed: %v %q", err, got)
	}
	if _, err := decryptBackup(envelope, "wrong password"); err == nil {
		t.Fatal("wrong passphrase was accepted")
	}
	second, err := encryptBackup(plain, "correct horse battery")
	if err != nil || second.Ciphertext == envelope.Ciphertext || second.Salt == envelope.Salt {
		t.Fatal("encryption reused salt or ciphertext")
	}
	for _, field := range []string{"ciphertext", "nonce", "salt", "format", "iterations"} {
		t.Run(field, func(t *testing.T) {
			changed := envelope
			mutate := func(value string) string {
				data, _ := base64.RawStdEncoding.DecodeString(value)
				data[0] ^= 1
				return base64.RawStdEncoding.EncodeToString(data)
			}
			switch field {
			case "ciphertext":
				changed.Ciphertext = mutate(changed.Ciphertext)
			case "nonce":
				changed.Nonce = mutate(changed.Nonce)
			case "salt":
				changed.Salt = mutate(changed.Salt)
			case "format":
				changed.Format = "unknown"
			case "iterations":
				changed.Iterations++
			}
			if _, err := decryptBackup(changed, "correct horse battery"); err == nil {
				t.Fatal("tampered backup was accepted")
			}
		})
	}
}

func TestBackupPassphraseValidation(t *testing.T) {
	for _, value := range []string{"", "short", strings.Repeat("x", 1025)} {
		if err := validateBackupPassphrase(value); err == nil {
			t.Fatalf("passphrase %q should be rejected", value)
		}
	}
	if err := validateBackupPassphrase("eight888"); err != nil {
		t.Fatal(err)
	}
}

func TestBackupKnownHostsKeepsExistingTrustAndAddsUnknownHosts(t *testing.T) {
	key, _ := backupTestKey(t)
	other, _ := backupTestKey(t)
	existing := knownhosts.Line([]string{"host-a"}, key) + "\n"
	incoming := existing + knownhosts.Line([]string{"host-a", "host-b"}, other) + "\n"
	merged, added, warnings, err := mergeBackupKnownHosts(existing, incoming)
	if err != nil || added != 1 || len(warnings) != 1 {
		t.Fatalf("unexpected merge: added=%d warnings=%v err=%v", added, warnings, err)
	}
	if merged != existing+knownhosts.Line([]string{"host-b"}, other)+"\n" {
		t.Fatal("existing trust was replaced or host-b was lost")
	}
	if _, _, _, err := mergeBackupKnownHosts("", "host-a ssh-ed25519 invalid\n"); err == nil {
		t.Fatal("invalid host key accepted")
	}
	if _, _, _, err := mergeBackupKnownHosts("", existing+knownhosts.Line([]string{"host-a"}, other)); err == nil {
		t.Fatal("conflicting source keys accepted")
	}
	hashed := knownhosts.Line([]string{knownhosts.HashHostname("host-a")}, key) + "\n"
	if merged, added, _, err := mergeBackupKnownHosts("", hashed); err != nil || merged != hashed || added != 1 {
		t.Fatalf("hashed host key lost: %v", err)
	}
}

func TestBackupPreviewRemapsKeysAndWorkspacesWithoutExposingCredentials(t *testing.T) {
	a := backupTestApp(t)
	payload := backupTestPayload()
	_, private := backupTestKey(t)
	payload.IncludesSecret = true
	payload.Profiles[0].AuthType = types.AuthPrivateKey
	payload.Profiles[0].PrivateKeyPath = "/old-computer/id_ed25519"
	payload.Profiles[0].PrivateKeyPassphrase = "test-only-passphrase"
	payload.Profiles[0].CliEnabled = true
	payload.Profiles[0].CliTrustUntil = time.Now().Add(time.Hour)
	payload.PrivateKeys = map[string][]byte{"source": private}
	payload.Workspaces = `[{"id":"work","name":"Daily","items":[{"key":"p:source","kind":"profile","target":"source","title":"Main"},{"key":"p:source:terminal:second","kind":"profile","target":"source","instanceId":"second","title":"Logs"}],"active":"p:source:terminal:second","layout":{"keys":["p:source","p:source:terminal:second"],"direction":"horizontal","ratio":0.4,"rowRatio":0.5}}]`
	before, _ := a.store.SnapshotFiles("profiles.json", "settings.json", "commands.json", "known_hosts")
	plan, err := a.planBackup(payload, "[]", "copy", false)
	if err != nil {
		t.Fatal(err)
	}
	var profiles []types.Profile
	if err := json.Unmarshal(plan.after["profiles.json"], &profiles); err != nil {
		t.Fatal(err)
	}
	profile := profiles[0]
	if profile.ID == "source" || profile.CliEnabled || !profile.CliTrustUntil.IsZero() || !profile.RememberPassword {
		t.Fatal("identity, trust or credentials were not remapped")
	}
	if filepath.Dir(profile.PrivateKeyPath) != filepath.Join(a.store.DataDir(), "imported-keys") {
		t.Fatal("private key kept source path")
	}
	if _, err := os.Stat(profile.PrivateKeyPath); !os.IsNotExist(err) {
		t.Fatal("preview wrote the private key")
	}
	previewJSON, _ := json.Marshal(plan.preview)
	if strings.Contains(string(previewJSON), "test-only-passphrase") || strings.Contains(string(plan.after["profiles.json"]), "test-only-passphrase") {
		t.Fatal("credentials leaked into preview or config")
	}
	if len(plan.secrets) != 1 || plan.secrets[0].ID != profile.ID {
		t.Fatal("credentials were not remapped")
	}
	workspaces, err := parseBackupWorkspaces(plan.preview.Workspaces)
	if err != nil || workspaces[0].Items[1].Target != profile.ID || workspaces[0].Active != "p:"+profile.ID+":terminal:second" {
		t.Fatalf("workspace identity was lost: %v", err)
	}
	after, _ := a.store.SnapshotFiles("profiles.json", "settings.json", "commands.json", "known_hosts")
	for name, data := range before {
		if string(after[name]) != string(data) {
			t.Fatalf("preview changed %s", name)
		}
	}
}

func TestBackupApplyAndStalePreview(t *testing.T) {
	for _, stale := range []string{"", "profiles", "workspaces", "expired"} {
		t.Run(stale, func(t *testing.T) {
			a := backupTestApp(t)
			payload := backupTestPayload()
			_, private := backupTestKey(t)
			payload.Profiles[0].AuthType = types.AuthPrivateKey
			payload.PrivateKeys = map[string][]byte{"source": private}
			plan, err := a.planBackup(payload, "[]", "keep", true)
			if err != nil {
				t.Fatal(err)
			}
			a.backupPending = plan
			workspaces := "[]"
			switch stale {
			case "profiles":
				_ = a.store.SaveProfiles([]types.Profile{{ID: "edited"}})
			case "workspaces":
				workspaces = "changed"
			case "expired":
				plan.expires = time.Now().Add(-time.Second)
			}
			err = a.ApplyBackup(plan.preview.Token, workspaces)
			if stale != "" {
				if err == nil {
					t.Fatal("stale preview applied")
				}
				if a.backupPending != nil {
					t.Fatal("failed preview was not consumed")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			profiles, _ := a.store.ListProfiles()
			if len(profiles) != 1 {
				t.Fatal("profile not imported")
			}
			got, err := os.ReadFile(profiles[0].PrivateKeyPath)
			if err != nil || string(got) != string(private) {
				t.Fatalf("private key migration failed: %v", err)
			}
			if err := a.ApplyBackup(plan.preview.Token, workspaces); err == nil {
				t.Fatal("preview token reused")
			}
		})
	}
}

func TestBackupKeepConflictPreservesIndependentWorkspacePanes(t *testing.T) {
	a := backupTestApp(t)
	payload := backupTestPayload()
	existing := payload.Profiles[0]
	existing.ID = "existing"
	_ = a.store.SaveProfiles([]types.Profile{existing})
	second := payload.Profiles[0]
	second.ID = "second"
	payload.Profiles = append(payload.Profiles, second)
	payload.Workspaces = `[{"id":"work","name":"Daily","items":[{"key":"p:source","kind":"profile","target":"source","title":"Main"},{"key":"p:second","kind":"profile","target":"second","title":"Logs"}],"active":"p:second","layout":{"keys":["p:source","p:second"],"direction":"horizontal","ratio":0.5,"rowRatio":0.5}}]`
	plan, err := a.planBackup(payload, "[]", "keep", false)
	if err != nil {
		t.Fatal(err)
	}
	workspaces, err := parseBackupWorkspaces(plan.preview.Workspaces)
	if err != nil || plan.preview.Profiles != 0 || plan.preview.Skipped != 2 {
		t.Fatalf("keep failed: %v", err)
	}
	items := workspaces[0].Items
	if items[0].Target != "existing" || items[1].Target != "existing" || items[0].Key == items[1].Key || items[1].InstanceID == "" {
		t.Fatal("two panes collapsed to one")
	}
}

func TestBackupValidatesReferencesAndTunnelAddresses(t *testing.T) {
	for _, kind := range []string{"profile", "workspace", "tunnel", "private-key", "credentials", "jump"} {
		t.Run(kind, func(t *testing.T) {
			payload := backupTestPayload()
			switch kind {
			case "profile":
				payload.Profiles = append(payload.Profiles, payload.Profiles[0])
			case "workspace":
				payload.Workspaces = `[{"id":"w","name":"Missing","items":[{"key":"p:nope","kind":"profile","target":"nope","title":"Missing"}],"active":"p:nope"}]`
			case "tunnel":
				payload.Profiles[0].Tunnels = []types.TunnelRule{{Type: types.TunnelLocal, Local: "70000", Remote: "22"}}
			case "private-key":
				payload.PrivateKeys = map[string][]byte{"source": []byte("not a private key")}
			case "credentials":
				payload.Profiles[0].Password = "unexpected"
			case "jump":
				payload.Profiles[0].ProxyJumpID = "source"
			}
			if err := validateBackup(&payload); err == nil {
				t.Fatal("invalid backup accepted")
			}
		})
	}
	for _, rule := range []types.TunnelRule{
		{Type: types.TunnelLocal, Local: "127.0.0.1:0", Remote: "[::1]:22"},
		{Type: types.TunnelRemote, Local: "localhost:80", Remote: "8080"},
		{Type: types.TunnelDynamic, Local: "1080"},
	} {
		if err := validateBackupTunnel(rule); err != nil {
			t.Fatal(err)
		}
	}
}

func TestBackupExportOmitsCredentialsAndOptionallyIncludesPrivateKeys(t *testing.T) {
	a := backupTestApp(t)
	payload := backupTestPayload()
	_, private := backupTestKey(t)
	path := filepath.Join(t.TempDir(), "test.key")
	if err := os.WriteFile(path, private, 0600); err != nil {
		t.Fatal(err)
	}
	profile := payload.Profiles[0]
	profile.AuthType, profile.PrivateKeyPath = types.AuthPrivateKey, path
	profile.Password, profile.PrivateKeyPassphrase, profile.RememberPassword = "legacy-password", "legacy-passphrase", true
	profile.CliTrustUntil = time.Now().Add(time.Hour)
	if err := a.store.SaveProfilesPreservingSecrets([]types.Profile{profile}, map[string]bool{profile.ID: true}); err != nil {
		t.Fatal(err)
	}
	settings := config.DefaultSettings()
	settings.Ai.APIKey = "legacy-api-key"
	if err := a.store.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	for _, includeKeys := range []bool{false, true} {
		backup, err := a.collectBackup("[]", false, includeKeys)
		if err != nil {
			t.Fatal(err)
		}
		data, _ := json.Marshal(backup)
		if strings.Contains(string(data), "legacy-password") || strings.Contains(string(data), "legacy-passphrase") || strings.Contains(string(data), "legacy-api-key") || backup.Profiles[0].RememberPassword || !backup.Profiles[0].CliTrustUntil.IsZero() {
			t.Fatal("credential-free export leaked credentials or trust")
		}
		if (len(backup.PrivateKeys) == 1) != includeKeys {
			t.Fatal("private key opt-in ignored")
		}
	}
	if _, err := a.collectBackup("[]", true, false); err == nil {
		t.Fatal("missing credential storage was ignored")
	}
}

func TestBackupExportPreservesLegacyCredentialsUntilSecureStorageHasValues(t *testing.T) {
	for _, tc := range []struct {
		name                     string
		include, remember        bool
		passwords, passphrases   map[string]string
		wantPassword, wantPhrase string
		wantAI                   string
	}{
		{name: "legacy", include: true, remember: true, wantPassword: "legacy-password", wantPhrase: "legacy-passphrase", wantAI: "legacy-api-key"},
		{name: "native takes precedence", include: true, remember: true, passwords: map[string]string{"source": "current-password", aiConfigSecretID: "current-api-key"}, passphrases: map[string]string{"source": "current-passphrase"}, wantPassword: "current-password", wantPhrase: "current-passphrase", wantAI: "current-api-key"},
		{name: "partial migration", include: true, remember: true, passwords: map[string]string{"source": "current-password"}, wantPassword: "current-password", wantPhrase: "legacy-passphrase", wantAI: "legacy-api-key"},
		{name: "credentials excluded", remember: true},
		{name: "remember disabled", include: true, wantAI: "legacy-api-key"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := backupTestApp(t)
			a.secrets = &backupTestSecrets{passwords: tc.passwords, passphrases: tc.passphrases}
			profile := backupTestPayload().Profiles[0]
			profile.AuthType, profile.RememberPassword = types.AuthPassword, tc.remember
			profile.Password, profile.PrivateKeyPassphrase = "legacy-password", "legacy-passphrase"
			if err := a.store.SaveProfilesPreservingSecrets([]types.Profile{profile}, map[string]bool{profile.ID: true}); err != nil {
				t.Fatal(err)
			}
			settings := config.DefaultSettings()
			settings.Ai.APIKey = "legacy-api-key"
			if err := a.store.SaveSettings(settings); err != nil {
				t.Fatal(err)
			}
			before, err := a.store.SnapshotFiles("profiles.json", "settings.json")
			if err != nil {
				t.Fatal(err)
			}
			payload, err := a.collectBackup("[]", tc.include, false)
			if err != nil {
				t.Fatal(err)
			}
			got := payload.Profiles[0]
			if got.Password != tc.wantPassword || got.PrivateKeyPassphrase != tc.wantPhrase || payload.AiAPIKey != tc.wantAI {
				t.Fatal("backup credential values do not match the export policy")
			}
			if payload.Settings.Ai.APIKey != "" || got.RememberPassword != (tc.include && tc.remember) {
				t.Fatal("credentials escaped their intended backup fields")
			}
			after, err := a.store.SnapshotFiles("profiles.json", "settings.json")
			if err != nil {
				t.Fatal(err)
			}
			for name, data := range before {
				if string(after[name]) != string(data) {
					t.Fatalf("export changed %s", name)
				}
			}
			if tc.name != "legacy" {
				return
			}
			plain, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			envelope, err := encryptBackup(plain, "test backup passphrase")
			if err != nil {
				t.Fatal(err)
			}
			decrypted, err := decryptBackup(envelope, "test backup passphrase")
			if err != nil {
				t.Fatal(err)
			}
			var restored backupPayload
			if err := json.Unmarshal(decrypted, &restored); err != nil {
				t.Fatal(err)
			}
			plan, err := backupTestApp(t).planBackup(restored, "[]", "copy", false)
			if err != nil {
				t.Fatal(err)
			}
			if len(plan.secrets) != 2 || plan.secrets[0].Text != tc.wantPassword || plan.secrets[1].Text != tc.wantPhrase {
				t.Fatal("legacy credentials did not survive encrypted export and import planning")
			}
			preview, _ := json.Marshal(plan.preview)
			for _, value := range []string{tc.wantPassword, tc.wantPhrase, tc.wantAI} {
				if strings.Contains(string(preview), value) || strings.Contains(string(plan.after["profiles.json"]), value) {
					t.Fatal("credentials leaked into the preview or plaintext profile configuration")
				}
			}
		})
	}
}

func TestBackupExportReportsCredentialReadFailure(t *testing.T) {
	a := backupTestApp(t)
	cause := errors.New("credential storage is locked")
	a.secrets = &backupTestSecrets{readErr: cause}
	profile := backupTestPayload().Profiles[0]
	profile.RememberPassword, profile.Password = true, "legacy-password"
	if err := a.store.SaveProfilesPreservingSecrets([]types.Profile{profile}, map[string]bool{profile.ID: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.collectBackup("[]", true, false); !errors.Is(err, cause) {
		t.Fatalf("credential read failure was hidden: %v", err)
	}
}
