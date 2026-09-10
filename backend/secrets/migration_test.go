package secrets

import (
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/zalando/go-keyring"
)

type migrationKeyring struct {
	values            map[string]string
	setErr, deleteErr error
}

func (k *migrationKeyring) Get(id string) (string, error) {
	if value, ok := k.values[id]; ok {
		return value, nil
	}
	return "", keyring.ErrNotFound
}
func (k *migrationKeyring) Set(id, value string) error {
	if k.setErr != nil {
		return k.setErr
	}
	k.values[id] = value
	return nil
}
func (k *migrationKeyring) Delete(id string) error {
	if k.deleteErr != nil {
		return k.deleteErr
	}
	delete(k.values, id)
	return nil
}
func (k *migrationKeyring) NamedNames(namespace string) ([]string, error) {
	var names []string
	prefix := "named:" + namespace + ":"
	for id := range k.values {
		if strings.HasPrefix(id, prefix) && strings.HasSuffix(id, ".value") {
			names = append(names, strings.TrimSuffix(strings.TrimPrefix(id, prefix), ".value"))
		}
	}
	return names, nil
}

func TestSecretMigrationRollsBackNativeAndFallbackValues(t *testing.T) {
	for _, fallback := range []bool{false, true} {
		t.Run(map[bool]string{true: "fallback", false: "native"}[fallback], func(t *testing.T) {
			s := newTestStore(t)
			native := &migrationKeyring{values: map[string]string{}}
			s.keyring = native
			if fallback {
				native.setErr = errors.New("keyring unavailable")
			}
			if err := s.SavePassword("existing", "before"); err != nil {
				t.Fatal(err)
			}
			cause := errors.New("config write failed")
			err := s.ApplyMigration([]Value{{ID: "existing", Kind: "password", Text: "after"}, {ID: "new", Kind: "passphrase", Text: "new-secret"}}, func() error { return cause })
			if !errors.Is(err, cause) {
				t.Fatalf("original failure lost: %v", err)
			}
			if got, err := s.GetPassword("existing"); err != nil || got != "before" {
				t.Fatal("existing password was not restored")
			}
			if got, err := s.GetPassphrase("new"); err != nil || got != "" {
				t.Fatal("new passphrase was not removed")
			}
		})
	}
}

func TestSecretMigrationRejectsConcurrentEdit(t *testing.T) {
	s := newTestStore(t)
	s.keyring = &migrationKeyring{values: map[string]string{"existing.password": "edited"}}
	before := "before"
	committed := false
	err := s.ApplyMigration([]Value{{ID: "existing", Kind: "password", Text: "after", Expected: &before}}, func() error { committed = true; return nil })
	if err == nil || committed {
		t.Fatal("stale credentials applied")
	}
	if got, _ := s.GetPassword("existing"); got != "edited" {
		t.Fatal("concurrent edit was overwritten")
	}
}

func TestSecretMigrationReportsRollbackFailure(t *testing.T) {
	s := newTestStore(t)
	native := &migrationKeyring{values: map[string]string{}}
	s.keyring = native
	err := s.ApplyMigration([]Value{{ID: "new", Kind: "password", Text: "value"}}, func() error {
		native.deleteErr = errors.New("native delete failed")
		return errors.New("config write failed")
	})
	if err == nil || !strings.Contains(err.Error(), "config write failed") || !strings.Contains(err.Error(), "rollback failed") {
		t.Fatalf("rollback failure hidden: %v", err)
	}
}

func TestSecretFallbackFailedWriteDoesNotChangeCache(t *testing.T) {
	s := newTestStore(t)
	s.keyring = &migrationKeyring{values: map[string]string{}, setErr: errors.New("keyring unavailable")}
	if err := s.SavePassword("existing", "before"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(s.fallbackPath()+".tmp", 0700); err != nil {
		t.Fatal(err)
	}
	if err := s.SavePassword("existing", "after"); err == nil {
		t.Fatal("expected disk failure")
	}
	if got := s.loadFallback("existing", "password"); got != "before" {
		t.Fatal("failed write changed the cached password")
	}
}

func TestNamedValuesIncludesNativeAndFallbackCredentials(t *testing.T) {
	s := newTestStore(t)
	native := &migrationKeyring{values: map[string]string{"named:cli:native-only.value": "native-value"}}
	s.keyring = native
	if err := s.saveFallback("named:cli:fallback-only", "value", "fallback-value"); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveNamed("cli", "indexed", "indexed-value"); err != nil {
		t.Fatal(err)
	}
	values, err := s.NamedValues("cli")
	if err != nil || len(values) != 3 || values["native-only"] != "native-value" || values["fallback-only"] != "fallback-value" || values["indexed"] != "indexed-value" {
		t.Fatalf("named credential export incomplete: %v", err)
	}
}
