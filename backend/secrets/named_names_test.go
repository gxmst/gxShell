package secrets

import (
	"bytes"
	"errors"
	"os"
	"reflect"
	"testing"
)

type metadataOnlyKeyring struct {
	migrationKeyring
	reads int
}

func (k *metadataOnlyKeyring) Get(string) (string, error) {
	k.reads++
	return "", errors.New("value retrieval forbidden")
}

func TestNamedNamesListsNativeAndEncryptedIndexWithoutReadingKeyringValues(t *testing.T) {
	s := newTestStore(t)
	k := &metadataOnlyKeyring{migrationKeyring: migrationKeyring{values: map[string]string{
		"named:cli:native-only.value": "native-value",
		"named:cli:duplicate.value":   "native-duplicate",
		"named:other:hidden.value":    "other-value",
	}}}
	s.keyring = k
	if err := s.saveFallback("named:cli:fallback-only", "value", "fallback-value"); err != nil {
		t.Fatal(err)
	}
	if err := s.saveFallback("named:cli:duplicate", "indexed", "1"); err != nil {
		t.Fatal(err)
	}
	names, err := s.NamedNames("cli")
	if err != nil || !reflect.DeepEqual(names, []string{"duplicate", "fallback-only", "native-only"}) || k.reads != 0 {
		t.Fatalf("metadata listing: %v, %v; reads=%d", names, err, k.reads)
	}
	raw, err := os.ReadFile(s.fallbackPath())
	if err != nil || bytes.Contains(raw, []byte("fallback-value")) {
		t.Fatal("fallback value stored in plaintext")
	}
	// Verify indexed references survive restart, using the same isolated key.
	reopened := &Store{dataDir: s.dataDir, legacyDir: s.legacyDir, keyring: k}
	if got, err := reopened.NamedNames("cli"); err != nil || !reflect.DeepEqual(got, names) {
		t.Fatal("references not persisted")
	}
}

type offlineKeyring struct{ migrationKeyring }

func (*offlineKeyring) Get(string) (string, error) { return "", errors.New("keyring offline") }
func (*offlineKeyring) Set(string, string) error   { return errors.New("keyring offline") }
func (*offlineKeyring) Delete(string) error        { return errors.New("keyring offline") }
func (*offlineKeyring) NamedNames(string) ([]string, error) {
	return nil, errors.New("keyring offline")
}

