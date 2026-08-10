package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRestoreTextFilesAllowsSupportedExistingFilesOnly(t *testing.T) {
	dir := t.TempDir()
	markdown := filepath.Join(dir, "notes.md")
	pdf := filepath.Join(dir, "manual.pdf")
	binary := filepath.Join(dir, "secret.bin")
	if err := os.WriteFile(markdown, []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, []byte("ignored"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pdf, []byte("%PDF-1.7\n"), 0600); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	restored := app.RestoreTextFiles([]string{markdown, markdown, pdf, binary, filepath.Join(dir, "missing.txt")})
	if len(restored) != 2 || restored[0] != markdown || restored[1] != pdf {
		t.Fatalf("unexpected restored paths: %#v", restored)
	}
	content, err := app.ReadLocalFile(markdown)
	if err != nil {
		t.Fatal(err)
	}
	if content != "hello" {
		t.Fatalf("unexpected restored content: %q", content)
	}
}
