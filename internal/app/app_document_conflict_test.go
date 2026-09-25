package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A tab can sit open for hours while certbot, ansible or a colleague's SSH
// session rewrites the file underneath it. Saving then has to report the
// conflict instead of quietly discarding that work.
func TestWriteLocalFileReportsAConflictInsteadOfOverwriting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nginx.conf")
	if err := os.WriteFile(path, []byte("server_name old;\n"), 0600); err != nil {
		t.Fatal(err)
	}
	a := NewApp()
	a.allowFile(path)

	loaded, err := a.ReadLocalFile(path)
	if err != nil {
		t.Fatal(err)
	}
	external := []byte("server_name new;\n")
	if err := os.WriteFile(path, external, 0600); err != nil {
		t.Fatal(err)
	}

	result, err := a.WriteLocalFile(path, "server_name edited;\n", loaded.Version)
	if err != nil {
		t.Fatalf("a conflict is a decision, not an error: %v", err)
	}
	if !result.Conflict || result.Saved {
		t.Fatalf("result = %+v, want a conflict with nothing written", result)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(external) {
		t.Fatalf("the external edit was overwritten: %q, %v", got, err)
	}

	// "Overwrite" sends the version the conflict reported, so the second
	// attempt is not a conflict again.
	overwrite, err := a.WriteLocalFile(path, "server_name edited;\n", result.Version)
	if err != nil {
		t.Fatal(err)
	}
	if !overwrite.Saved || overwrite.Conflict {
		t.Fatalf("result = %+v, want a save", overwrite)
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != "server_name edited;\n" {
		t.Fatalf("overwrite did not land: %q, %v", got, err)
	}

	// The version a successful save returns is the one the next save must send,
	// or every edit after the first would conflict with itself.
	again, err := a.WriteLocalFile(path, "server_name edited twice;\n", overwrite.Version)
	if err != nil || !again.Saved {
		t.Fatalf("saving the version just returned conflicted: %+v %v", again, err)
	}
}

// Size and modification time cannot tell two edits apart, which is why the
// version is a content hash.
func TestDocumentVersionDistinguishesSameLengthEdits(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.env")
	if err := os.WriteFile(path, []byte("TOKEN=aaaa\n"), 0600); err != nil {
		t.Fatal(err)
	}
	a := NewApp()
	a.allowFile(path)

	first, err := a.ReadLocalFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("TOKEN=bbbb\n"), 0600); err != nil {
		t.Fatal(err)
	}
	second, err := a.ReadLocalFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if first.Version == second.Version {
		t.Fatal("a same-length edit produced the same version")
	}
	if result, err := a.WriteLocalFile(path, "TOKEN=cccc\n", first.Version); err != nil || !result.Conflict {
		t.Fatalf("same-length edit was not detected as a conflict: %+v %v", result, err)
	}
}

// An empty expectedVersion is "write regardless": a brand new document has
// nothing to compare against.
func TestWriteLocalFileWithoutAnExpectedVersionWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "notes.md")
	if err := os.WriteFile(path, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	a := NewApp()
	a.allowFile(path)

	result, err := a.WriteLocalFile(path, "new", "")
	if err != nil || !result.Saved || result.Conflict {
		t.Fatalf("result = %+v, %v", result, err)
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != "new" {
		t.Fatalf("content = %q, %v", got, err)
	}
}

// A file that disappeared while the tab was open is the case where recreating
// it silently is most likely to be wrong.
func TestWriteLocalFileConflictsWhenTheFileDisappeared(t *testing.T) {
	path := filepath.Join(t.TempDir(), "removed.conf")
	if err := os.WriteFile(path, []byte("still here"), 0600); err != nil {
		t.Fatal(err)
	}
	a := NewApp()
	a.allowFile(path)
	loaded, err := a.ReadLocalFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}

	result, err := a.WriteLocalFile(path, "recreated", loaded.Version)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Conflict {
		t.Fatalf("result = %+v, want a conflict", result)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("the conflict recreated the file: %v", err)
	}
	// Choosing to overwrite recreates it.
	if overwrite, err := a.WriteLocalFile(path, "recreated", result.Version); err != nil || !overwrite.Saved {
		t.Fatalf("overwrite did not recreate the file: %+v %v", overwrite, err)
	}
}

func TestDocumentSaveConflictPolicy(t *testing.T) {
	cases := []struct {
		name     string
		expected string
		current  string
		want     bool
	}{
		{"no expectation writes regardless", "", "anything", false},
		{"matching version saves", "v1", "v1", false},
		{"different version conflicts", "v1", "v2", true},
		{"a vanished file conflicts rather than being recreated", "v1", "", true},
		{"a new file has no expectation and cannot conflict", "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := documentSaveConflict(tc.expected, tc.current); got != tc.want {
				t.Errorf("documentSaveConflict(%q, %q) = %v, want %v", tc.expected, tc.current, got, tc.want)
			}
		})
	}
}

// The conflict has to be distinguishable from a plain write failure: the caller
// offers "reload / overwrite / keep editing" for one and only "try again" for
// the other.
func TestConflictResultCarriesNoErrorAndNoWrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keep.conf")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	a := NewApp()
	a.allowFile(path)
	loaded, err := a.ReadLocalFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}

	result, err := a.WriteLocalFile(path, "draft", loaded.Version)
	if err != nil {
		t.Fatalf("conflict returned an error: %v", err)
	}
	if result.Version != documentVersion([]byte("external")) {
		t.Errorf("conflict version = %q, want the version now on disk", result.Version)
	}
	if strings.TrimSpace(result.Version) == "" {
		t.Error("conflict version is empty; a retry could not resolve it")
	}
}
