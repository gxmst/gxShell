package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRestoreTextFilesAllowsSupportedExistingFilesOnly(t *testing.T) {
	dir := t.TempDir()
	markdown := filepath.Join(dir, "notes.md")
	binary := filepath.Join(dir, "secret.bin")
	if err := os.WriteFile(markdown, []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, []byte("ignored"), 0600); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	restored := app.RestoreTextFiles([]string{markdown, markdown, binary, filepath.Join(dir, "missing.txt")})
	if len(restored) != 1 || restored[0] != markdown {
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
