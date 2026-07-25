package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"gxShell/backend/types"
)

// newTestStore builds a Store rooted at a temp dir without touching the real
// user config directory.
func newTestStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "logs"), 0755); err != nil {
		t.Fatal(err)
	}
	return &Store{dir: dir}
}

func writeSettingsJSON(t *testing.T, s *Store, raw string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(s.dir, "settings.json"), []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
}

func readCliServerEnabled(t *testing.T, s *Store) (value bool, present bool) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(s.dir, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	field, ok := raw["cliServerEnabled"]
	if !ok {
		return false, false
	}
	if err := json.Unmarshal(field, &value); err != nil {
		t.Fatal(err)
	}
	return value, true
}

// An older settings.json with no cliServerEnabled key must be backfilled to
// true, preserving the prior behaviour where the CLI server always ran.
func TestMigrateSettingsDefaultsBackfillsMissingKey(t *testing.T) {
	s := newTestStore(t)
	writeSettingsJSON(t, s, `{"themeName":"Light","monitorEnabled":true}`)

	s.MigrateSettingsDefaults()

	value, present := readCliServerEnabled(t, s)
	if !present {
		t.Fatal("cliServerEnabled was not written")
	}
	if !value {
		t.Fatal("missing key should migrate to true")
	}
}

// The migration rewrites the whole file, so fields the old settings.json did
// not contain must come back as their real defaults, not Go zero values. A file
// that predates, say, the connectionTimeout/terminal additions must not have
// those silently zeroed when cliServerEnabled is backfilled.
func TestMigrateSettingsDefaultsPreservesOtherDefaults(t *testing.T) {
	s := newTestStore(t)
	// A sparse, pre-existing file: only a couple of keys, no numeric/terminal
	// fields and no cliServerEnabled.
	writeSettingsJSON(t, s, `{"themeName":"Dark","monitorEnabled":false}`)

	s.MigrateSettingsDefaults()

	got, err := s.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	def := DefaultSettings()
	if got.ConnectionTimeout != def.ConnectionTimeout {
		t.Fatalf("connectionTimeout zeroed: got %d, want %d", got.ConnectionTimeout, def.ConnectionTimeout)
	}
	if got.MonitorIntervalSec != def.MonitorIntervalSec {
		t.Fatalf("monitorIntervalSec zeroed: got %d, want %d", got.MonitorIntervalSec, def.MonitorIntervalSec)
	}
	if got.Terminal.FontSize != def.Terminal.FontSize {
		t.Fatalf("terminal.fontSize zeroed: got %v, want %v", got.Terminal.FontSize, def.Terminal.FontSize)
	}
	if got.Terminal.ScrollbackLines != def.Terminal.ScrollbackLines {
		t.Fatalf("terminal.scrollbackLines zeroed: got %v, want %v", got.Terminal.ScrollbackLines, def.Terminal.ScrollbackLines)
	}
	// The values that WERE in the file must be respected, not overwritten.
	if got.ThemeName != "Dark" {
		t.Fatalf("themeName overwritten: got %q, want Dark", got.ThemeName)
	}
	if got.MonitorEnabled {
		t.Fatal("monitorEnabled overwritten: explicit false became true")
	}
	if !got.CliServerEnabled {
		t.Fatal("cliServerEnabled should be backfilled to true")
	}
}

// A user who explicitly disabled the CLI server must keep it disabled; the
// migration must not clobber an existing false.
func TestMigrateSettingsDefaultsPreservesExplicitFalse(t *testing.T) {
	s := newTestStore(t)
	writeSettingsJSON(t, s, `{"themeName":"Light","cliServerEnabled":false}`)

	s.MigrateSettingsDefaults()

	value, present := readCliServerEnabled(t, s)
	if !present {
		t.Fatal("cliServerEnabled disappeared")
	}
	if value {
		t.Fatal("explicit false must be preserved")
	}
}

func readBoolField(t *testing.T, s *Store, key string) (value bool, present bool) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(s.dir, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	field, ok := raw[key]
	if !ok {
		return false, false
	}
	if err := json.Unmarshal(field, &value); err != nil {
		t.Fatal(err)
	}
	return value, true
}

// updateCheckEnabled is true by default, so a settings.json written before the
// key existed must be backfilled rather than read as an explicit opt-out.
func TestMigrateSettingsDefaultsBackfillsUpdateCheck(t *testing.T) {
	s := newTestStore(t)
	writeSettingsJSON(t, s, `{"themeName":"Light","cliServerEnabled":true,"smartHighlight":true}`)

	s.MigrateSettingsDefaults()

	value, present := readBoolField(t, s, "updateCheckEnabled")
	if !present {
		t.Fatal("updateCheckEnabled was not written")
	}
	if !value {
		t.Fatal("missing updateCheckEnabled should migrate to true")
	}
}

