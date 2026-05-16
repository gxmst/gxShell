package logger

import (
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

func New(dir string) *Logger {
	return &Logger{
		path:        filepath.Join(dir, "logs", "app.log"),
		historyPath: filepath.Join(dir, "logs", "history.log"),
	}
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
	if info, err := os.Stat(l.path); err == nil && info.Size() >= int64(maxLogSize) {
		_ = os.Rename(l.path, l.path+".1")
	}
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(line)
}

func (l *Logger) LogCommand(sessionID, host string, line string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	ts := time.Now().Format("2006-01-02 15:04:05")
	entry := fmt.Sprintf("[%s] [%s@%s] %s\n", ts, sessionID, host, strings.TrimSpace(line))
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
	lineRe := regexp.MustCompile(`^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^ ]*)\s+\[(\w+)\]\s+(.*)`)
	for _, line := range lines[start:] {
		entry := types.LogEntry{
			Time:    time.Now(),
			Level:   "info",
			Message: line,
		}
		if matches := lineRe.FindStringSubmatch(line); len(matches) == 4 {
			if t, err := time.Parse(time.RFC3339, matches[1]); err == nil {
				entry.Time = t
			}
			entry.Level = strings.ToLower(matches[2])
			entry.Message = matches[3]
		}
		entries = append(entries, entry)
	}
	return entries
}

var redactPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(password|passphrase|privateKey|private_key|secret|token)\s*[:=]\s*[^,\s}]+`),
	regexp.MustCompile(`(?i)("?(password|passphrase|privateKey|private_key|secret|token)"?\s*:\s*)"[^"]*"`),
}

func redact(s string) string {
	for _, re := range redactPatterns {
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
