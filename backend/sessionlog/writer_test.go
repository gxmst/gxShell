package sessionlog

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"gxShell/backend/types"
)

func readLogs(t *testing.T, dir string) string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(dir, "*.log"))
	if err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	for _, path := range files {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		output.Write(data)
	}
	return output.String()
}

func TestCloseDrainsOutputAndStreamingANSI(t *testing.T) {
	dir := t.TempDir()
	w, err := New(dir, "../../host:22", types.SessionLogSettings{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range []byte("\x1b[31m你好\x1b[0m\x1b]0;hidden title\x07\r\nfinal") {
		w.WriteStream(0, string([]byte{b}))
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if got := readLogs(t, dir); got != "你好\nfinal\n" || !utf8.ValidString(got) {
		t.Fatalf("unexpected transcript: %q", got)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	w.WriteStream(0, "after close")
}

func TestConcurrentStreamsAndDailyRotation(t *testing.T) {
	dir := t.TempDir()
	w, err := New(dir, "server", types.SessionLogSettings{Timestamps: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	day := time.Date(2026, 9, 8, 23, 59, 59, 0, time.UTC)
	w.now = func() time.Time { return day }
	var workers sync.WaitGroup
	for i := range 20 {
		workers.Add(1)
		go func() { defer workers.Done(); w.WriteStream(i%2, "line\n") }()
	}
	workers.Wait()
	day = day.Add(2 * time.Second)
	w.WriteStream(0, "next day\n")
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	got := readLogs(t, dir)
	if strings.Count(got, "] line\n") != 20 || !strings.Contains(got, "[2026-09-09T00:00:01Z] next day") {
		t.Fatal(got)
	}
}

func TestTabOnlyLinesStayBounded(t *testing.T) {
	dir := t.TempDir()
	w, err := New(dir, "tabs", types.SessionLogSettings{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	w.WriteStream(0, "before\r\t\n"+strings.Repeat("\t", 40*1024))
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	got := readLogs(t, dir)
	if !strings.HasPrefix(got, "before\n\t\n") || strings.Count(got, "\t") != 40*1024+1 {
		t.Fatal("transcript did not preserve tab output")
	}
	for _, line := range strings.Split(got, "\n") {
		if len(line) > 16*1024 {
			t.Fatalf("line buffer exceeded limit: %d", len(line))
		}
	}
}

func TestNewLinesUseCurrentChunkTimestamp(t *testing.T) {
	dir := t.TempDir()
	w, err := New(dir, "server", types.SessionLogSettings{Timestamps: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	day := time.Date(2026, 9, 8, 23, 59, 59, 0, time.UTC)
	w.now = func() time.Time { return day }
	w.WriteStream(0, "partial")
	day = day.Add(2 * time.Second)
	w.WriteStream(0, " continued\nnext line\n")
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	got := readLogs(t, dir)
	if !strings.Contains(got, "[2026-09-08T23:59:59Z] partial continued\n") || !strings.Contains(got, "[2026-09-09T00:00:01Z] next line\n") {
		t.Fatalf("line timestamps did not advance: %s", got)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "2026-09-09-*.log"))
	if len(files) != 1 {
		t.Fatalf("new day's output was not rotated: %v", files)
	}
}

func TestSizeRotationAndLimitPreserveExistingLogs(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "previous.log"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	var errors atomic.Int32
	w, err := New(dir, "host", types.SessionLogSettings{MaxFileMB: 1, MaxSessionMB: 2}, func(error) { errors.Add(1) })
	if err != nil {
		t.Fatal(err)
	}
	// Exercise actual file rotation with two streams; the queue stays bounded.
	for range 2 {
		w.WriteStream(0, strings.Repeat("a", 900*1024)+"\n")
		// Drain accepted chunks before feeding another large block.
		for len(w.queue) > 0 {
			time.Sleep(time.Millisecond)
		}
	}
	w.WriteStream(1, strings.Repeat("b", 500*1024)+"\n")
	if err := w.Close(); err == nil {
		t.Fatal("expected size limit error")
	}
	if errors.Load() != 1 {
		t.Fatalf("expected one error, got %d", errors.Load())
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*.log"))
	if len(files) < 3 {
		t.Fatalf("expected rotation: %v", files)
	}
	for _, path := range files {
		info, err := os.Stat(path)
		if err != nil || info.Size() > 1024*1024 {
			t.Fatalf("unbounded file %s: %v", path, err)
		}
	}
	if data, _ := os.ReadFile(filepath.Join(dir, "previous.log")); string(data) != "keep" {
		t.Fatal("existing log changed")
	}
}