func TestNamedSecretsUseHealthyFallbackDuringKeyringOutage(t *testing.T) {
	s := newTestStore(t)
	s.keyring = &offlineKeyring{}
	before, err := s.GetNamed("cli", "new-key")
	if err != nil || before != "" {
		t.Fatalf("new credential preflight: %q %v", before, err)
	}
	update := Value{ID: "named:cli:new-key", Kind: "value", Text: "isolated-fake-value", Expected: &before}
	if err := s.ApplyMigration([]Value{update}, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	names, err := s.NamedNames("cli")
	if err != nil || !reflect.DeepEqual(names, []string{"new-key"}) {
		t.Fatalf("fallback listing: %v %v", names, err)
	}
	if got, err := s.GetNamed("cli", "new-key"); err != nil || got != update.Text {
		t.Fatalf("fallback read: %q %v", got, err)
	}
	// The same expected-empty mutation must not overwrite the saved value.
	if err := s.ApplyMigration([]Value{update}, func() error { return nil }); err == nil {
		t.Fatal("duplicate creation overwrote a fallback credential")
	}
	// Export remains strict so an outage cannot produce an incomplete backup.
	if _, err := s.NamedValues("cli"); err == nil {
		t.Fatal("export silently omitted inaccessible native credentials")
	}
	reopened := &Store{dataDir: s.dataDir, legacyDir: s.legacyDir, keyring: &offlineKeyring{}}
	if got, err := reopened.GetNamed("cli", "new-key"); err != nil || got != update.Text {
		t.Fatal("offline fallback did not survive restart")
	}
}

func TestOfflineIndexedNativeSecretIsNotTreatedAsMissing(t *testing.T) {
	s := newTestStore(t)
	s.keyring = &migrationKeyring{values: map[string]string{}}
	if err := s.SaveNamed("cli", "native-key", "original"); err != nil {
		t.Fatal(err)
	}
	s.keyring = &offlineKeyring{}
	if _, err := s.GetNamed("cli", "native-key"); err == nil {
		t.Fatal("inaccessible native credential was treated as missing")
	}
	before := ""
	if err := s.ApplyMigration([]Value{{ID: "named:cli:native-key", Kind: "value", Text: "replacement", Expected: &before}}, func() error { return nil }); err == nil {
		t.Fatal("inaccessible indexed credential was overwritten")
	}
}

func TestLegacyNativeNamesAreIndexedBeforeAnOutage(t *testing.T) {
	s := newTestStore(t)
	s.keyring = &migrationKeyring{values: map[string]string{"named:cli:legacy-key.value": "legacy-value"}}
	if names, err := s.NamedNames("cli"); err != nil || !reflect.DeepEqual(names, []string{"legacy-key"}) {
		t.Fatalf("legacy listing: %v %v", names, err)
	}
	s.keyring = &offlineKeyring{}
	if names, err := s.NamedNames("cli"); err != nil || !reflect.DeepEqual(names, []string{"legacy-key"}) {
		t.Fatalf("offline legacy listing: %v %v", names, err)
	}
	if _, err := s.GetNamed("cli", "legacy-key"); err == nil {
		t.Fatal("inaccessible legacy credential became an empty name")
	}
}

func TestNamedSecretFallbackUpdateWinsOverOlderNativeValue(t *testing.T) {
	s := newTestStore(t)
	native := &migrationKeyring{values: map[string]string{}}
	s.keyring = native
	if err := s.SaveNamed("cli", "api-key", "old"); err != nil {
		t.Fatal(err)
	}
	native.setErr = errors.New("native writes unavailable")
	before := "old"
	if err := s.ApplyMigration([]Value{{ID: "named:cli:api-key", Kind: "value", Text: "new", Expected: &before}}, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	if got, err := s.GetNamed("cli", "api-key"); err != nil || got != "new" {
		t.Fatalf("stale native value won: %q %v", got, err)
	}
	if err := s.ApplyMigration([]Value{{ID: "named:cli:api-key", Kind: "value", Text: "stale", Expected: &before}}, func() error { return nil }); err == nil {
		t.Fatal("stale expected value overwrote fallback update")
	}
}

func TestNamedSecretOperationsRejectCorruptFallbackDuringOutage(t *testing.T) {
	s := newTestStore(t)
	s.keyring = &offlineKeyring{}
	if err := os.WriteFile(s.fallbackPath(), []byte("corrupt encrypted storage"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.NamedNames("cli"); err == nil {
		t.Fatal("corrupt fallback was listed as empty")
	}
	if _, err := s.GetNamed("cli", "new-key"); err == nil {
		t.Fatal("corrupt fallback was treated as absent")
	}
}

func TestNamedSecretDeleteFailurePreservesNativeAndFallbackValue(t *testing.T) {
	s := newTestStore(t)
	native := &migrationKeyring{values: map[string]string{}}
	s.keyring = native
	if err := s.SaveNamed("cli", "api-key", "original"); err != nil {
		t.Fatal(err)
	}
	native.setErr = errors.New("native writes unavailable")
	if err := s.SaveNamed("cli", "api-key", "newest"); err != nil {
		t.Fatal(err)
	}
	native.deleteErr = errors.New("native deletion unavailable")
	committed := false
	err := s.ApplyMigration([]Value{{ID: "named:cli:api-key", Kind: "value"}}, func() error { committed = true; return nil })
	if err == nil || committed {
		t.Fatal("failed native deletion was committed")
	}
	if got, err := s.GetNamed("cli", "api-key"); err != nil || got != "newest" {
		t.Fatal("failed deletion lost the newest fallback value")
	}
	if native.values["named:cli:api-key.value"] != "original" {
		t.Fatal("failed deletion changed the native value")
	}
}
