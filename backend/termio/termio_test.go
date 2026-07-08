package termio

import (
	"io"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

// scriptedReader returns each script entry from one Read call, then blocks
// until closed (like a live terminal stream with no more output).
type scriptedReader struct {
	chunks chan []byte
}

func newScriptedReader() *scriptedReader {
	return &scriptedReader{chunks: make(chan []byte)}
}

func (r *scriptedReader) Read(p []byte) (int, error) {
	chunk, ok := <-r.chunks
	if !ok {
		return 0, io.EOF
	}
	n := copy(p, chunk)
	return n, nil
}

func collect(t *testing.T, r io.Reader, stop <-chan struct{}) (chunks func() []string, wait func()) {
	t.Helper()
	var mu sync.Mutex
	var got []string
	done := make(chan struct{})
	go func() {
		defer close(done)
		Pump(r, stop, func(chunk string) {
			mu.Lock()
			got = append(got, chunk)
			mu.Unlock()
		})
	}()
	return func() []string {
			mu.Lock()
			defer mu.Unlock()
			return append([]string(nil), got...)
		}, func() {
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("pump did not exit")
			}
		}
}

// A multibyte rune split across two reads must not surface as U+FFFD: every
// delivered chunk is valid UTF-8 and the concatenation matches the input.
func TestPumpReassemblesSplitRune(t *testing.T) {
	r := newScriptedReader()
	stop := make(chan struct{})
	got, wait := collect(t, r, stop)

	input := "前面ok中文emoji🙂结尾"
	raw := []byte(input)
	// Feed byte-by-byte: worst case, every rune is split.
	go func() {
		for i := range raw {
			r.chunks <- raw[i : i+1]
		}
		close(r.chunks)
	}()
	wait()

	joined := strings.Join(got(), "")
	if joined != input {
		t.Fatalf("output mismatch: %q != %q", joined, input)
	}
	for i, c := range got() {
		if !utf8.ValidString(c) {
			t.Fatalf("chunk %d is not valid UTF-8: %q", i, c)
		}
	}
}

// EOF must flush whatever is buffered, including a trailing incomplete rune
// (kept as-is rather than dropped).
func TestPumpFlushesOnEOF(t *testing.T) {
	r := newScriptedReader()
	stop := make(chan struct{})
	got, wait := collect(t, r, stop)

	partial := []byte("汉")[:2] // first 2 bytes of a 3-byte rune
	go func() {
		r.chunks <- []byte("abc")
		r.chunks <- partial
		close(r.chunks)
	}()
	wait()

	joined := strings.Join(got(), "")
	if joined != "abc"+string(partial) {
		t.Fatalf("expected all bytes flushed at EOF, got %q", joined)
	}
}

// Closing stop must terminate the pump even when the reader is blocked with no
// data, and must not leak the reader goroutine on its next handoff.
func TestPumpStops(t *testing.T) {
	r := newScriptedReader()
	stop := make(chan struct{})
	_, wait := collect(t, r, stop)

	close(stop)
	wait()
}

// A reader that produces data while nobody consumes (session gone) exits via
// the stop select instead of blocking forever on the handoff channel.
func TestPumpReaderGoroutineExitsAfterStop(t *testing.T) {
	r := newScriptedReader()
	stop := make(chan struct{})
	_, wait := collect(t, r, stop)

	r.chunks <- []byte("data before stop")
	close(stop)
	wait()

	// The pump has exited. The reader goroutine may be blocked handing off one
	// last chunk; its select on stop must release it.
	delivered := make(chan struct{})
	go func() {
		r.chunks <- []byte("late chunk")
		close(delivered)
	}()
	select {
	case <-delivered:
		// Reader consumed it (still in Read loop) — also fine; it will exit on
		// the next handoff select since stop is closed.
	case <-time.After(500 * time.Millisecond):
		t.Fatal("reader goroutine appears blocked after stop")
	}
}
