package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"gxShell/backend/secrets"
)

// In-memory adapter: these tests never touch real credentials.
type namedSecretTestStore struct {
	secretStore
	values      map[string]string
	err         error
	beforeApply func()
}

func (s *namedSecretTestStore) NamedNames(string) ([]string, error) {
	return []string{"api-key", "not/a/valid/name"}, s.err
}
func (s *namedSecretTestStore) GetNamed(namespace, alias string) (string, error) {
	return s.values["named:"+namespace+":"+alias], s.err
}
func (s *namedSecretTestStore) DeleteNamed(namespace, alias string) {
	if s.err == nil {
		delete(s.values, "named:"+namespace+":"+alias)
	}
}
func (s *namedSecretTestStore) ApplyMigration(updates []secrets.Value, commit func() error) error {
	if s.beforeApply != nil {
		s.beforeApply()
	}
	if s.err != nil {
		return s.err
	}
	for _, u := range updates {
		if u.Expected != nil && s.values[u.ID] != *u.Expected {
			return errors.New("changed")
		}
		s.values[u.ID] = u.Text
	}
	return commit()
}

func TestNamedSecretListAndCLIExposeMetadataOnly(t *testing.T) {
	a := &App{secrets: &namedSecretTestStore{values: map[string]string{"named:cli:api-key": "private-value"}}}
	entries, err := a.ListNamedSecrets()
	if err != nil || !reflect.DeepEqual(entries, []NamedSecret{{Alias: "api-key", Reference: "secret://api-key"}}) {
		t.Fatalf("metadata: %v %v", entries, err)
	}
	w := httptest.NewRecorder()
	a.handleCliSecrets(w, httptest.NewRequest("GET", "/cli/secrets", nil))
	var response struct {
		Secrets []NamedSecret `json:"secrets"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil || !reflect.DeepEqual(entries, response.Secrets) {
		t.Fatalf("CLI list: %s", w.Body.String())
	}
	if strings.Contains(w.Body.String(), "private-value") || strings.Contains(w.Body.String(), "value") {
		t.Fatal("list leaked a value")
	}
}

func TestManualNamedSecretSaveReplaceResolveAndDelete(t *testing.T) {
	store := &namedSecretTestStore{values: map[string]string{}}
	a := &App{secrets: store}
	if err := a.SaveNamedSecret(" api-key ", "  original  ", false); err != nil {
		t.Fatal(err)
	}
	if err := a.SaveNamedSecret("api-key", "accidental-overwrite", false); err == nil {
		t.Fatal("add replaced existing secret")
	}
	if store.values["named:cli:api-key"] != "  original  " {
		t.Fatal("secret was trimmed or overwritten")
	}
	if err := a.SaveNamedSecret("api-key", "replacement", true); err != nil {
		t.Fatal(err)
	}
	values, refs, err := a.resolveCliSecretRefs(map[string]string{"API_KEY": "secret://api-key"})
	if err != nil || values["API_KEY"] != "replacement" || refs[0] != "API_KEY=secret://api-key" {
		t.Fatal("UI secret not available to execution")
	}
	if err := a.DeleteNamedSecret("api-key"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := a.resolveCliSecretRefs(map[string]string{"API_KEY": "api-key"}); err == nil {
		t.Fatal("deleted secret resolved")
	}
}

func TestManualNamedSecretRejectsInvalidInputAndConcurrentEdit(t *testing.T) {
	store := &namedSecretTestStore{values: map[string]string{}}
	a := &App{secrets: store}
	for _, alias := range []string{"", "bad/name", "secret://api-key", strings.Repeat("a", 65)} {
		if a.SaveNamedSecret(alias, "value", false) == nil || a.DeleteNamedSecret(alias) == nil {
			t.Fatal("invalid alias accepted")
		}
	}
	for _, value := range []string{"", "line\nbreak", "carriage\rreturn", "nul\x00", strings.Repeat("a", 65537)} {
		if a.SaveNamedSecret("api-key", value, false) == nil {
			t.Fatal("invalid value accepted")
		}
	}
	if a.SaveNamedSecret("missing", "value", true) == nil {
		t.Fatal("replace created missing name")
	}
	store.beforeApply = func() { store.values["named:cli:api-key"] = "concurrent" }
	if a.SaveNamedSecret("api-key", "new", false) == nil || store.values["named:cli:api-key"] != "concurrent" {
		t.Fatal("concurrent edit lost")
	}
}

func TestManualNamedSecretErrorsNeverEchoCredentialStoreData(t *testing.T) {
	store := &namedSecretTestStore{values: map[string]string{}, err: errors.New("store failure containing private-value")}
	a := &App{secrets: store}
	_, listErr := a.ListNamedSecrets()
	for _, err := range []error{listErr, a.SaveNamedSecret("api-key", "private-value", false), a.DeleteNamedSecret("api-key")} {
		if err == nil || strings.Contains(err.Error(), "private-value") {
			t.Fatal("failure leaked or reported success")
		}
	}
	store.err = nil
	store.beforeApply = func() { store.err = errors.New("write failed: private-value") }
	if err := a.SaveNamedSecret("api-key", "private-value", false); err == nil || strings.Contains(err.Error(), "private-value") {
		t.Fatal("write failure leaked or reported success")
	}
}

func TestCliNamedSecretDeleteReportsStorageFailure(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "storage-failure"}[failed], func(t *testing.T) {
			store := &namedSecretTestStore{values: map[string]string{"named:cli:api-key": "private-value"}}
			if failed {
				store.err = errors.New("native delete failed: private-value")
			}
			a := NewApp()
			a.secrets = store
			a.ctx.Set(context.Background())
			a.cliApprovalDelay = time.Millisecond
			prompts := 0
			a.cliConfirmBatchFn = func(string, []string) bool { prompts++; return true }
			w := httptest.NewRecorder()
			a.handleCliSecrets(w, httptest.NewRequest(http.MethodDelete, "/cli/secrets?alias=api-key", nil))
			if prompts != 1 || strings.Contains(w.Body.String(), "private-value") {
				t.Fatalf("delete approval or redaction failed: %s", w.Body.String())
			}
			if failed {
				if w.Code != http.StatusInternalServerError || strings.Contains(w.Body.String(), `"deleted":true`) || store.values["named:cli:api-key"] != "private-value" {
					t.Fatalf("failed deletion reported success or lost the credential: %s", w.Body.String())
				}
			} else if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"deleted":true`) || store.values["named:cli:api-key"] != "" {
				t.Fatalf("successful deletion: %s", w.Body.String())
			}
		})
	}
}
