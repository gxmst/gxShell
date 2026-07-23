// Package termio provides the shared read-batch-deliver pump used by both the
// SSH and local-terminal output paths. It exists so the two paths cannot drift:
// both need the same 16ms/32KB batching (a busy `cat` would otherwise turn into
// thousands of IPC events per second) and the same UTF-8 boundary handling
// (reader.Read splits multibyte runes across chunk boundaries; jsonifying a
// half rune turns CJK/emoji output into U+FFFD).
package termio

import (
	"bytes"
	"io"
	"time"
	"unicode/utf8"
)

const (
	// flushInterval trades latency for IPC volume. One frame (~16ms) is not
	// perceptible on echo but caps event rate at ~60/s per stream.
	flushInterval = 16 * time.Millisecond
	// maxBatch flushes early so a fast producer cannot grow the batch unboundedly
	// between timer ticks.
	maxBatch = 32 * 1024
	readBuf  = 32 * 1024
)

// Pump reads terminal output from r until EOF/error or stop closes, delivering
// it as batched, valid-UTF-8 string chunks. deliver is called from the pump
// goroutine only (never concurrently). The internal reader goroutine selects on
// stop while handing off data, so an abandoned read cannot leak it.
func Pump(r io.Reader, stop <-chan struct{}, deliver func(chunk string)) {
	type readResult struct {
		data []byte
		err  error
	}
	ch := make(chan readResult, 1)
	go func() {
		buf := make([]byte, readBuf)
		for {
			n, err := r.Read(buf)
			var data []byte
			if n > 0 {
				data = make([]byte, n)
				copy(data, buf[:n])
			}
			select {
			case ch <- readResult{data: data, err: err}:
			case <-stop:
				return
			}
			if err != nil {
				return
			}
		}
	}()

	var batch bytes.Buffer
	timer := time.NewTimer(flushInterval)
	defer timer.Stop()

	// flush emits the batch up to the last complete UTF-8 rune, retaining a
	// partial trailing rune (at most 3 bytes) for the next flush. final flushes
	// everything as-is: at stream end there is no next chunk to complete the
	// rune, and dropping bytes would be worse than one replacement char.
	flush := func(final bool) {
		if batch.Len() == 0 {
			return
		}
		b := batch.Bytes()
		cut := len(b)
		if !final {
			for i := 0; i < utf8.UTFMax-1 && cut > 0; i++ {
				if utf8.Valid(b[:cut]) {
					break
				}
				cut--
			}
			if cut == 0 {
				return
			}
		}
		deliver(string(b[:cut]))
		rest := append([]byte(nil), b[cut:]...)
		batch.Reset()
		batch.Write(rest)
	}

	resetTimer := func() {
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(flushInterval)
	}

	for {
		select {
		case <-stop:
			flush(true)
			return
		case res := <-ch:
			if len(res.data) > 0 {
				batch.Write(res.data)
				if batch.Len() >= maxBatch {
					flush(false)
					resetTimer()
				}
			}
			if res.err != nil {
				flush(true)
				return
			}
		case <-timer.C:
			flush(false)
			timer.Reset(flushInterval)
		}
	}
}
