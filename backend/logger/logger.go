package logger

import (
	"encoding/json"
	"fmt"
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

const maxLogSize = 10 * 1024 * 1024

type Logger struct {
	path        string
	historyPath string
	mu          sync.Mutex
}

// LogFields represents structured log fields.
type LogFields map[string]interface{}

func New(dir string) *Logger {
	return &Logger{
		path:        filepath.Join(dir, "logs", "app.log"),
		historyPath: filepath.Join(dir, "logs", "history.log"),
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
	_ = os.MkdirAll(filepath.Dir(l.path), 0755)
	if info, err := os.Stat(l.path); err == nil && info.Size() >= int64(maxLogSize) {
		_ = os.Rename(l.path, l.path+".1")
	}
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(content)
}

func (l *Logger) LogCommand(sessionID, host string, line string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	ts := time.Now().Format("2006-01-02 15:04:05")
	// Redact inline secrets (e.g. `mysql -psecret`, `export TOKEN=...`) before
	// persisting the command to history.log.
	safeLine := redact(strings.TrimSpace(line))
	entry := fmt.Sprintf("[%s] [%s@%s] %s\n", ts, sessionID, host, safeLine)
	_ = os.MkdirAll(filepath.Dir(l.historyPath), 0755)
	f, err := os.OpenFile(l.historyPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(entry)
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

func (l *Logger) ReadLatest(limit int) []types.LogEntry {
	l.mu.Lock()
	data, err := os.ReadFile(l.path)
	l.mu.Unlock()
	if err != nil {
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
			lineRe := regexp.MustCompile(`^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^ ]*)\s+\[(\w+)\]\s+(.*)`)
			if matches := lineRe.FindStringSubmatch(line); len(matches) == 4 {
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
