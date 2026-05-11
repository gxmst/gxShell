package logger

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"gxShell/backend/types"
)

type Logger struct {
	path string
	mu   sync.Mutex
}

func New(dir string) *Logger {
	return &Logger{path: filepath.Join(dir, "logs", "app.log")}
}

func (l *Logger) Info(message string) {
	l.Write("info", message)
}

func (l *Logger) Error(message string) {
	l.Write("error", message)
}

func (l *Logger) Write(level, message string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	message = redact(message)
	line := fmt.Sprintf("%s [%s] %s\n", time.Now().Format(time.RFC3339), strings.ToUpper(level), message)
	_ = os.MkdirAll(filepath.Dir(l.path), 0755)
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(line)
}

func (l *Logger) ReadLatest(limit int) []types.LogEntry {
	l.mu.Lock()
	defer l.mu.Unlock()
	data, err := os.ReadFile(l.path)
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
		entries = append(entries, types.LogEntry{
			Time:    time.Now(),
			Level:   "info",
			Message: line,
		})
	}
	return entries
}

func redact(s string) string {
	patterns := []string{
		`(?i)(password|passphrase|privateKey|private_key|secret|token)\s*[:=]\s*[^,\s}]+`,
		`(?i)("?(password|passphrase|privateKey|private_key|secret|token)"?\s*:\s*)"[^"]*"`,
	}
	for _, pattern := range patterns {
		re := regexp.MustCompile(pattern)
		s = re.ReplaceAllStringFunc(s, func(match string) string {
			if strings.Contains(match, ":") {
				parts := strings.SplitN(match, ":", 2)
				return parts[0] + `:"<redacted>"`
			}
			parts := strings.SplitN(match, "=", 2)
			return parts[0] + "=<redacted>"
		})
	}
	return s
}
