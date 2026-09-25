package sftpmanager

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/pkg/sftp"
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

func TestTerminalTransferRejectsLatePausedEvent(t *testing.T) {
	var events []map[string]any
	m := &Manager{emit: func(_ string, data any) {
		events = append(events, data.(map[string]any))
	}, transfers: map[string]*transferJob{}}
	job := m.beginTransfer("session-race", "/tmp/file", "download")
	if !job.pause() {
		t.Fatal("failed to stage concurrent pause")
	}

	m.finishTransfer(job, nil, 10, 10)
	m.emitTransfer(job, "paused", 5, 10, nil)

	if len(events) != 2 || events[1]["status"] != "succeeded" {
		t.Fatalf("late pause revived terminal transfer: %#v", events)
	}
	if events[0]["sequence"] != uint64(1) || events[1]["sequence"] != uint64(2) {
		t.Fatalf("unexpected event sequence: %#v", events)
	}
}

func TestPauseReportsBytesObservedBetweenEvents(t *testing.T) {
	var events []map[string]any
	m := &Manager{emit: func(_ string, data any) {
		events = append(events, data.(map[string]any))
	}, transfers: map[string]*transferJob{}}
	job := m.beginTransfer("session-pause", "/tmp/file", "download")

	progress := m.transferProgress(job, 100, 900)
	progress(50)
	// Throttled away, so the only record of this position is the observation the
	// copy loop makes. Pausing has to report it instead of the numbers carried
	// by the last event that happened to get through.
	progress(150)

	if !m.PauseTransfer(job.id) {
		t.Fatal("pause was rejected")
	}
	paused := events[len(events)-1]
	if paused["status"] != "paused" {
		t.Fatalf("last event = %#v, want a paused event", paused)
	}
	if paused["done"] != int64(250) || paused["total"] != int64(900) {
		t.Fatalf("paused event reported stale progress: %#v", paused)
	}
}

