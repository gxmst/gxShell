package sessionlog

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"gxShell/backend/types"
)

func retainedLog(t *testing.T, dir string, size int64, modified time.Time) string {
	t.Helper()
	filename := filepath.Join(dir, "2026-09-12-fixture-"+types.NewID("log")+"-0001.log")
	f, err := os.OpenFile(filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	err = f.Truncate(size)
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		t.Fatalf("create log: %v %v", err, closeErr)
	}
	if err := os.Chtimes(filename, modified, modified); err != nil {
		t.Fatal(err)
	}
	return filename
}

func TestRetentionRequiresOptIn(t *testing.T) {
	dir := t.TempDir()
	old := retainedLog(t, dir, 2*1024*1024, time.Now().AddDate(-1, 0, 0))
	m := NewManager(dir, nil)
	if err := m.UpdateRetention(types.SessionLogRetentionSettings{}); err != nil {
		t.Fatal(err)
	}
	w, err := m.New("server", types.SessionLogSettings{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(old); err != nil {
		t.Fatal("disabled retention removed an existing log")
	}
}

func TestRetentionRejectsInvalidDeletionSettings(t *testing.T) {
	dir := t.TempDir()
	old := retainedLog(t, dir, 2*1024*1024, time.Now().AddDate(-1, 0, 0))
	m := NewManager(dir, nil)
	for _, policy := range []types.SessionLogRetentionSettings{
		{Enabled: true, MaxAgeDays: 0, MaxTotalMB: 1},
		{Enabled: true, MaxAgeDays: 30, MaxTotalMB: 102401},
	} {
		if err := m.UpdateRetention(policy); err == nil {
			t.Fatal("invalid retention settings accepted")
		}
	}
	if _, err := os.Stat(old); err != nil {
		t.Fatal("invalid settings deleted a log")
	}
}

func TestRetentionRemovesExpiredThenOldestClosedLogs(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	expired := retainedLog(t, dir, 128, now.Add(-72*time.Hour))
	older := retainedLog(t, dir, 700*1024, now.Add(-26*time.Hour))
	newer := retainedLog(t, dir, 700*1024, now.Add(-time.Hour))
	other := filepath.Join(dir, "user-notes.log")
	if err := os.WriteFile(other, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(dir, "2026-09-12-dir-"+types.NewID("log")+"-0001.log")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	m := NewManager(dir, nil)
	m.now = func() time.Time { return now }
	if err := m.UpdateRetention(types.SessionLogRetentionSettings{Enabled: true, MaxAgeDays: 2, MaxTotalMB: 1}); err != nil {
		t.Fatal(err)
	}
	for _, filename := range []string{expired, older} {
		if _, err := os.Stat(filename); !os.IsNotExist(err) {
			t.Fatalf("old log retained: %s %v", filename, err)
		}
	}
	for _, filename := range []string{newer, other, directory} {
		if _, err := os.Stat(filename); err != nil {
			t.Fatalf("unrelated or recent file removed: %s", filename)
		}
	}
}

func TestRetentionProtectsEveryPartOfAnActiveSession(t *testing.T) {
	dir := t.TempDir()
	m := NewManager(dir, nil)
	w, err := m.New("active", types.SessionLogSettings{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })
	w.maxFile = 8
	w.WriteStream(0, "1234567\n1234567\n")
	var files []string
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		files, _ = filepath.Glob(filepath.Join(dir, "*.log"))
		if len(files) == 2 {
			first, _ := os.Stat(files[0])
			second, _ := os.Stat(files[1])
			if first != nil && second != nil && first.Size() == 8 && second.Size() == 8 {
				break
			}
		}
		time.Sleep(time.Millisecond)
	}
	if len(files) != 2 {
		t.Fatalf("log did not rotate: %v", files)
	}
	old := time.Now().Add(-72 * time.Hour)
	for _, filename := range files {
		if err := os.Chtimes(filename, old, old); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.UpdateRetention(types.SessionLogRetentionSettings{Enabled: true, MaxAgeDays: 1, MaxTotalMB: 1}); err != nil {
		t.Fatal(err)
	}
	for _, filename := range files {
		if _, err := os.Stat(filename); err != nil {
			t.Fatal("active log removed")
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	for _, filename := range files {
		if _, err := os.Stat(filename); !os.IsNotExist(err) {
			t.Fatalf("expired closed log retained: %v", err)
		}
	}
}

func TestRetentionDoesNotFollowSymbolicLinks(t *testing.T) {
	dir := t.TempDir()
	target := retainedLog(t, t.TempDir(), 128, time.Now().AddDate(-1, 0, 0))
	link := filepath.Join(dir, filepath.Base(target))
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	m := NewManager(dir, nil)
	if err := m.UpdateRetention(types.SessionLogRetentionSettings{Enabled: true, MaxAgeDays: 1, MaxTotalMB: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(link); err != nil {
		t.Fatal("symlink removed")
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatal("symlink target removed")
	}
}

func TestRetentionCoordinatesConcurrentConnectionsAndPolicyChanges(t *testing.T) {
	dir := t.TempDir()
	m := NewManager(dir, nil)
	policy := types.SessionLogRetentionSettings{Enabled: true, MaxAgeDays: 1, MaxTotalMB: 1}
	if err := m.UpdateRetention(policy); err != nil {
		t.Fatal(err)
	}
	errors := make(chan error, 128)
	var workers sync.WaitGroup
	workers.Add(1)
	go func() {
		defer workers.Done()
		for range 32 {
			if err := m.UpdateRetention(policy); err != nil {
				errors <- err
			}
		}
	}()
	for range 16 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			w, err := m.New("concurrent", types.SessionLogSettings{}, nil)
			if err != nil {
				errors <- err
				return
			}
			filename := w.file.Name()
			old := time.Now().Add(-72 * time.Hour)
			if err := os.Chtimes(filename, old, old); err != nil {
				errors <- err
			}
			if err := m.UpdateRetention(policy); err != nil {
				errors <- err
			}
			if _, err := os.Stat(filename); err != nil {
				errors <- err
			}
			w.WriteStream(0, "line\n")
			if err := w.Close(); err != nil {
				errors <- err
			}
		}()
	}
	workers.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
}
