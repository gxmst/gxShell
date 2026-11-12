package secrets

import (
	"errors"
	"os"
	"testing"
)

func TestProfileFallbackUpdateWinsAcrossReadsAndMigration(t *testing.T) {
	for _, kind := range []string{"password", "passphrase"} {
		t.Run(kind, func(t *testing.T) {
			s := newTestStore(t)
			native := &migrationKeyring{values: map[string]string{}}
			s.keyring = native
			save, get := s.SavePassword, s.GetPassword
			if kind == "passphrase" {
				save, get = s.SavePassphrase, s.GetPassphrase
			}
			if err := save("profile", "old"); err != nil {
				t.Fatal(err)
			}
			native.setErr = errors.New("native writes unavailable")
			if err := save("profile", "new"); err != nil {
				t.Fatal(err)
			}
			if got, err := get("profile"); err != nil || got != "new" {
				t.Fatalf("read: %q %v", got, err)
			}
			reopened := &Store{dataDir: s.dataDir, legacyDir: s.legacyDir, keyring: native}
			if got, err := reopened.storedValue("profile", kind); err != nil || got != "new" {
				t.Fatalf("reopened: %q %v", got, err)
			}
			old := "old"
			if err := s.ApplyMigration([]Value{{ID: "profile", Kind: kind, Text: "stale", Expected: &old}}, func() error { return nil }); err == nil {
				t.Fatal("stale preview overwrote fallback")
			}
			cause := errors.New("config commit failed")
			if err := s.ApplyMigration([]Value{{ID: "profile", Kind: kind, Text: "replacement"}}, func() error { return cause }); !errors.Is(err, cause) {
				t.Fatal(err)
			}
			if got, err := get("profile"); err != nil || got != "new" {
				t.Fatalf("rollback restored a stale value: %q %v", got, err)
			}
			native.setErr = nil
			if err := save("profile", "recovered"); err != nil {
				t.Fatal(err)
			}
			reopened = &Store{dataDir: s.dataDir, legacyDir: s.legacyDir, keyring: native}
			if got, err := reopened.storedValue("profile", kind); err != nil || got != "recovered" {
				t.Fatalf("native recovery: %q %v", got, err)
			}
		})
	}
}

func TestNativeUpdateReportsFallbackCleanupFailure(t *testing.T) {
	s := newTestStore(t)
	s.keyring = &migrationKeyring{values: map[string]string{}}
	if err := s.saveFallback("profile", "password", "old"); err != nil {
		t.Fatal(err)
	}
	if err := s.saveFallback("profile", "passphrase", "sibling"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(s.fallbackPath()+".tmp", 0700); err != nil {
		t.Fatal(err)
	}
	if err := s.SavePassword("profile", "new"); err == nil {
		t.Fatal("failed fallback cleanup reported success")
	}
	if got := s.loadFallback("profile", "password"); got != "old" {
		t.Fatal("failed cleanup mutated cached fallback")
	}
}
