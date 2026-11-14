package secrets

import (
	"errors"
	"os"
	"testing"

	"github.com/zalando/go-keyring"
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

func TestFailedProfileSaveRestoresNativeSnapshot(t *testing.T) {
	for _, kind := range []string{"password", "passphrase"} {
		for _, existed := range []bool{false, true} {
			t.Run(kind+map[bool]string{false: "-absent", true: "-existing"}[existed], func(t *testing.T) {
				s := newTestStore(t)
				native := &migrationKeyring{values: map[string]string{}}
				if existed {
					native.values[key("profile", kind)] = "native-before"
				}
				s.keyring = native
				if err := s.saveFallback("profile", kind, "fallback-before"); err != nil {
					t.Fatal(err)
				}
				if err := s.saveFallback("sibling", "password", "sibling-value"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(s.fallbackPath()+".tmp", 0700); err != nil {
					t.Fatal(err)
				}
				save, get := s.SavePassword, s.GetPassword
				if kind == "passphrase" {
					save, get = s.SavePassphrase, s.GetPassphrase
				}
				if err := save("profile", "replacement"); err == nil {
					t.Fatal("cleanup failure reported success")
				}
				value, err := native.Get(key("profile", kind))
				if existed && (err != nil || value != "native-before") || !existed && !errors.Is(err, keyring.ErrNotFound) {
					t.Fatalf("native snapshot not restored: %q %v", value, err)
				}
				if value, err := get("profile"); err != nil || value != "fallback-before" {
					t.Fatalf("failed save changed preferred value: %q %v", value, err)
				}
				reopened := &Store{dataDir: s.dataDir, legacyDir: s.legacyDir, keyring: native}
				if value, err := reopened.storedValue("profile", kind); err != nil || value != "fallback-before" {
					t.Fatalf("failed save changed persisted fallback: %q %v", value, err)
				}
			})
		}
	}
}

type profileFaultKeyring struct {
	*migrationKeyring
	getErr, restoreErr error
	sets               int
}

func (k *profileFaultKeyring) Get(id string) (string, error) {
	if k.getErr != nil {
		return "", k.getErr
	}
	return k.migrationKeyring.Get(id)
}

func (k *profileFaultKeyring) Set(id, value string) error {
	k.sets++
	if k.sets > 1 && k.restoreErr != nil {
		return k.restoreErr
	}
	return k.migrationKeyring.Set(id, value)
}

func TestProfileSaveWithoutNativeSnapshotUsesFallback(t *testing.T) {
	s := newTestStore(t)
	native := &profileFaultKeyring{
		migrationKeyring: &migrationKeyring{values: map[string]string{key("profile", "password"): "native-before"}},
		getErr:           errors.New("native reads unavailable"),
	}
	s.keyring = native
	if err := s.SavePassword("profile", "replacement"); err != nil {
		t.Fatal(err)
	}
	if native.sets != 0 || native.values[key("profile", "password")] != "native-before" {
		t.Fatal("native value changed without a rollback snapshot")
	}
	if value, err := s.GetPassword("profile"); err != nil || value != "replacement" {
		t.Fatalf("fallback save failed: %q %v", value, err)
	}
}

func TestProfileSaveReportsNativeRollbackFailure(t *testing.T) {
	for _, existed := range []bool{false, true} {
		s := newTestStore(t)
		cause := errors.New("native rollback unavailable")
		native := &profileFaultKeyring{migrationKeyring: &migrationKeyring{values: map[string]string{}}, restoreErr: cause}
		if existed {
			native.values[key("profile", "password")] = "native-before"
		} else {
			native.deleteErr = cause
		}
		s.keyring = native
		if err := s.saveFallback("profile", "password", "fallback-before"); err != nil {
			t.Fatal(err)
		}
		if err := s.saveFallback("sibling", "password", "sibling-value"); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(s.fallbackPath()+".tmp", 0700); err != nil {
			t.Fatal(err)
		}
		if err := s.SavePassword("profile", "replacement"); !errors.Is(err, cause) {
			t.Fatalf("rollback failure hidden: %v", err)
		}
		if value, err := s.GetPassword("profile"); err != nil || value != "fallback-before" {
			t.Fatalf("rollback failure changed preferred fallback: %q %v", value, err)
		}
	}
}

func TestProfileSaveWithUnreadableFallbackLeavesNativeUntouched(t *testing.T) {
	s := newTestStore(t)
	native := &migrationKeyring{values: map[string]string{key("profile", "password"): "native-before"}}
	s.keyring = native
	if err := os.WriteFile(s.fallbackPath(), []byte("corrupted fallback"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.SavePassword("profile", "replacement"); err == nil {
		t.Fatal("unreadable fallback reported success")
	}
	if native.values[key("profile", "password")] != "native-before" {
		t.Fatal("native changed before checking fallback")
	}
}
