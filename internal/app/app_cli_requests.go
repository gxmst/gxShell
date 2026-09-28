package app

import (
	"bytes"
	"crypto/sha256"
	"io"
	"net/http"
	"regexp"
	"sync"
	"time"
)

const cliRequestRetention = 30 * time.Minute
const cliRequestCacheBytes = 16 << 20
const cliRequestResultLimit = 4 << 20

var cliRequestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,96}$`)

type cliRequestRecord struct {
	digest   [32]byte
	done     chan struct{}
	finished time.Time
	status   int
	result   []byte
}

type cliRequestRegistry struct {
	mu      sync.Mutex
	entries map[string]*cliRequestRecord
	bytes   int
}

// Auth wraps this handler. Only explicitly identified exec requests participate;
// identical commands with different IDs remain intentional independent actions.
func (a *App) deduplicateCliExec(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-GxShell-Request-ID")
		if id == "" || r.Method != http.MethodPost {
			next(w, r)
			return
		}
		if !cliRequestIDPattern.MatchString(id) {
			writeCliError(w, http.StatusBadRequest, "validation", "invalid request ID (use 1-96 letters, digits, underscores or hyphens)")
			return
		}
		w.Header().Set("X-GxShell-Request-ID", id)
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, cliMaxRequestSize))
		if err != nil {
			writeCliError(w, http.StatusBadRequest, "validation", "request body exceeds the limit or could not be read")
			return
		}
		digest := sha256.Sum256(body)
		registry := &a.cliRequests
		registry.mu.Lock()
		if registry.entries == nil {
			registry.entries = make(map[string]*cliRequestRecord)
		}
		for key, record := range registry.entries {
			if !record.finished.IsZero() && time.Since(record.finished) > cliRequestRetention {
				registry.bytes -= len(record.result)
				delete(registry.entries, key)
			}
		}
		if record := registry.entries[id]; record != nil {
			registry.mu.Unlock()
			if record.digest != digest {
				writeCliError(w, http.StatusConflict, "request_id_conflict", "this request ID belongs to a different payload; no command was executed")
				return
			}
			select {
			case <-record.done:
				w.Header().Set("X-GxShell-Request-Replayed", "true")
				if record.result == nil {
					writeCliError(w, http.StatusConflict, "request_result_unavailable", "this request already completed, but its response was not retained; it was not executed again")
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(record.status)
				_, _ = w.Write(record.result)
			case <-r.Context().Done():
				// Cancelling a duplicate waiter must not cancel the original action.
			}
			return
		}
		// Never evict a live deduplication key just to make space: that would
		// silently make a previously protected request executable again.
		if len(registry.entries) >= 4096 {
			registry.mu.Unlock()
			writeCliError(w, http.StatusTooManyRequests, "request_capacity", "request history is full; no command was executed, retry later")
			return
		}
		record := &cliRequestRecord{digest: digest, done: make(chan struct{})}
		registry.entries[id] = record
		registry.mu.Unlock()
		capture := &cliResponseCapture{ResponseWriter: w, status: http.StatusOK}
		completed := false
		defer func() {
			registry.mu.Lock()
			record.status = capture.status
			if completed && !capture.overflow && registry.bytes+capture.body.Len() <= cliRequestCacheBytes {
				record.result = append([]byte(nil), capture.body.Bytes()...)
				registry.bytes += len(record.result)
			}
			record.finished = time.Now()
			close(record.done)
			registry.mu.Unlock()
		}()
		r.Body = io.NopCloser(bytes.NewReader(body))
		next(capture, r)
		completed = true
	}
}

type cliResponseCapture struct {
	http.ResponseWriter
	status   int
	body     bytes.Buffer
	overflow bool
}

func (w *cliResponseCapture) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *cliResponseCapture) Write(body []byte) (int, error) {
	if !w.overflow {
		if w.body.Len()+len(body) > cliRequestResultLimit {
			w.overflow = true
			w.body.Reset()
		} else {
			_, _ = w.body.Write(body)
		}
	}
	return w.ResponseWriter.Write(body)
}
