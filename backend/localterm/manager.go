package localterm

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
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

	"gxShell/backend/termio"
	"gxShell/backend/types"

	"github.com/charmbracelet/x/xpty"
)

type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	emit     func(event string, data any)
}

type Session struct {
	info      types.SessionInfo
	pty       xpty.Pty
	cmd       *exec.Cmd
	writer    *termio.WriteQueue
	done      chan struct{}
	closeOnce sync.Once
	mu        sync.RWMutex
}

func NewManager(emit func(event string, data any)) *Manager {
	return &Manager{
		sessions: map[string]*Session{},
		emit:     emit,
	}
}

const maxLocalSessions = 10

func (m *Manager) Connect(cols int, rows int) (types.SessionInfo, error) {
	return m.ConnectWithOptions("", "", cols, rows)
}

// ConnectWithOptions opens a local shell with user-selected defaults. The
// executable is intentionally kept separate from arguments: this avoids
// ambiguous command-line parsing and still supports pwsh, cmd, wsl, or a
// custom shell executable.
func (m *Manager) ConnectWithOptions(shellSetting string, startDirectory string, cols int, rows int) (types.SessionInfo, error) {
	m.mu.RLock()
	count := len(m.sessions)
	m.mu.RUnlock()
	if count >= maxLocalSessions {
		return types.SessionInfo{}, fmt.Errorf("local terminal limit reached (%d max)", maxLocalSessions)
	}
	if cols <= 0 {
		cols = 120
	}
	if rows <= 0 {
		rows = 34
	}

	shell, err := resolveShell(shellSetting)
	if err != nil {
		return types.SessionInfo{}, err
	}
	workingDirectory, err := resolveStartDirectory(startDirectory)
	if err != nil {
		return types.SessionInfo{}, err
	}
	id := newSessionID()
	info := types.SessionInfo{
		ID:        id,
		ProfileID: "",
		Name:      shellLabel(shell),
		State:     types.SessionConnecting,
		Cols:      cols,
		Rows:      rows,
		StartedAt: time.Now(),
	}

	// Create a pseudo-terminal with the requested dimensions.
	// On Windows this uses ConPTY; on Unix it uses /dev/ptmx.
	pty, err := xpty.NewPty(cols, rows)
	if err != nil {
		return types.SessionInfo{}, fmt.Errorf("create pty: %w", err)
	}

	cmd := exec.Command(shell)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	cmd.Dir = workingDirectory

	if err := pty.Start(cmd); err != nil {
		pty.Close()
		return types.SessionInfo{}, fmt.Errorf("start shell: %w", err)
	}

	session := &Session{
		info: info,
		pty:  pty,
		cmd:  cmd,
		done: make(chan struct{}),
	}
	session.writer = termio.NewWriteQueue(session.done, 1024*1024, func(data []byte) error {
		session.mu.RLock()
		pty := session.pty
		session.mu.RUnlock()
		if pty == nil {
			return errors.New("local terminal is not writable")
		}
		_, writeErr := pty.Write(data)
		return writeErr
	}, func(writeErr error) {
		m.emit("terminal:error", map[string]any{
			"sessionId": id,
			"error":     "local terminal input failed: " + writeErr.Error(),
		})
		go func() { _ = m.Disconnect(id) }()
	})

	m.mu.Lock()
	// Re-check the limit under the write lock: concurrent connects can pass the
	// early read-locked check together, and by now the shell is already running,
	// so a loser must tear its process and pty down again.
	if len(m.sessions) >= maxLocalSessions {
		m.mu.Unlock()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		pty.Close()
		go func() { _ = cmd.Wait() }()
		return types.SessionInfo{}, fmt.Errorf("local terminal limit reached (%d max)", maxLocalSessions)
	}
	m.sessions[id] = session
	m.mu.Unlock()

	session.mu.Lock()
	session.info.State = types.SessionConnected
	info = session.info
	session.mu.Unlock()

	m.emit("terminal:connecting", info)
	m.emit("terminal:connected", info)

	go m.forwardOutput(id, pty)

	go func() {
		defer func() {
			if r := recover(); r != nil {
				m.emit("terminal:error", map[string]any{
					"sessionId": id,
					"error":     fmt.Sprintf("internal panic: %v", r),
				})
			}
		}()
		_ = cmd.Wait()
		m.Disconnect(id)
	}()

	return info, nil
}

func (m *Manager) Disconnect(id string) error {
	m.mu.Lock()
	session := m.sessions[id]
	if session == nil {
		m.mu.Unlock()
		return errors.New("session not found")
	}
	delete(m.sessions, id)
	m.mu.Unlock()

	session.closeOnce.Do(func() {
		session.mu.Lock()
		close(session.done)
		if session.cmd != nil && session.cmd.Process != nil {
			_ = session.cmd.Process.Kill()
		}
		if session.pty != nil {
			session.pty.Close()
		}
		if session.info.State != types.SessionError {
			session.info.State = types.SessionDisconnected
		}
		info := session.info
		session.mu.Unlock()
		m.emit("terminal:disconnected", info)
	})
	return nil
}

