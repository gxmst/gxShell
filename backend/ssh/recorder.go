package sshmanager

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"
	"unicode/utf8"
)

// castRecorder writes a terminal session to an asciinema v2 (.cast) file. The
// format is JSON Lines: a header object on the first line, followed by one
// JSON array per event: [relativeSeconds, code, data]. code "o" is terminal
// output, "r" is a resize. We only tap stdout/stderr, not stdin. Shell-echoed
// commands are output and can appear in recordings; password prompts with echo
// disabled are not captured.
//
// forwardOutput runs one goroutine each for stdout and stderr, so writeOutput
// can be called concurrently; every write goes through mu.
type castRecorder struct {
	mu     sync.Mutex
	file   *os.File
	writer *bufio.Writer
	start  time.Time
	closed bool
	path   string
	cols   int
	rows   int
	// pending holds trailing bytes of an output chunk that form an incomplete
	// UTF-8 sequence. reader.Read can split a multibyte rune across the 4096-byte
	// buffer boundary; json.Marshal would turn the half-rune into U+FFFD and
	// corrupt the recording. We hold the incomplete tail until the next chunk
	// completes it. This matters in non-ASCII output (e.g. Chinese, emoji).
	pending []byte
	// writeErr records the first write/flush failure so it is not silently
	// swallowed; once set, further writes are skipped and close() reports it.
	writeErr error
}

// newCastRecorder creates the file and writes the .cast header. title is stored
// in the header for display in the player list.
func newCastRecorder(path, title string, cols, rows int) (*castRecorder, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	r := &castRecorder{
		file:   f,
		writer: bufio.NewWriter(f),
		start:  time.Now(),
		path:   path,
		cols:   cols,
		rows:   rows,
	}
	header := map[string]any{
		"version":   2,
		"width":     cols,
		"height":    rows,
		"timestamp": r.start.Unix(),
		"env":       map[string]string{"TERM": "xterm-256color"},
	}
	if title != "" {
		header["title"] = title
	}
	line, err := json.Marshal(header)
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	if _, err := r.writer.Write(append(line, '\n')); err != nil {
		_ = f.Close()
		return nil, err
	}
	return r, nil
}

// writeOutput appends a terminal-output event. Because forwardOutput reads on
// arbitrary 4096-byte boundaries, a chunk may end mid-way through a multi-byte
// UTF-8 rune. json.Marshal replaces invalid UTF-8 with U+FFFD rather than
// preserving the bytes, which would corrupt CJK/emoji output that straddles a
// read boundary. To avoid that we hold back any incomplete trailing rune and
// prepend it to the next chunk, so every emitted event contains only valid
// UTF-8. Any bytes still pending at close() are flushed as-is.
func (r *castRecorder) writeOutput(data string) {
	r.mu.Lock()
	if r.closed || r.writeErr != nil {
		r.mu.Unlock()
		return
	}
	combined := data
	if len(r.pending) > 0 {
		combined = string(r.pending) + data
		r.pending = nil
	}
	b := []byte(combined)
	// Find the largest prefix that ends on a complete UTF-8 rune, holding back a
	// trailing partial rune (at most 3 bytes) for the next call.
	cut := len(b)
	for i := 0; i < utf8.UTFMax-1 && cut > 0; i++ {
		if utf8.Valid(b[:cut]) {
			break
		}
		cut--
	}
	if cut < len(b) {
		r.pending = append(r.pending, b[cut:]...)
	}
	emit := string(b[:cut])
	r.mu.Unlock()
	if emit != "" {
		r.writeEvent("o", emit)
	}
}

// writeResize appends a resize event encoded as "COLSxROWS", matching the
// asciinema convention.
func (r *castRecorder) writeResize(cols, rows int) {
	r.writeEvent("r", strconv.Itoa(cols)+"x"+strconv.Itoa(rows))
}

func (r *castRecorder) writeEvent(code, data string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.writeErr != nil {
		return
	}
	elapsed := time.Since(r.start).Seconds()
	// [time, code, data]. json.Marshal escapes control bytes and quotes; the
	// caller (writeOutput) guarantees data is valid UTF-8, so no bytes are lost.
	frame := []any{elapsed, code, data}
	line, err := json.Marshal(frame)
	if err != nil {
		return
	}
	if _, err := r.writer.Write(append(line, '\n')); err != nil {
		// Record the first write error and stop emitting so a full/read-only disk
		// produces a clean truncation rather than a stream of ignored failures.
		r.writeErr = err
	}
}

// close flushes and closes the file, returning the first write/flush error seen
// (nil on success). Safe to call more than once; later calls return nil. Any
// incomplete UTF-8 tail still in r.pending is intentionally dropped rather than
// written as replacement bytes, so the .cast ends on a clean event boundary.
func (r *castRecorder) close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil
	}
	r.closed = true
	flushErr := r.writer.Flush()
	closeErr := r.file.Close()
	if r.writeErr != nil {
		return r.writeErr
	}
	if flushErr != nil {
		return flushErr
	}
	return closeErr
}

func (r *castRecorder) filePath() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.path
}

// recordingError is returned when a recording control call cannot proceed.
func recordingError(format string, args ...any) error {
	return fmt.Errorf(format, args...)
}
