package app

import (
	"bytes"
	"fmt"
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
	app.allowFile(markdown)
	app.allowFile(pdf)
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

func TestRestoreTextFilesRejectsUnapprovedPaths(t *testing.T) {
	app := NewApp()
	path := filepath.Join(t.TempDir(), "private.json")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if restored := app.RestoreTextFiles([]string{path}); len(restored) != 0 {
		t.Fatalf("unapproved path restored: %v", restored)
	}
	if _, err := app.ReadLocalFile(path); err == nil {
		t.Fatal("unapproved path became readable")
	}
	if err := app.WriteLocalFile(path, "changed"); err == nil {
		t.Fatal("unapproved path became writable")
	}
}

func TestDocumentAuthorizationSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	history := filepath.Join(dir, documentAuthorizationFilename)
	approved := filepath.Join(dir, "approved.txt")
	unapproved := filepath.Join(dir, "unapproved.txt")
	for _, path := range []string{approved, unapproved} {
		if err := os.WriteFile(path, []byte("content"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	first := NewApp()
	if err := first.allowedFiles.loadHistory(history); err != nil {
		t.Fatal(err)
	}
	first.allowFile(approved)
	if _, err := first.ResolveLocalMarkdownLink(approved, documentAuthorizationFilename); err == nil {
		t.Fatal("authorization history must not be an editable sibling")
	}
	if err := first.WriteLocalFile(history, "[]"); err == nil {
		t.Fatal("renderer must not edit authorization history")
	}
	second := NewApp()
	if err := second.allowedFiles.loadHistory(history); err != nil {
		t.Fatal(err)
	}
	if _, err := second.ReadLocalFile(approved); err == nil {
		t.Fatal("loading history should not itself grant file access")
	}
	restored := second.RestoreTextFiles([]string{unapproved, approved})
	if len(restored) != 1 || restored[0] != approved {
		t.Fatalf("restored = %v", restored)
	}
	if text, err := second.ReadLocalFile(approved); err != nil || text != "content" {
		t.Fatalf("restored read: %q, %v", text, err)
	}
}

func TestCorruptDocumentHistoryDoesNotAuthorizePaths(t *testing.T) {
	dir := t.TempDir()
	history := filepath.Join(dir, documentAuthorizationFilename)
	document := filepath.Join(dir, "document.txt")
	if err := os.WriteFile(history, []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(document, []byte("content"), 0600); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	if err := app.allowedFiles.loadHistory(history); err == nil {
		t.Fatal("expected invalid history error")
	}
	if restored := app.RestoreTextFiles([]string{document}); len(restored) != 0 {
		t.Fatalf("invalid history granted access: %v", restored)
	}
}

func TestDocumentHistoryWriteFailureKeepsOnlySessionAccess(t *testing.T) {
	dir := t.TempDir()
	history := filepath.Join(dir, "missing-directory", documentAuthorizationFilename)
	document := filepath.Join(dir, "document.txt")
	if err := os.WriteFile(document, []byte("content"), 0600); err != nil {
		t.Fatal(err)
	}
	first := NewApp()
	if err := first.allowedFiles.loadHistory(history); err != nil {
		t.Fatal(err)
	}
	if path, err := first.allowedFiles.allow(document); err == nil || path != document {
		t.Fatalf("expected persistence error with active path, got %q, %v", path, err)
	}
	if _, err := first.ReadLocalFile(document); err != nil {
		t.Fatalf("native-selected document should remain readable: %v", err)
	}
	second := NewApp()
	if err := second.allowedFiles.loadHistory(history); err != nil {
		t.Fatal(err)
	}
	if restored := second.RestoreTextFiles([]string{document}); len(restored) != 0 {
		t.Fatalf("failed persistence must not authorize after restart: %v", restored)
	}
}

func TestSiblingDocumentAuthorizationSurvivesRestart(t *testing.T) {
	for _, markdownOnly := range []bool{false, true} {
		name := "text"
		if markdownOnly {
			name = "markdown"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			history := filepath.Join(dir, documentAuthorizationFilename)
			opened := filepath.Join(dir, "opened.md")
			sibling := filepath.Join(dir, "sibling.md")
			text := filepath.Join(dir, "notes.txt")
			for _, path := range []string{opened, sibling, text} {
				if err := os.WriteFile(path, []byte("content"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			first := NewApp()
			if err := first.allowedFiles.loadHistory(history); err != nil {
				t.Fatal(err)
			}
			first.allowFile(opened)
			list := first.ListTextFilesInDir
			if markdownOnly {
				list = first.ListMarkdownFilesInDir
			}
			files, err := list(opened)
			if err != nil {
				t.Fatal(err)
			}
			second := NewApp()
			if err := second.allowedFiles.loadHistory(history); err != nil {
				t.Fatal(err)
			}
			if restored := second.RestoreTextFiles(files); len(restored) != len(files) {
				t.Fatalf("siblings missing from persisted history: %v", restored)
			}
			if markdownOnly && second.allowedFiles.restore(text) {
				t.Fatal("Markdown-only listing authorized a text sibling")
			}
			if _, err := second.ReadLocalFile(sibling); err != nil {
				t.Fatalf("restored sibling should be readable: %v", err)
			}
		})
	}
}

func TestOversizedAuthorizationBatchPreservesExistingHistory(t *testing.T) {
	dir := t.TempDir()
	history := filepath.Join(dir, documentAuthorizationFilename)
	set := newAllowedFileSet()
	if err := set.loadHistory(history); err != nil {
		t.Fatal(err)
	}
	approved, err := set.allow(filepath.Join(dir, "approved.md"))
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(history)
	if err != nil {
		t.Fatal(err)
	}
	newPath := filepath.Join(dir, "new.md")
	batch := []string{approved, newPath, newPath}
	for index := 0; index < maxDocumentAuthorizationBytes/64; index++ {
		batch = append(batch, filepath.Join(dir, fmt.Sprintf("%060d.md", index)))
	}
	if _, err := set.allowMany(batch); err == nil {
		t.Fatal("expected oversized history error")
	}
	if !set.contains(newPath) {
		t.Fatal("persistence failure should retain the session authorization")
	}
	if set.history[allowedFileKey(newPath)] || !set.history[allowedFileKey(approved)] {
		t.Fatal("failed batch did not roll back only its new history entries")
	}
	after, err := os.ReadFile(history)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("failed batch damaged existing history: %v", err)
	}
}
