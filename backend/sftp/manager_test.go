package sftpmanager

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

type remoteReadHandleTestFile struct {
	*bytes.Reader
	mu        sync.Mutex
	closeCall int
	statCall  int
}

func (f *remoteReadHandleTestFile) Close() error {
	f.mu.Lock()
	f.closeCall++
	f.mu.Unlock()
	return nil
}

func (f *remoteReadHandleTestFile) Stat() (os.FileInfo, error) {
	f.mu.Lock()
	f.statCall++
	f.mu.Unlock()
	return nil, errors.New("unexpected Stat call")
}

func TestRemoteReadHandleUsesKnownSizeAndReleasesOnce(t *testing.T) {
	contents := []byte("0123456789")
	file := &remoteReadHandleTestFile{Reader: bytes.NewReader(contents)}
	releaseCalls := 0
	var releaseMu sync.Mutex
	handle := &RemoteReadHandle{
		file: file,
		size: int64(len(contents)),
		release: func() {
			releaseMu.Lock()
			releaseCalls++
			releaseMu.Unlock()
		},
	}

	position, err := handle.Seek(-3, io.SeekEnd)
	if err != nil {
		t.Fatal(err)
	}
	if position != 7 {
		t.Fatalf("seek position = %d, want 7", position)
	}
	data := make([]byte, 3)
	if _, err := io.ReadFull(handle, data); err != nil {
		t.Fatal(err)
	}
	if string(data) != "789" {
		t.Fatalf("read data = %q, want 789", data)
	}

	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := handle.Close(); err != nil {
				t.Errorf("Close: %v", err)
			}
		}()
	}
	wg.Wait()

	file.mu.Lock()
	closeCalls := file.closeCall
	statCalls := file.statCall
	file.mu.Unlock()
	releaseMu.Lock()
	gotReleaseCalls := releaseCalls
	releaseMu.Unlock()
	if closeCalls != 1 || gotReleaseCalls != 1 {
		t.Fatalf("close calls = %d, release calls = %d; want 1 each", closeCalls, gotReleaseCalls)
	}
	if statCalls != 0 {
		t.Fatalf("SeekEnd made %d Stat calls, want 0", statCalls)
	}
}

