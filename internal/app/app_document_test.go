package app

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

type trackedDocument struct {
	*os.File
	closeCalls *atomic.Int32
}

func (d *trackedDocument) Close() error {
	d.closeCalls.Add(1)
	return d.File.Close()
}

func TestDocumentAssetHandlerStreamsAuthorizedPDFAndSupportsRanges(t *testing.T) {
	dir := t.TempDir()
	pdfPath := filepath.Join(dir, "manual.pdf")
	pdf := []byte("%PDF-1.7\n0123456789\n")
	if err := os.WriteFile(pdfPath, pdf, 0600); err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	handler := DocumentAssetHandler(app)

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, localPDFAssetPath+"?path="+pdfPath, nil))
	if unauthorized.Code != http.StatusForbidden {
		t.Fatalf("unauthorized status = %d, want %d", unauthorized.Code, http.StatusForbidden)
	}

	app.allowFile(pdfPath)
	request := httptest.NewRequest(http.MethodGet, localPDFAssetPath+"?path="+pdfPath, nil)
	request.Header.Set("Range", "bytes=0-4")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusPartialContent {
		t.Fatalf("range status = %d, want %d", response.Code, http.StatusPartialContent)
	}
	data, err := io.ReadAll(response.Result().Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "%PDF-" {
		t.Fatalf("range body = %q, want PDF header", data)
	}
	if got := response.Header().Get("Content-Type"); got != "application/pdf" {
		t.Fatalf("content type = %q", got)
	}
}

func TestDocumentAssetHandlerStreamsRemotePDFRangeAndClosesHandle(t *testing.T) {
	dir := t.TempDir()
	pdfPath := filepath.Join(dir, "remote manual.pdf")
	if err := os.WriteFile(pdfPath, []byte("%PDF-1.7\n0123456789\n"), 0600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(pdfPath)
	if err != nil {
		t.Fatal(err)
	}

	var closeCalls atomic.Int32
	openRemote := func(sessionID, remotePath string) (documentReadSeekCloser, os.FileInfo, error) {
		if sessionID != "session-1" || remotePath != "/srv/remote manual.pdf" {
			t.Fatalf("remote opener got session=%q path=%q", sessionID, remotePath)
		}
		file, err := os.Open(pdfPath)
		if err != nil {
			return nil, nil, err
		}
		return &trackedDocument{File: file, closeCalls: &closeCalls}, info, nil
	}
	handler := documentAssetHandler(NewApp(), openRemote)
	requestURL := remotePDFAssetPath + "?sessionId=session-1&path=" + url.QueryEscape("/srv/remote manual.pdf")
	request := httptest.NewRequest(http.MethodGet, requestURL, nil)
	request.Header.Set("Range", "bytes=0-4")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusPartialContent {
		t.Fatalf("range status = %d, want %d", response.Code, http.StatusPartialContent)
	}
	data, err := io.ReadAll(response.Result().Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "%PDF-" {
		t.Fatalf("range body = %q, want PDF header", data)
	}
	if got := closeCalls.Load(); got != 1 {
		t.Fatalf("remote handle close calls = %d, want 1", got)
	}
	if got := response.Header().Get("Content-Disposition"); got != `inline; filename="remote manual.pdf"` {
		t.Fatalf("content disposition = %q", got)
	}
}

func TestOpenRemotePDFRejectsMissingSessionAndNonPDFBeforeSFTP(t *testing.T) {
	app := NewApp()
	if _, _, err := app.openRemotePDF("", "/srv/manual.pdf"); err == nil {
		t.Fatal("missing remote session should be rejected")
	}
	if _, _, err := app.openRemotePDF("session-1", "/srv/manual.txt"); err == nil {
		t.Fatal("non-PDF remote path should be rejected")
	}
}

func TestRemoteSupportedDocumentPathIncludesPDFButNotArbitraryFiles(t *testing.T) {
	for _, filePath := range []string{"/srv/README.md", "/srv/data.JSON", "/srv/manual.PDF"} {
		if !isRemoteSupportedDocumentPath(filePath) {
			t.Fatalf("expected %q to be a supported remote document", filePath)
		}
	}
	if isRemoteSupportedDocumentPath("/srv/archive.zip") {
		t.Fatal("archive.zip must not be treated as a browsable remote document")
	}
}

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
