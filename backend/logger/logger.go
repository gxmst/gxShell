package logger

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"gxShell/backend/types"
)

const (
	maxLogSize          = 10 * 1024 * 1024
	maxRotatedLogFiles  = 3
	commandPreviewLimit = 500
	fullCommandLogEnv   = "GXSHELL_LOG_FULL_COMMANDS"
)

type Logger struct {
	path        string
	historyPath string
	mu          sync.Mutex
	app         *logFile
	history     *logFile
}

// LogFields represents structured log fields.
type LogFields map[string]interface{}

func New(dir string) *Logger {
	path := filepath.Join(dir, "logs", "app.log")
	historyPath := filepath.Join(dir, "logs", "history.log")
	return &Logger{
		path:        path,
		historyPath: historyPath,
		app:         &logFile{path: path},
		history:     &logFile{path: historyPath},
	}
}

func (l *Logger) Info(message string) {
	l.Write("info", message, nil)
}

func (l *Logger) Error(message string) {
	l.Write("error", message, nil)
}

// InfoFields logs an info message with structured fields.
func (l *Logger) InfoFields(message string, fields LogFields) {
	l.Write("info", message, fields)
}

// ErrorFields logs an error message with structured fields.
func (l *Logger) ErrorFields(message string, fields LogFields) {
	l.Write("error", message, fields)
}

func (l *Logger) Write(level, message string, fields LogFields) {
	l.mu.Lock()
	defer l.mu.Unlock()

	message = redact(message)

	// Create structured log entry
	entry := map[string]interface{}{
		"timestamp": time.Now().Format(time.RFC3339),
		"level":     strings.ToUpper(level),
		"message":   message,
	}

	// Add fields if provided
	if fields != nil {
		for k, v := range fields {
			// Redact sensitive field values
			if isSensitiveKey(k) {
				entry[k] = "<redacted>"
			} else if str, ok := v.(string); ok {
				entry[k] = redact(str)
			} else {
				entry[k] = v
			}
		}
	}

	// Serialize to JSON
	jsonBytes, err := json.Marshal(entry)
	if err != nil {
		// Fallback to plain text
		line := fmt.Sprintf("%s [%s] %s\n", entry["timestamp"], level, message)
		l.writeToFile(line)
		return
	}

	l.writeToFile(string(jsonBytes) + "\n")
}

func (l *Logger) writeToFile(content string) {
	l.app.write(content)
}

// logFile owns one open append handle per log target and mirrors the file size
// in memory for rotation decisions, so the steady-state cost per entry is a
// single write syscall instead of open/stat/write/close. The handle is opened
// lazily and dropped on any write failure; the periodic existence re-check
// recovers the file being deleted or moved externally (on Unix an unlinked
// file would otherwise keep absorbing writes invisibly). Guarded by the owning
// Logger's mu.
type logFile struct {
	path   string
	f      *os.File
	size   int64
	writes int
}

// existenceRecheckWrites bounds how stale the handle can get after an external
// deletion; one stat per N writes is noise next to the per-write open the old
// implementation paid.
const existenceRecheckWrites = 512

func (lf *logFile) write(content string) {
	if lf.f == nil && !lf.open() {
		return
	}
	lf.writes++
	if lf.writes%existenceRecheckWrites == 0 {
		if _, err := os.Stat(lf.path); err != nil {
			lf.close()
			if !lf.open() {
				return
			}
		}
	}
	if lf.size+int64(len(content)) >= maxLogSize {
		lf.close()
		rotateLogFiles(lf.path)
		if !lf.open() {
			return
		}
	}
	if _, err := lf.f.WriteString(content); err != nil {
		// Retry once on a fresh handle in case the old one went stale.
		lf.close()
		if !lf.open() {
			return
		}
		if _, err := lf.f.WriteString(content); err != nil {
			lf.close()
			return
		}
	}
	lf.size += int64(len(content))
}

func (lf *logFile) open() bool {
	if err := os.MkdirAll(filepath.Dir(lf.path), 0755); err != nil {
		return false
	}
	f, err := os.OpenFile(lf.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return false
	}
	size := int64(0)
	if info, err := f.Stat(); err == nil {
		size = info.Size()
	}
	lf.f = f
	lf.size = size
	lf.writes = 0
	return true
}

func (lf *logFile) close() {
	if lf.f != nil {
		_ = lf.f.Close()
		lf.f = nil
	}
}

// Close releases the open log file handles (Windows cannot delete a file that
// is still held open). Writes after Close simply reopen the handles lazily, so
// calling it after the final shutdown entry is safe.
func (l *Logger) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.app.close()
	l.history.close()
}

func (l *Logger) LogCommand(sessionID, host string, line string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	ts := time.Now().Format("2006-01-02 15:04:05")
	// Redact inline secrets (e.g. `mysql -psecret`, `export TOKEN=...`) before
	// persisting the command to history.log.
	safeLine := redact(strings.TrimSpace(line))
	entry := fmt.Sprintf("[%s] [%s@%s] %s\n", ts, sessionID, host, safeLine)
	l.history.write(entry)
}

func (l *Logger) OpenHistory() error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("explorer.exe", "/select,", l.historyPath).Start()
	case "darwin":
		return exec.Command("open", "-R", l.historyPath).Start()
	default:
		return exec.Command("xdg-open", filepath.Dir(l.historyPath)).Start()
	}
}

// readLatestTailCap bounds how much of the log ReadLatest loads. The UI shows
// at most a few hundred recent entries, so reading a full 10MB file on every
// refresh is pure waste; a 512KB tail covers thousands of lines.
const readLatestTailCap = 512 * 1024