func TestEmitResumedResetsRateSamplingAtOffset(t *testing.T) {
	var events []map[string]any
	m := &Manager{emit: func(_ string, data any) {
		events = append(events, data.(map[string]any))
	}, transfers: map[string]*transferJob{}}
	job := m.beginTransfer("session-resume", "/tmp/file", "download")
	m.setTransferPaths(job, "/tmp/remote", "/tmp/local", true)
	m.setTransferRetryable(job, true)
	m.emitResumed(job, 1_000_000, 2_000_000)

	job.metricsMu.Lock()
	job.lastSampleAt = time.Now().Add(-time.Second)
	job.metricsMu.Unlock()
	m.emitTransfer(job, "progress", 1_000_100, 2_000_000, nil)

	resumed := events[1]
	if resumed["speed"] != float64(0) || resumed["sourcePath"] != "/tmp/remote" || resumed["retryable"] != true {
		t.Fatalf("incomplete resumed event: %#v", resumed)
	}
	progress := events[2]
	speed, ok := progress["speed"].(float64)
	if !ok || speed < 50 || speed > 500 {
		t.Fatalf("resume offset contaminated speed: %#v", progress["speed"])
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

func TestPauseResumeTransferKeepsJobAndUnblocksWaiter(t *testing.T) {
	var events []map[string]any
	m := &Manager{emit: func(_ string, data any) {
		events = append(events, data.(map[string]any))
	}, transfers: map[string]*transferJob{}}

	job := m.beginTransfer("session-pause", "/tmp/file", "download")
	m.setTransferPaths(job, "/tmp/remote", "/tmp/local", false)
	if !m.PauseTransfer(job.id) {
		t.Fatal("active job was not paused")
	}
	if !job.isPaused() {
		t.Fatal("job did not enter paused state")
	}

	ready := make(chan error, 1)
	go func() { ready <- job.waitIfPaused() }()
	select {
	case err := <-ready:
		t.Fatalf("waitIfPaused returned before resume: %v", err)
	case <-time.After(20 * time.Millisecond):
	}

	if !m.ResumeTransfer(job.id) {
		t.Fatal("paused job was not resumed")
	}
	select {
	case err := <-ready:
		if err != nil {
			t.Fatalf("waitIfPaused after resume = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("waitIfPaused remained blocked after resume")
	}

	if len(events) < 3 || events[1]["status"] != "paused" || events[2]["status"] != "progress" {
		t.Fatalf("pause/resume events = %#v", events)
	}
	if events[1]["sourcePath"] != "/tmp/remote" || events[1]["targetPath"] != "/tmp/local" {
		t.Fatalf("pause event paths = %#v", events[1])
	}
	if !m.CancelTransfer(job.id) {
		t.Fatal("paused/resumed job was not cancellable")
	}
	m.finishTransfer(job, context.Canceled, 0, 10)
}

func TestEmitTransferIncludesSpeedAndEta(t *testing.T) {
	var event map[string]any
	m := &Manager{emit: func(_ string, data any) { event = data.(map[string]any) }, transfers: map[string]*transferJob{}}
	job := m.beginTransfer("session-rate", "/tmp/file", "upload")
	job.startedAt = time.Now().Add(-2 * time.Second)
	m.setTransferPaths(job, "/tmp/local", "/tmp/remote", true)
	m.emitTransfer(job, "progress", 100, 300, nil)
	if got, ok := event["sourcePath"].(string); !ok || got != "/tmp/local" {
		t.Fatalf("sourcePath = %#v", event["sourcePath"])
	}
	if speed, ok := event["speed"].(float64); !ok || speed <= 0 {
		t.Fatalf("speed = %#v, want positive", event["speed"])
	}
	if eta, ok := event["eta"].(float64); !ok || eta <= 0 {
		t.Fatalf("eta = %#v, want positive", event["eta"])
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

// noLinkFS is a filesystem without hard links — exFAT, FAT32 and some network
// mounts. It wraps the real one and fails Link the way such a filesystem does.
type noLinkFS struct{ localOSFiles }

func (noLinkFS) Link(oldname, newname string) error {
	return &os.LinkError{Op: "link", Old: oldname, New: newname, Err: errors.New("operation not supported")}
}

func TestReplaceLocalTempInstallsOnFilesystemWithoutHardLinks(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "download.txt")
	part := transferPartPath(target, "job-nolink-new")
	if err := os.WriteFile(part, []byte("complete"), 0600); err != nil {
		t.Fatal(err)
	}
	// Before the fix the link-based promotion failed here, so every download to
	// this kind of disk failed after transferring the whole file.
	if err := replaceLocalTempWithFS(noLinkFS{}, part, target, false); err != nil {
		t.Fatalf("download to a link-less filesystem failed: %v", err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "complete" {
		t.Fatalf("target = %q, want complete", got)
	}
}

func TestReplaceLocalTempReplacesExistingTargetWithoutHardLinks(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "download.txt")
	part := transferPartPath(target, "job-nolink-overwrite")
	if err := os.WriteFile(target, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(part, []byte("complete"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := replaceLocalTempWithFS(noLinkFS{}, part, target, true); err != nil {
		t.Fatalf("overwrite on a link-less filesystem failed: %v", err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "complete" {
		t.Fatalf("target = %q, want complete", got)
	}
	// No stray backup or probe files are left behind.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "download.txt" {
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("leftover files after promotion: %v", names)
	}
}

func TestInstallLocalFileStillRefusesToReplaceWithoutHardLinks(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "download.txt")
	part := transferPartPath(target, "job-nolink-race")
	if err := os.WriteFile(target, []byte("created by another process"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(part, []byte("completed download"), 0600); err != nil {
		t.Fatal(err)
	}
	// The rename fallback exists only for a filesystem that cannot hard-link,
	// never as a way to overwrite a destination that is actually there.
	if err := installLocalFile(noLinkFS{}, part, target, true); err == nil {
		t.Fatal("no-replace install replaced an existing target on a link-less filesystem")
	}
	gotTarget, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotTarget) != "created by another process" {
		t.Fatalf("target = %q, want the raced file preserved", gotTarget)
	}
	if _, err := os.Stat(part); err != nil {
		t.Fatalf("part file was lost: %v", err)
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

// fakeRemoteFileOps models the remote side of the save path's link and
// ownership rules: a link table plus a record of the metadata calls.
type fakeRemoteFileOps struct {
	links map[string]string
	files map[string]os.FileMode
	uids  map[string][2]int
	chown []string
	chmod []string
}

func newFakeRemoteFileOps() *fakeRemoteFileOps {
	return &fakeRemoteFileOps{
		links: map[string]string{},
		files: map[string]os.FileMode{},
		uids:  map[string][2]int{},
	}
}

func (f *fakeRemoteFileOps) addFile(name string, mode os.FileMode) { f.files[name] = mode }

func (f *fakeRemoteFileOps) Lstat(name string) (os.FileInfo, error) {
	if _, ok := f.links[name]; ok {
		return fakeFileInfo{name: path.Base(name), mode: os.ModeSymlink | 0777}, nil
	}
	if mode, ok := f.files[name]; ok {
		return fakeFileInfo{name: path.Base(name), mode: mode}, nil
	}
	return nil, os.ErrNotExist
}

func (f *fakeRemoteFileOps) ReadLink(name string) (string, error) {
	if target, ok := f.links[name]; ok {
		return target, nil
	}
	return "", os.ErrNotExist
}

func (f *fakeRemoteFileOps) Chown(name string, uid, gid int) error {
	f.chown = append(f.chown, name)
	f.uids[name] = [2]int{uid, gid}
	return nil
}

func (f *fakeRemoteFileOps) Chmod(name string, mode os.FileMode) error {
	f.chmod = append(f.chmod, name)
	f.files[name] = mode
	return nil
}

type fakeFileInfo struct {
	name string
	mode os.FileMode
}

func (i fakeFileInfo) Name() string       { return i.name }
func (i fakeFileInfo) Size() int64        { return 0 }
func (i fakeFileInfo) Mode() os.FileMode  { return i.mode }
func (i fakeFileInfo) ModTime() time.Time { return time.Time{} }
func (i fakeFileInfo) IsDir() bool        { return i.mode.IsDir() }
func (i fakeFileInfo) Sys() any           { return nil }

func TestResolveRemoteWriteTargetFollowsLinks(t *testing.T) {
	ops := newFakeRemoteFileOps()
	ops.addFile("/srv/real.conf", 0644)
	ops.links["/srv/enabled.conf"] = "real.conf"
	ops.links["/etc/site.conf"] = "/srv/enabled.conf"

	// A plain file resolves to itself.
	got, err := resolveRemoteLinkTarget(ops, "/srv/real.conf")
	if err != nil || got != "/srv/real.conf" {
		t.Fatalf("plain file resolved to %q, %v", got, err)
	}
	// A relative link target is resolved against the link's own directory, and
	// a chain is followed to the end.
	got, err = resolveRemoteLinkTarget(ops, "/etc/site.conf")
	if err != nil || got != "/srv/real.conf" {
		t.Fatalf("link chain resolved to %q, %v", got, err)
	}
	// A path that does not exist yet is its own target: this is a new file.
	got, err = resolveRemoteLinkTarget(ops, "/srv/new.conf")
	if err != nil || got != "/srv/new.conf" {
		t.Fatalf("new file resolved to %q, %v", got, err)
	}
}

func TestResolveRemoteWriteTargetRejectsALoop(t *testing.T) {
	ops := newFakeRemoteFileOps()
	ops.links["/a.conf"] = "/b.conf"
	ops.links["/b.conf"] = "/a.conf"
	// The SFTP protocol has no "too many links" answer, so the resolver must
	// stop on its own rather than walk forever.
	if _, err := resolveRemoteLinkTarget(ops, "/a.conf"); err == nil {
		t.Fatal("a symlink loop was followed without bound")
	}
}

func TestApplyRemoteOwnershipRestoresModeAndOwner(t *testing.T) {
	ops := newFakeRemoteFileOps()
	ops.addFile("/srv/app.sh", 0o755)
	owner := captureRemoteOwnership(ops, "/srv/app.sh")
	if !owner.known || owner.mode != 0o755 {
		t.Fatalf("captured owner = %#v", owner)
	}
	applyRemoteOwnership(ops, "/srv/app.sh.tmp", owner)
	if len(ops.chmod) != 1 || ops.chmod[0] != "/srv/app.sh.tmp" {
		t.Fatalf("chmod calls = %#v", ops.chmod)
	}
	if got := ops.files["/srv/app.sh.tmp"]; got != 0o755 {
		t.Fatalf("restored mode = %v, want 0755", got)
	}
}

func TestApplyRemoteOwnershipDoesNothingWithoutADestination(t *testing.T) {
	ops := newFakeRemoteFileOps()
	owner := captureRemoteOwnership(ops, "/srv/missing")
	if owner.known {
		t.Fatal("a missing destination produced a captured owner")
	}
	applyRemoteOwnership(ops, "/srv/missing.tmp", owner)
	if len(ops.chmod) != 0 || len(ops.chown) != 0 {
		t.Fatalf("metadata was applied without a destination to copy: %#v %#v", ops.chown, ops.chmod)
	}
}

func TestWriteRemoteFileFollowsASymlinkInsteadOfReplacingIt(t *testing.T) {
	m, client := newTransferTestManager(t, sftp.InMemHandler())
	putTransferTestFile(t, client, "/real.conf", []byte("original"))
	if err := client.Symlink("/real.conf", "/enabled.conf"); err != nil {
		t.Fatal(err)
	}

	if err := m.WriteRemoteFile("test", "/enabled.conf", []byte("updated")); err != nil {
		t.Fatal(err)
	}
	if got := readTransferTestFile(t, client, "/real.conf"); string(got) != "updated" {
		t.Fatalf("link target = %q, want updated", got)
	}
	info, err := client.Lstat("/enabled.conf")
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the save replaced the symlink with a regular file")
	}
}

func TestWriteRemoteFileFollowsARelativeSymlinkTarget(t *testing.T) {
	m, client := newTransferTestManager(t, sftp.InMemHandler())
	if err := client.Mkdir("/srv"); err != nil {
		t.Fatal(err)
	}
	putTransferTestFile(t, client, "/srv/real.conf", []byte("original"))
	if err := client.Symlink("real.conf", "/srv/enabled.conf"); err != nil {
		t.Fatal(err)
	}

	if err := m.WriteRemoteFile("test", "/srv/enabled.conf", []byte("updated")); err != nil {
		t.Fatal(err)
	}
	if got := readTransferTestFile(t, client, "/srv/real.conf"); string(got) != "updated" {
		t.Fatalf("relative link target = %q, want updated", got)
	}
}
