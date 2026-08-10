package app

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestReadLocalPDFBase64RequiresAuthorizationAndValidHeader(t *testing.T) {
	dir := t.TempDir()
	pdfPath := filepath.Join(dir, "manual.pdf")
	pdf := []byte("%PDF-1.7\n% test document\n")
	if err := os.WriteFile(pdfPath, pdf, 0600); err != nil {
		t.Fatal(err)
	}

	app := NewApp()
	if _, err := app.ReadLocalPDFBase64(pdfPath); err == nil {
		t.Fatal("PDF read should require an explicitly authorized path")
	}
	app.allowFile(pdfPath)
	encoded, err := app.ReadLocalPDFBase64(pdfPath)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded) != string(pdf) {
		t.Fatalf("decoded PDF = %q, want %q", decoded, pdf)
	}

	invalidPath := filepath.Join(dir, "fake.pdf")
	if err := os.WriteFile(invalidPath, []byte("not a pdf"), 0600); err != nil {
		t.Fatal(err)
	}
	app.allowFile(invalidPath)
	if _, err := app.ReadLocalPDFBase64(invalidPath); err == nil {
		t.Fatal("a .pdf extension without a PDF header should be rejected")
	}
}

func TestPDFCannotUseTextReadOrWritePaths(t *testing.T) {
	path := filepath.Join(t.TempDir(), "manual.pdf")
	original := []byte("%PDF-1.7\noriginal\n")
	if err := os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	app.allowFile(path)
	if _, err := app.ReadLocalFile(path); err == nil {
		t.Fatal("PDF should not pass through the text reader")
	}
	if err := app.WriteLocalFile(path, "overwritten"); err == nil {
		t.Fatal("PDF should not pass through the text writer")
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(original) {
		t.Fatalf("PDF was modified: %q", got)
	}
}
