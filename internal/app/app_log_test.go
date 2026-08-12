package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gxShell/backend/config"
)

func TestReadLogFileReturnsBoundedTail(t *testing.T) {
	store, err := config.NewStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	app.store = store
	path := filepath.Join(store.DataDir(), "logs", "large.log")
	old := strings.Repeat("old-line\n", int(logViewerTailBytes/4))
	tail := "latest-line\n"
	if err := os.WriteFile(path, []byte(old+tail), 0600); err != nil {
		t.Fatal(err)
	}

	got, err := app.ReadLogFile("large.log")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got, logViewerTruncationNotice) {
		t.Fatalf("missing truncation notice: %.80q", got)
	}
	if !strings.HasSuffix(got, tail) {
		t.Fatalf("tail missing from result")
	}
	if len(got) > int(logViewerTailBytes)+len(logViewerTruncationNotice) {
		t.Fatalf("result size = %d, exceeds bounded tail", len(got))
	}
}

func TestReadLogFilePreservesLongSingleLineTail(t *testing.T) {
	store, err := config.NewStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	app.store = store
	path := filepath.Join(store.DataDir(), "logs", "single-line.log")
	content := strings.Repeat("x", int(logViewerTailBytes)+128)
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}

	got, err := app.ReadLogFile("single-line.log")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got, logViewerTruncationNotice) {
		t.Fatalf("missing truncation notice")
	}
	tail := strings.TrimPrefix(got, logViewerTruncationNotice)
	if len(tail) != int(logViewerTailBytes) {
		t.Fatalf("tail size = %d, want %d", len(tail), logViewerTailBytes)
	}
	if tail != content[len(content)-int(logViewerTailBytes):] {
		t.Fatalf("single-line tail does not match source")
	}
}