func (m *Manager) Write(id string, data string) error {
	session, err := m.get(id)
	if err != nil {
		return err
	}
	session.mu.RLock()
	writer := session.writer
	session.mu.RUnlock()
	if writer == nil {
		return errors.New("local terminal is not writable")
	}
	return writer.Enqueue([]byte(data))
}

func (m *Manager) Resize(id string, cols int, rows int) error {
	session, err := m.get(id)
	if err != nil {
		return err
	}
	session.mu.RLock()
	defer session.mu.RUnlock()
	return session.pty.Resize(cols, rows)
}

func (m *Manager) Get(id string) (types.SessionInfo, error) {
	session, err := m.get(id)
	if err != nil {
		return types.SessionInfo{}, err
	}
	session.mu.RLock()
	defer session.mu.RUnlock()
	return session.info, nil
}

func (m *Manager) List() []types.SessionInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()
	items := make([]types.SessionInfo, 0, len(m.sessions))
	for _, session := range m.sessions {
		session.mu.RLock()
		items = append(items, session.info)
		session.mu.RUnlock()
	}
	return items
}

func (m *Manager) Shutdown() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.sessions))
	for id := range m.sessions {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		_ = m.Disconnect(id)
	}
}

func (m *Manager) get(id string) (*Session, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	session := m.sessions[id]
	if session == nil {
		return nil, errors.New("session not found")
	}
	return session, nil
}

// forwardOutput streams pty output to the frontend through the shared
// termio.Pump (16ms/32KB batching + UTF-8 boundary handling). The pump's
// internal reader also selects on session.done, so closing the pty cannot
// strand a reader goroutine blocked on its handoff channel.
func (m *Manager) forwardOutput(id string, reader io.Reader) {
	m.mu.RLock()
	session := m.sessions[id]
	m.mu.RUnlock()
	if session == nil {
		return
	}
	termio.Pump(reader, session.done, func(chunk string) {
		m.emit("terminal:data", map[string]string{
			"sessionId": id,
			"data":      chunk,
		})
	})
}

func defaultShell() string {
	switch runtime.GOOS {
	case "windows":
		if ps, err := exec.LookPath("pwsh.exe"); err == nil {
			return ps
		}
		if ps, err := exec.LookPath("powershell.exe"); err == nil {
			return ps
		}
		return "cmd.exe"
	case "darwin":
		if zsh, err := exec.LookPath("zsh"); err == nil {
			return zsh
		}
		return "/bin/bash"
	default:
		if sh := os.Getenv("SHELL"); sh != "" {
			return sh
		}
		return "/bin/bash"
	}
}

func resolveShell(setting string) (string, error) {
	setting = strings.TrimSpace(setting)
	if setting == "" || strings.EqualFold(setting, "auto") {
		return defaultShell(), nil
	}
	resolved, err := exec.LookPath(setting)
	if err != nil {
		return "", fmt.Errorf("local shell %q was not found: %w", setting, err)
	}
	return resolved, nil
}

func resolveStartDirectory(setting string) (string, error) {
	home, homeErr := os.UserHomeDir()
	setting = strings.TrimSpace(setting)
	if setting == "" || setting == "~" {
		if homeErr != nil || home == "" {
			if homeErr != nil {
				return "", fmt.Errorf("resolve home directory: %w", homeErr)
			}
			return "", errors.New("resolve home directory: empty path")
		}
		setting = home
	} else {
		setting = expandEnvironment(setting)
		if strings.HasPrefix(setting, "~/") || strings.HasPrefix(setting, "~\\") {
			if homeErr != nil || home == "" {
				if homeErr != nil {
					return "", fmt.Errorf("resolve home directory: %w", homeErr)
				}
				return "", errors.New("resolve home directory: empty path")
			}
			setting = filepath.Join(home, setting[2:])
		}
	}
	setting = filepath.Clean(setting)
	info, err := os.Stat(setting)
	if err != nil {
		return "", fmt.Errorf("local terminal start directory %q is unavailable: %w", setting, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("local terminal start path %q is not a directory", setting)
	}
	return setting, nil
}

var windowsEnvironmentPattern = regexp.MustCompile(`%[^%]+%`)

func expandEnvironment(value string) string {
	value = os.ExpandEnv(value)
	if runtime.GOOS != "windows" {
		return value
	}
	return windowsEnvironmentPattern.ReplaceAllStringFunc(value, func(match string) string {
		if expanded, ok := os.LookupEnv(match[1 : len(match)-1]); ok {
			return expanded
		}
		return match
	})
}

func shellLabel(shell string) string {
	name := strings.TrimSuffix(strings.ToLower(filepath.Base(shell)), filepath.Ext(shell))
	switch name {
	case "pwsh", "powershell":
		return "PowerShell"
	case "cmd":
		return "CMD"
	case "wsl":
		return "WSL"
	case "":
		return "Local Terminal"
	default:
		return filepath.Base(shell)
	}
}

func newSessionID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "lterm-" + hex.EncodeToString(b)
}