func (l *Logger) ReadLatest(limit int) []types.LogEntry {
	l.mu.Lock()
	data := readTailBytes(l.path, readLatestTailCap)
	l.mu.Unlock()
	if len(data) == 0 {
		return []types.LogEntry{}
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if limit <= 0 || limit > len(lines) {
		limit = len(lines)
	}
	start := len(lines) - limit
	entries := make([]types.LogEntry, 0, limit)

	for _, line := range lines[start:] {
		entry := types.LogEntry{
			Time:    time.Now(),
			Level:   "info",
			Message: line,
		}

		// Try to parse as JSON first
		var jsonEntry map[string]interface{}
		if err := json.Unmarshal([]byte(line), &jsonEntry); err == nil {
			if ts, ok := jsonEntry["timestamp"].(string); ok {
				if t, err := time.Parse(time.RFC3339, ts); err == nil {
					entry.Time = t
				}
			}
			if level, ok := jsonEntry["level"].(string); ok {
				entry.Level = strings.ToLower(level)
			}
			if msg, ok := jsonEntry["message"].(string); ok {
				entry.Message = msg
			}
		} else {
			// Fallback to old plain text format
			if matches := plainLogLineRe.FindStringSubmatch(line); len(matches) == 4 {
				if t, err := time.Parse(time.RFC3339, matches[1]); err == nil {
					entry.Time = t
				}
				entry.Level = strings.ToLower(matches[2])
				entry.Message = matches[3]
			}
		}
		entries = append(entries, entry)
	}
	return entries
}

// readTailBytes reads at most maxBytes from the end of the file. When the read
// does not start at offset zero, the first line is almost certainly partial and
// is dropped, so callers only ever parse whole lines.
func readTailBytes(path string, maxBytes int64) []byte {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil
	}
	start := info.Size() - maxBytes
	if start < 0 {
		start = 0
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return nil
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil
	}
	if start > 0 {
		idx := bytes.IndexByte(data, '\n')
		if idx < 0 {
			return nil
		}
		data = data[idx+1:]
	}
	return data
}

// plainLogLineRe parses the pre-JSON log line format. Package-level so
// ReadLatest does not recompile it for every non-JSON line of a large file.
var plainLogLineRe = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^ ]*)\s+\[(\w+)\]\s+(.*)`)

var redactPatterns = []struct {
	re      *regexp.Regexp
	replace string
}{
	{
		regexp.MustCompile(`(?i)(password|passphrase|privateKey|private_key|secret|token|apikey|api_key)(\s*[:=]\s*)[^,\s}]+`),
		`${1}${2}<redacted>`,
	},
	{
		regexp.MustCompile(`(?i)("?(password|passphrase|privateKey|private_key|secret|token|apikey|api_key)"?\s*:\s*)"[^"]*"`),
		`${1}"<redacted>"`,
	},
	// Inline passwords glued to short flags, e.g. `mysql -ppassword` where the
	// secret immediately follows -p with no separator. Scoped to known database
	// CLIs to avoid false positives on other -p flags (e.g. -p8080 for port).
	{
		regexp.MustCompile(`(?i)(mysql|mysqldump|mariadb)([^\n|]*\s-p)\S+`),
		`${1}${2}<redacted>`,
	},
}

var sensitiveKeys = map[string]bool{
	"password": true, "passphrase": true, "privatekey": true, "private_key": true,
	"secret": true, "token": true, "apikey": true, "api_key": true,
}

func isSensitiveKey(key string) bool {
	return sensitiveKeys[strings.ToLower(key)]
}

func redact(s string) string {
	for _, p := range redactPatterns {
		s = p.re.ReplaceAllString(s, p.replace)
	}
	return s
}

// CommandAuditFields returns log fields that preserve enough command context
// for troubleshooting without storing full scripts or generated secrets by
// default. Set GXSHELL_LOG_FULL_COMMANDS=1 while launching gxShell to include
// the redacted full command during a focused debug session.
func CommandAuditFields(command string) LogFields {
	trimmed := strings.TrimSpace(command)
	sum := sha256.Sum256([]byte(trimmed))
	fields := LogFields{
		"commandHash":      fmt.Sprintf("%x", sum[:]),
		"commandLength":    len(trimmed),
		"commandPreview":   commandPreview(trimmed),
		"commandTruncated": len(trimmed) > commandPreviewLimit,
	}
	if fullCommandLoggingEnabled() {
		fields["command"] = trimmed
	}
	return fields
}

func commandPreview(command string) string {
	command = normalizeCommandForPreview(redact(command))
	if len(command) <= commandPreviewLimit {
		return command
	}
	return command[:commandPreviewLimit]
}

func normalizeCommandForPreview(command string) string {
	command = strings.ReplaceAll(command, "\r\n", "\n")
	command = strings.ReplaceAll(command, "\r", "\n")
	fields := strings.Fields(command)
	return strings.Join(fields, " ")
}

func fullCommandLoggingEnabled() bool {
	value := strings.TrimSpace(os.Getenv(fullCommandLogEnv))
	return value == "1" || strings.EqualFold(value, "true") || strings.EqualFold(value, "yes")
}

// rotateLogFiles shifts path -> path.1 -> path.2 ... discarding the oldest.
// The caller decides when rotation is due (logFile tracks the size in memory)
// and must have closed its handle to path first.
func rotateLogFiles(path string) {
	for i := maxRotatedLogFiles; i >= 1; i-- {
		src := rotatedLogPath(path, i-1)
		dst := rotatedLogPath(path, i)
		if i == maxRotatedLogFiles {
			_ = os.Remove(dst)
		}
		if _, err := os.Stat(src); err == nil {
			_ = os.Remove(dst)
			_ = os.Rename(src, dst)
		}
	}
}

func rotatedLogPath(path string, index int) string {
	if index <= 0 {
		return path
	}
	return fmt.Sprintf("%s.%d", path, index)
}
