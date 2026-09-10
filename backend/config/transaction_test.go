package config

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"gxShell/backend/types"
)

func TestMigrationRollsBackFilesAndCache(t *testing.T) {
	s, err := NewStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SaveProfiles([]types.Profile{{ID: "original"}}); err != nil {
		t.Fatal(err)
	}
	before, err := s.SnapshotFiles("profiles.json", "commands.json", "settings.json")
	if err != nil {
		t.Fatal(err)
	}
	after := map[string][]byte{"commands.json": []byte(`[]`), "profiles.json": []byte(`[]`), "settings.json": []byte(`{}`)}
	calls := 0
	err = s.applyMigration(before, after, func(from, to string) error {
		calls++
		if calls == 3 {
			return errors.New("injected disk failure")
		}
		return os.Rename(from, to)
	})
	if err == nil {
		t.Fatal("expected injected failure")
	}
	for name, data := range before {
		got, _ := os.ReadFile(filepath.Join(s.dir, name))
		if string(got) != string(data) {
			t.Fatalf("%s not restored", name)
		}
	}
	profiles, err := s.ListProfiles()
	if err != nil || len(profiles) != 1 || profiles[0].ID != "original" {
		t.Fatalf("cache diverged: %#v %v", profiles, err)
	}
}

func TestMigrationRejectsStalePreview(t *testing.T) {
	s, _ := NewStoreAt(t.TempDir())
	before, _ := s.SnapshotFiles("profiles.json")
	_ = s.SaveProfiles([]types.Profile{{ID: "edited"}})
	if err := s.ApplyMigration(before, map[string][]byte{"profiles.json": []byte(`[]`)}); err == nil {
		t.Fatal("stale preview replaced an edit")
	}
}

func TestMigrationRemovesNewKeysAfterFailedConfigWrite(t *testing.T) {
	s, _ := NewStoreAt(t.TempDir())
	before, _ := s.SnapshotFiles("profiles.json")
	before["imported-keys/test.key"] = nil
	after := map[string][]byte{"imported-keys/test.key": []byte("test-key"), "profiles.json": []byte(`[]`)}
	err := s.applyMigration(before, after, func(from, to string) error {
		if filepath.Base(to) == "profiles.json" {
			return errors.New("injected failure")
		}
		return os.Rename(from, to)
	})
	if err == nil {
		t.Fatal("expected failure")
	}
	if _, err := os.Stat(filepath.Join(s.dir, "imported-keys", "test.key")); !os.IsNotExist(err) {
		t.Fatal("new private key survived failed import")
	}
	files, _ := filepath.Glob(filepath.Join(s.dir, "imported-keys", ".migration-*"))
	if len(files) != 0 {
		t.Fatal("staged keys survived failed import")
	}
}

func TestMigrationRejectsUnexpectedPaths(t *testing.T) {
	s, _ := NewStoreAt(t.TempDir())
	for _, name := range []string{"../outside.key", "imported-keys/../../outside.key", "secrets.dat", "imported-keys/subdir/test.key"} {
		if err := s.ApplyMigration(map[string][]byte{name: nil}, map[string][]byte{name: []byte("value")}); err == nil {
			t.Fatalf("accepted %s", name)
		}
	}
}
