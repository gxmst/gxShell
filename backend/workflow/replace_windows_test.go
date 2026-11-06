//go:build windows

package workflow

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func lockedHistoryDestination(t *testing.T) (string, string, windows.Handle) {
	t.Helper()
	dir := t.TempDir()
	source, destination := filepath.Join(dir, "new.json"), filepath.Join(dir, "run.json")
	if err := os.WriteFile(source, []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	path, err := windows.UTF16PtrFromString(destination)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(path, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	return source, destination, handle
}

func TestHistoryReplacementRetriesTemporaryWindowsSharingLock(t *testing.T) {
	source, destination, handle := lockedHistoryDestination(t)
	released := make(chan struct{})
	go func() { time.Sleep(60 * time.Millisecond); _ = windows.CloseHandle(handle); close(released) }()
	err := replaceHistoryFile(source, destination)
	<-released
	if err != nil {
		t.Fatalf("temporary sharing lock was not retried: %v", err)
	}
	data, _ := os.ReadFile(destination)
	if string(data) != "new" {
		t.Fatal("replacement did not preserve the new report")
	}
}

func TestHistoryReplacementKeepsOldFileWhenWindowsLockPersists(t *testing.T) {
	source, destination, handle := lockedHistoryDestination(t)
	err := replaceHistoryFile(source, destination)
	_ = windows.CloseHandle(handle)
	if err == nil {
		t.Fatal("persistent lock was reported as success")
	}
	data, _ := os.ReadFile(destination)
	if string(data) != "old" {
		t.Fatal("failed replacement deleted or changed the old report")
	}
	if _, err := os.Stat(source); err != nil {
		t.Fatal("failed replacement consumed the unsaved source")
	}
}
