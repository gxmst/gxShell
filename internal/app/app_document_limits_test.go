package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTextDocumentsReadAndSaveTwentyMiBWithoutChangingUTF8(t *testing.T) {
	const limit = 20 * 1024 * 1024
	// The byte boundary intentionally falls after a multi-byte UTF-8 document.
	payload := strings.Repeat("中", (limit-2)/3) + "ab"
	for _, name := range []string{"notes.txt", "notes.md"} {
		t.Run(name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), name)
			writeDocumentFixture(t, file, []byte(payload))
			a := NewApp()
			a.allowFile(file)
			if got, err := a.ReadLocalFile(file); err != nil || got != payload {
				t.Fatalf("20 MiB read failed or changed bytes: %v", err)
			}
			replacement := payload[:len(payload)-1] + "c"
			if err := a.WriteLocalFile(file, replacement); err != nil {
				t.Fatalf("20 MiB save failed: %v", err)
			}
			if err := a.WriteLocalFile(file, replacement+"x"); err == nil || !strings.Contains(err.Error(), "20 MiB") {
				t.Fatalf("oversized save was not rejected with the current limit: %v", err)
			}
			if got, err := os.ReadFile(file); err != nil || string(got) != replacement {
				t.Fatalf("rejected save changed original: %v", err)
			}
			writeDocumentFixture(t, file, []byte(replacement+"x"))
			if _, err := a.ReadLocalFile(file); err == nil || !strings.Contains(err.Error(), "too large") {
				t.Fatalf("oversized read was not rejected: %v", err)
			}
		})
	}
}

func TestRemoteTextSaveRejectsOversizeBeforeTransport(t *testing.T) {
	a := NewApp()
	err := a.WriteRemoteTextFile("missing-session", "/notes.txt", strings.Repeat("x", 20*1024*1024+1))
	if err == nil || !strings.Contains(err.Error(), "20 MiB") {
		t.Fatalf("remote limit should be checked before contacting SFTP: %v", err)
	}
}
