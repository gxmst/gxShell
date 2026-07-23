package sftpmanager

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

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
	if err := replaceLocalTemp(part, target); err != nil {
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