func TestCleanRemotePath(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"empty", "", "."},
		{"dot", ".", "."},
		{"simple path", "home/user", "home/user"},
		{"absolute path", "/home/user", "/home/user"},
		{"trailing slash", "/home/user/", "/home/user"},
		{"double slash", "/home//user", "/home/user"},
		{"dot in path", "/home/./user", "/home/user"},
		{"traversal up", "/home/user/../admin", "/home/admin"},
		{"traversal up to root", "/home/../etc", "/etc"},
		{"multiple traversal", "/a/b/../../c", "/c"},
		{"traversal beyond root", "/../etc", "/etc"},
		{"relative traversal", "a/../b", "b"},
		{"complex traversal", "/a/b/c/../../d", "/a/d"},
		{"only traversal", "..", "."},
		{"multiple dots", "../../..", "."},
		{"dot dot in middle", "a/b/../../c", "c"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := cleanRemotePath(tt.input)
			if got != tt.want {
				t.Errorf("cleanRemotePath(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestTransferLifecycleEmitsOneTerminalEvent(t *testing.T) {
	var events []map[string]any
	m := &Manager{emit: func(event string, data any) {
		if event != "sftp:progress" {
			t.Fatalf("unexpected event %q", event)
		}
		events = append(events, data.(map[string]any))
	}, transfers: map[string]*transferJob{}}

	job := m.beginTransfer("session-1", "/tmp/file", "download")
	if len(events) != 1 || events[0]["status"] != "started" {
		t.Fatalf("begin events = %#v, want one started event", events)
	}
	if got := events[0]["jobId"]; got == "" || got != job.id {
		t.Fatalf("started jobId = %#v, want %q", got, job.id)
	}

	m.emitTransfer(job, "progress", 4, 10, nil)
	m.finishTransfer(job, errors.New("copy failed"), 4, 10)
	m.finishTransfer(job, nil, 10, 10)

	if len(events) != 3 {
		t.Fatalf("events count = %d, want 3", len(events))
	}
	terminal := events[2]
	if terminal["status"] != "failed" || terminal["finished"] != true || terminal["error"] != "copy failed" {
		t.Fatalf("terminal event = %#v", terminal)
	}
	if m.CancelTransfer(job.id) {
		t.Fatal("completed job remained cancellable")
	}
}

func TestCancelTransferEmitsCancelledTerminal(t *testing.T) {
	var events []map[string]any
	m := &Manager{emit: func(_ string, data any) {
		events = append(events, data.(map[string]any))
	}, transfers: map[string]*transferJob{}}

	job := m.beginTransfer("session-2", "/tmp/folder", "download")
	interrupted := false
	job.setInterrupt(func() { interrupted = true })
	if !m.CancelTransfer(job.id) {
		t.Fatal("active job was not cancelled")
	}
	if !interrupted {
		t.Fatal("cancellation did not interrupt the active copy")
	}
	if !errors.Is(job.ctx.Err(), context.Canceled) {
		t.Fatalf("context error = %v, want context.Canceled", job.ctx.Err())
	}
	m.finishTransfer(job, context.Canceled, 3, 12)

	terminal := events[len(events)-1]
	if terminal["status"] != "cancelled" || terminal["jobId"] != job.id {
		t.Fatalf("terminal event = %#v", terminal)
	}
}

func TestUploadOpenFailureDoesNotLeaveJobRunning(t *testing.T) {
	var events []map[string]any
	m := &Manager{emit: func(_ string, data any) {
		events = append(events, data.(map[string]any))
	}, transfers: map[string]*transferJob{}}

	err := m.UploadFile("session-3", filepath.Join(t.TempDir(), "missing.bin"), "/tmp/missing.bin")
	if err == nil {
		t.Fatal("UploadFile succeeded for a missing local file")
	}
	if len(events) != 2 || events[0]["status"] != "started" || events[1]["status"] != "failed" {
		t.Fatalf("events = %#v, want started then failed", events)
	}
	if events[0]["jobId"] != events[1]["jobId"] {
		t.Fatalf("job id changed between lifecycle events: %#v", events)
	}
	if len(m.transfers) != 0 {
		t.Fatalf("failed upload left %d active jobs", len(m.transfers))
	}
}

func TestOverwriteConflictDoesNotInvalidateCachedClient(t *testing.T) {
	m := &Manager{
		cache:    map[string]*cachedClient{"session-1": {refs: 1}},
		createMu: map[string]*sync.Mutex{"session-1": {}},
	}

	m.invalidateOnTransferErr("session-1", &OverwriteRequiredError{Path: "/tmp/existing"})

	if _, ok := m.cache["session-1"]; !ok {
		t.Fatal("overwrite conflict invalidated a healthy cached client")
	}
}

func TestLocalLinkFailureDoesNotInvalidateCachedClient(t *testing.T) {
	m := &Manager{
		cache:    map[string]*cachedClient{"session-1": {refs: 1}},
		createMu: map[string]*sync.Mutex{"session-1": {}},
	}

	m.invalidateOnTransferErr("session-1", &os.LinkError{Op: "link", Old: "part", New: "target", Err: errors.New("not supported")})

	if _, ok := m.cache["session-1"]; !ok {
		t.Fatal("local hard-link failure invalidated a healthy cached client")
	}
}

func TestReplaceLocalTempReplacesCompletedTarget(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "download.txt")
	part := transferPartPath(target, "job-1")
	if err := os.WriteFile(target, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(part, []byte("complete"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := replaceLocalTemp(part, target, true); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "complete" {
		t.Fatalf("target = %q, want complete", got)
	}
	if _, err := os.Stat(part); !os.IsNotExist(err) {
		t.Fatalf("part file still exists: %v", err)
	}
}

func TestReplaceLocalTempNoOverwritePreservesTarget(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "download.txt")
	part := transferPartPath(target, "job-no-overwrite")
	if err := os.WriteFile(target, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(part, []byte("complete"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := replaceLocalTemp(part, target, false); err == nil {
		t.Fatal("no-overwrite promotion replaced an existing target")
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "original" {
		t.Fatalf("target = %q, want original", got)
	}
	if _, err := os.Stat(part); err != nil {
		t.Fatalf("part file was not preserved after conflict: %v", err)
	}
}

func TestReplaceLocalTempConflictIsTyped(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "download.txt")
	part := transferPartPath(target, "job-typed-conflict")
	if err := os.WriteFile(target, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(part, []byte("complete"), 0600); err != nil {
		t.Fatal(err)
	}
	err := replaceLocalTemp(part, target, false)
	if !IsOverwriteRequired(err) {
		t.Fatalf("error = %v, want overwrite-required", err)
	}
	var typed *OverwriteRequiredError
	if !errors.As(err, &typed) || typed.Path != target || typed.Remote {
		t.Fatalf("typed error = %#v", typed)
	}
}

func TestReplaceLocalTempNoOverwritePromotesNewTarget(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "download.txt")
	part := transferPartPath(target, "job-new-target")
	if err := os.WriteFile(part, []byte("complete"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := replaceLocalTemp(part, target, false); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "complete" {
		t.Fatalf("target = %q, want complete", got)
	}
	if _, err := os.Stat(part); !os.IsNotExist(err) {
		t.Fatalf("part file still exists: %v", err)
	}
}

func TestPromoteLocalNoReplaceNeverReplacesExistingTarget(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "download.txt")
	part := transferPartPath(target, "job-raced-target")
	if err := os.WriteFile(target, []byte("created by another process"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(part, []byte("completed download"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := promoteLocalNoReplace(part, target); err == nil {
		t.Fatal("no-replace promotion replaced an existing target")
	}
	gotTarget, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotTarget) != "created by another process" {
		t.Fatalf("target = %q, want raced target preserved", gotTarget)
	}
	gotPart, err := os.ReadFile(part)
	if err != nil {
		t.Fatalf("part was lost after no-replace conflict: %v", err)
	}
	if string(gotPart) != "completed download" {
		t.Fatalf("part = %q, want completed download", gotPart)
	}
}

func TestReplaceLocalTempRejectsDirectoryTarget(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "download.txt")
	part := transferPartPath(target, "job-directory-target")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(target, "keep.txt")
	if err := os.WriteFile(sentinel, []byte("keep me"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(part, []byte("complete"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := replaceLocalTemp(part, target, true); err == nil {
		t.Fatal("directory target was replaced")
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if !info.IsDir() {
		t.Fatal("directory target no longer exists")
	}
	gotSentinel, err := os.ReadFile(sentinel)
	if err != nil {
		t.Fatalf("sentinel inside destination directory was lost: %v", err)
	}
	if string(gotSentinel) != "keep me" {
		t.Fatalf("sentinel = %q, want keep me", gotSentinel)
	}
	gotPart, err := os.ReadFile(part)
	if err != nil {
		t.Fatalf("completed part was lost after rejecting directory target: %v", err)
	}
	if string(gotPart) != "complete" {
		t.Fatalf("part = %q, want complete", gotPart)
	}
}

func TestProgressWriterStopsBeforeWritingWhenCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var dst bytes.Buffer
	w := &progressWriter{ctx: ctx, w: &dst, fn: func(int64) {}}
	if _, err := w.Write([]byte("must not be written")); !errors.Is(err, context.Canceled) {
		t.Fatalf("Write error = %v, want context.Canceled", err)
	}
	if dst.Len() != 0 {
		t.Fatalf("cancelled writer wrote %d bytes", dst.Len())
	}
}

func TestVerifiedUploadRejectsInvalidHashBeforeStartingTransfer(t *testing.T) {
	m := &Manager{}
	for _, hash := range []string{"", "not-a-hash", "abcd"} {
		if err := m.UploadFileWithPolicyVerified("session", "local", "/tmp/remote", false, hash); err == nil {
			t.Fatalf("hash %q was accepted", hash)
		}
	}
}