// Someone who turned the update check off is opting out of the app's only
// unprompted network request. That must survive a restart.
func TestMigrateSettingsDefaultsPreservesUpdateCheckOptOut(t *testing.T) {
	s := newTestStore(t)
	writeSettingsJSON(t, s, `{"themeName":"Light","updateCheckEnabled":false}`)

	s.MigrateSettingsDefaults()

	value, present := readBoolField(t, s, "updateCheckEnabled")
	if !present {
		t.Fatal("updateCheckEnabled disappeared")
	}
	if value {
		t.Fatal("explicit false must be preserved")
	}
}

func TestMigrateSettingsDefaultsNoFileIsNoOp(t *testing.T) {
	s := newTestStore(t)
	// No settings.json on disk.
	s.MigrateSettingsDefaults()
	if _, err := os.Stat(filepath.Join(s.dir, "settings.json")); !os.IsNotExist(err) {
		t.Fatal("migration should not create settings.json when none exists")
	}
}

// GetSettings must round-trip the new flag.
func TestSaveAndGetSettingsRoundTripCliFlag(t *testing.T) {
	s := newTestStore(t)
	settings := DefaultSettings()
	settings.CliServerEnabled = false
	if err := s.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if got.CliServerEnabled {
		t.Fatal("CliServerEnabled should persist as false")
	}
}

func TestMigrateCommandDefaultsDoesNotReseedExistingLibrary(t *testing.T) {
	s := newTestStore(t)
	commands := []types.CommandTemplate{
		{
			ID:          "edited-builtin",
			Name:        "查看磁盘",
			Command:     "df -hT",
			Category:    "Custom",
			Description: "user edited",
		},
		{
			ID:       "custom-2",
			Name:     "自定义巡检",
			Command:  "echo ok",
			Category: "Custom",
		},
	}
	if err := s.SaveCommands(commands); err != nil {
		t.Fatal(err)
	}

	s.MigrateCommandDefaults()
	got, err := s.ListCommands()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(commands) {
		t.Fatalf("startup reseeded deleted commands: got %d commands, want %d", len(got), len(commands))
	}
	if got[0].ID != "edited-builtin" || got[0].Command != "df -hT" || got[0].Description != "user edited" {
		t.Fatalf("edited command was changed during startup: %#v", got[0])
	}
	if got[1].ID != "custom-2" || got[1].Command != "echo ok" {
		t.Fatalf("custom command was changed during startup: %#v", got[1])
	}

	s.MigrateCommandDefaults()
	again, err := s.ListCommands()
	if err != nil {
		t.Fatal(err)
	}
	if len(again) != len(got) {
		t.Fatal("migration should be idempotent")
	}
}

func TestNewStoreSeedsCommandsOnlyWhenFileIsMissing(t *testing.T) {
	s, err := NewStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	commands, err := s.ListCommands()
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) == 0 {
		t.Fatal("new stores should receive the initial built-in command library")
	}

	if err := s.SaveCommands([]types.CommandTemplate{}); err != nil {
		t.Fatal(err)
	}
	s.MigrateCommandDefaults()
	commands, err = s.ListCommands()
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 0 {
		t.Fatal("an intentionally emptied command library must stay empty")
	}
}

func TestSaveProfilesStripsLegacyAndSecrets(t *testing.T) {
	s := newTestStore(t)
	profiles := []types.Profile{{
		ID:         "p1",
		CliEnabled: true,
		CliAlias:   "prod",
		Password:   "secret",
	}}
	if err := s.SaveProfiles(profiles); err != nil {
		t.Fatal(err)
	}
	got, err := s.ListProfiles()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d profiles", len(got))
	}
	if got[0].Password != "" {
		t.Fatal("password must not be persisted to profiles.json")
	}
	if !got[0].CliEnabled || got[0].CliAlias != "prod" {
		t.Fatalf("CLI fields not persisted: %#v", got[0])
	}
}

func TestSaveProfilesPreservingSecretsRetainsOnlyListedProfiles(t *testing.T) {
	s := newTestStore(t)
	profiles := []types.Profile{
		{ID: "keep", Password: "retry-password", PrivateKeyPassphrase: "retry-passphrase"},
		{ID: "clear", Password: "clear-password", PrivateKeyPassphrase: "clear-passphrase"},
	}
	if err := s.SaveProfilesPreservingSecrets(profiles, map[string]bool{"keep": true}); err != nil {
		t.Fatal(err)
	}
	got, err := s.ListProfiles()
	if err != nil {
		t.Fatal(err)
	}
	if got[0].Password != "retry-password" || got[0].PrivateKeyPassphrase != "retry-passphrase" {
		t.Fatalf("preserved profile credentials were not retained: %#v", got[0])
	}
	if got[1].Password != "" || got[1].PrivateKeyPassphrase != "" {
		t.Fatalf("unpreserved profile credentials were not stripped: %#v", got[1])
	}
}
