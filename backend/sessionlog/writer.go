// Package sessionlog writes bounded, plain-text SSH output transcripts.
package sessionlog

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"gxShell/backend/config"
	"gxShell/backend/types"

	"github.com/charmbracelet/x/ansi"
)

type chunk struct {
	stream int
	text   string
	at     time.Time
}

type Writer struct {
	mu                             sync.Mutex
	queue                          chan chunk
	done                           chan struct{}
	closed                         bool
	err                            error
	onError                        func(error)
	dir, prefix, day               string
	settings                       types.SessionLogSettings
	file                           *os.File
	size, total, maxFile, maxTotal int64
	sequence                       int
	now                            func() time.Time
}

func New(dir, name string, settings types.SessionLogSettings, onError func(error)) (*Writer, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	name = strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			return r
		}
		return '_'
	}, name)
	if len(name) > 48 {
		name = name[:48]
	}
	settings = config.NormalizeSessionLog(settings)
	w := &Writer{dir: dir, prefix: name + "-" + types.NewID("log"), settings: settings, queue: make(chan chunk, 64), done: make(chan struct{}), onError: onError, now: time.Now, maxFile: int64(settings.MaxFileMB) * 1024 * 1024, maxTotal: int64(settings.MaxSessionMB) * 1024 * 1024}
	if err := w.rotate(w.now()); err != nil {
		return nil, err
	}
	go w.run()
	return w, nil
}

// WriteStream never waits for disk IO. A full queue stops logging with an
// explicit error instead of blocking terminal output or silently losing data.
func (w *Writer) WriteStream(stream int, text string) {
	w.mu.Lock()
	if w.closed || w.err != nil {
		w.mu.Unlock()
		return
	}
	if stream < 0 || stream > 1 {
		w.mu.Unlock()
		return
	}
	for len(text) > 0 {
		n := min(len(text), 32*1024)
		select {
		case w.queue <- chunk{stream, text[:n], w.now()}:
			text = text[n:]
		default:
			w.mu.Unlock()
			w.fail(errors.New("session logging stopped: disk writer queue is full"))
			return
		}
	}
	w.mu.Unlock()
}

func (w *Writer) fail(err error) {
	if err == nil {
		return
	}
	w.mu.Lock()
	first := w.err == nil
	if first {
		w.err = err
	}
	w.mu.Unlock()
	if first && w.onError != nil {
		w.onError(err)
	}
}

func (w *Writer) Close() error {
	w.mu.Lock()
	if !w.closed {
		w.closed = true
		close(w.queue)
	}
	w.mu.Unlock()
	<-w.done
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.err
}

func (w *Writer) rotate(at time.Time) error {
	if w.file != nil {
		if err := w.file.Close(); err != nil {
			w.file = nil
			return err
		}
		w.file = nil
	}
	w.day = at.Format("2006-01-02")
	w.sequence++
	path := filepath.Join(w.dir, fmt.Sprintf("%s-%s-%04d.log", w.day, w.prefix, w.sequence))
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	w.file, w.size = f, 0
	return nil
}

func (w *Writer) appendLine(data []byte, at time.Time) error {
	if w.total+int64(len(data)) > w.maxTotal {
		return errors.New("session logging stopped: connection size limit reached")
	}
	if w.file == nil || w.day != at.Format("2006-01-02") || w.size+int64(len(data)) > w.maxFile {
		if err := w.rotate(at); err != nil {
			return err
		}
	}
	n, err := w.file.Write(data)
	w.size += int64(n)
	w.total += int64(n)
	return err
}

func (w *Writer) run() {
	defer close(w.done)
	defer func() {
		if w.file != nil {
			w.fail(w.file.Close())
		}
	}()
	type streamState struct {
		parser  *ansi.Parser
		line    []byte
		at      time.Time
		chunkAt time.Time
		cr      bool
	}
	streams := [2]*streamState{}
	var writeErr error
	flush := func(s *streamState) {
		if writeErr != nil {
			s.line = s.line[:0]
			return
		}
		data := append(s.line, '\n')
		if w.settings.Timestamps {
			data = append([]byte("["+s.at.Format(time.RFC3339Nano)+"] "), data...)
		}
		writeErr = w.appendLine(data, s.at)
		if writeErr != nil {
			w.fail(writeErr)
		}
		s.line = nil
		s.cr = false
		s.at = s.chunkAt
	}
	for i := range streams {
		s := &streamState{parser: ansi.NewParser()}
		s.parser.SetDataSize(1024)
		s.parser.SetHandler(ansi.Handler{
			Print: func(r rune) {
				if s.cr {
					flush(s)
				}
				s.line = utf8.AppendRune(s.line, r)
				if len(s.line) >= 16*1024 {
					flush(s)
				}
			},
			Execute: func(b byte) {
				switch b {
				case '\n':
					flush(s)
				case '\r':
					s.cr = true
				case '\t':
					if s.cr {
						flush(s)
					}
					s.line = append(s.line, '\t')
					if len(s.line) >= 16*1024 {
						flush(s)
					}
				case '\b':
					if len(s.line) > 0 {
						_, n := utf8.DecodeLastRune(s.line)
						s.line = s.line[:len(s.line)-n]
					}
				}
			},
		})
		streams[i] = s
	}
	for item := range w.queue {
		if writeErr != nil {
			continue
		}
		s := streams[item.stream]
		s.chunkAt = item.at
		if len(s.line) == 0 {
			s.at = item.at
		}
		s.parser.Parse([]byte(item.text))
	}
	for _, s := range streams {
		if len(s.line) > 0 {
			flush(s)
		}
	}
}
