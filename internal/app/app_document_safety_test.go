package app

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeDocumentFixture(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestBinaryDocumentsCannotBeReadOrOverwrittenAsText(t *testing.T) {
	for _, fixture := range []struct {
		name string
		data []byte
	}{
		{"Dockerfile.exe", []byte{'M', 'Z', 0, 1, 2}},
		{".env.zip", []byte{'P', 'K', 3, 4, 0}},
		{"legacy.txt", []byte{'c', 'a', 'f', 0xe9}},
		{"utf16.txt", []byte{0xff, 0xfe, 'a', 0}},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), fixture.name)
			writeDocumentFixture(t, path, fixture.data)
			a := NewApp()
			a.allowFile(path)
			if _, err := a.ReadLocalFile(path); err == nil || !strings.Contains(err.Error(), documentNotText) {
				t.Fatalf("binary read was not rejected: %v", err)
			}
			if err := a.WriteLocalFile(path, "replacement"); err == nil || !strings.Contains(err.Error(), documentNotText) {
				t.Fatalf("binary overwrite was not rejected: %v", err)
			}
			got, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(got, fixture.data) {
				t.Fatalf("original binary changed: %v", err)
			}
		})
	}
}

func TestTextDocumentPreservesUTF8AndRefusesAFileChangedToBinary(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env.production")
	original := []byte("\ufeff标题=中文😀\r\n\tvalue=1\r\n")
	writeDocumentFixture(t, path, original)
	a := NewApp()
	a.allowFile(path)
	if got, err := a.ReadLocalFile(path); err != nil || got != string(original) {
		t.Fatalf("UTF-8 read changed content: %q %v", got, err)
	}
	if err := a.WriteLocalFile(path, string(original)); err != nil {
		t.Fatal(err)
	}
	if err := a.WriteLocalFile(path, "invalid\x00text"); err == nil {
		t.Fatal("binary payload accepted")
	}
	binary := []byte{'P', 'K', 0, 0}
	writeDocumentFixture(t, path, binary)
	if err := a.WriteLocalFile(path, "stale editor text"); err == nil {
		t.Fatal("file changed to binary was overwritten")
	}
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, binary) {
		t.Fatalf("binary replacement changed: %v", err)
	}
}

func TestDocumentSiblingListsSkipSymbolicLinks(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, "readme.md")
	writeDocumentFixture(t, base, []byte("# Local"))
	outside := filepath.Join(t.TempDir(), "secret")
	writeDocumentFixture(t, outside, []byte("outside secret"))
	link := filepath.Join(dir, "link.md")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	for _, markdownOnly := range []bool{false, true} {
		a := NewApp()
		a.allowFile(base)
		list := a.ListTextFilesInDir
		if markdownOnly {
			list = a.ListMarkdownFilesInDir
		}
		files, err := list(base)
		if err != nil || len(files) != 1 || files[0] != base {
			t.Fatalf("link entered the directory list: %v %v", files, err)
		}
		if a.isFileAllowed(link) {
			t.Fatal("directory listing authorized a link")
		}
	}
}

func TestDocumentReadsRejectLinksReplacedAfterListing(t *testing.T) {
	for _, ext := range []string{".txt", ".pdf"} {
		t.Run(ext, func(t *testing.T) {
			dir := t.TempDir()
			base := filepath.Join(dir, "readme.md")
			document := filepath.Join(dir, "sibling"+ext)
			outside := filepath.Join(t.TempDir(), "outside"+ext)
			writeDocumentFixture(t, base, []byte("# Local"))
			writeDocumentFixture(t, document, []byte("%PDF-1.7\noriginal\n"))
			secret := []byte("%PDF-1.7\noutside secret\n")
			writeDocumentFixture(t, outside, secret)
			a := NewApp()
			a.allowFile(base)
			if _, err := a.ListTextFilesInDir(base); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(document); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, document); err != nil {
				t.Skipf("symlinks unavailable: %v", err)
			}
			if ext == ".txt" {
				if _, err := a.ReadLocalFile(document); err == nil {
					t.Fatal("replacement link was read")
				}
				if err := a.WriteLocalFile(document, "overwrite"); err == nil {
					t.Fatal("replacement link was writable")
				}
			} else {
				if _, err := a.ReadLocalPDFBase64(document); err == nil {
					t.Fatal("replacement PDF link was read")
				}
				response := httptest.NewRecorder()
				DocumentAssetHandler(a).ServeHTTP(response, httptest.NewRequest(http.MethodGet, localPDFAssetPath+"?path="+url.QueryEscape(document), nil))
				if response.Code != http.StatusForbidden {
					t.Fatalf("PDF asset escaped authorization: %d", response.Code)
				}
			}
			got, err := os.ReadFile(outside)
			if err != nil || !bytes.Equal(got, secret) {
				t.Fatalf("outside target changed: %v", err)
			}
		})
	}
}

func TestDocumentAuthorizationRejectsReplacedDirectories(t *testing.T) {
	parent := t.TempDir()
	dir := filepath.Join(parent, "docs")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	base := filepath.Join(dir, "readme.md")
	sibling := filepath.Join(dir, "next.txt")
	writeDocumentFixture(t, base, []byte("# Original"))
	writeDocumentFixture(t, sibling, []byte("original"))
	a := NewApp()
	a.allowFile(base)
	if _, err := a.ListTextFilesInDir(base); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(dir, filepath.Join(parent, "previous-docs")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	writeDocumentFixture(t, base, []byte("# Replacement"))
	writeDocumentFixture(t, sibling, []byte("replacement"))
	a.RestoreTextFiles([]string{base, sibling})
	if _, err := a.ReadLocalFile(sibling); err == nil {
		t.Fatal("replacement directory inherited read access")
	}
	if err := a.WriteLocalFile(sibling, "overwrite"); err == nil {
		t.Fatal("replacement directory inherited write access")
	}
	if _, err := a.ListTextFilesInDir(base); err == nil {
		t.Fatal("replacement directory inherited listing access")
	}
	if _, err := a.ResolveLocalMarkdownLink(base, "next.txt"); err == nil {
		t.Fatal("replacement directory inherited relative-link access")
	}
	got, err := os.ReadFile(sibling)
	if err != nil || string(got) != "replacement" {
		t.Fatalf("replacement directory changed: %q %v", got, err)
	}
	a.allowFile(sibling)
	if got, err := a.ReadLocalFile(sibling); err != nil || got != "replacement" {
		t.Fatalf("explicitly reopening should restore access: %q %v", got, err)
	}
}
