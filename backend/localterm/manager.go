package localterm

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"

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

	shell := defaultShell()
	id := newSessionID()
	info := types.SessionInfo{
		ID:        id,
		ProfileID: "",
		Name:      shellLabel(),
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

	m.mu.Lock()
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
		if session.cmd != nil && session.cmd.Process != nil {
			_ = session.cmd.Process.Kill()
		}
		session.pty.Close()
		close(session.done)
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
	defer session.mu.RUnlock()
	_, err = session.pty.Write([]byte(data))
	return err
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

func (m *Manager) forwardOutput(id string, reader io.Reader) {
	type readResult struct {
		data []byte
		err  error
	}
	ch := make(chan readResult, 1)
	go func() {
		buf := make([]byte, 32768)
		for {
			n, err := reader.Read(buf)
			if n > 0 {
				data := make([]byte, n)
				copy(data, buf[:n])
				ch <- readResult{data: data, err: err}
			} else {
				ch <- readResult{err: err}
			}
			if err != nil {
				return
			}
		}
	}()

	var batch bytes.Buffer
	flushTimer := time.NewTimer(16 * time.Millisecond)
	defer flushTimer.Stop()

	const maxBatchSize = 32768

	for {
		m.mu.RLock()
		session := m.sessions[id]
		m.mu.RUnlock()
		if session == nil {
			if batch.Len() > 0 {
				m.emit("terminal:data", map[string]string{
					"sessionId": id,
					"data":      batch.String(),
				})
			}
			return
		}

		select {
		case <-session.done:
			if batch.Len() > 0 {
				m.emit("terminal:data", map[string]string{
					"sessionId": id,
					"data":      batch.String(),
				})
			}
			return

		case res := <-ch:
			if len(res.data) > 0 {
				batch.Write(res.data)
				if batch.Len() >= maxBatchSize {
					m.emit("terminal:data", map[string]string{
						"sessionId": id,
						"data":      batch.String(),
					})
					batch.Reset()
					if !flushTimer.Stop() {
						select {
						case <-flushTimer.C:
						default:
						}
					}
					flushTimer.Reset(16 * time.Millisecond)
				}
			}
			if res.err != nil {
				if batch.Len() > 0 {
					m.emit("terminal:data", map[string]string{
						"sessionId": id,
						"data":      batch.String(),
					})
				}
				return
			}

		case <-flushTimer.C:
			if batch.Len() > 0 {
				m.emit("terminal:data", map[string]string{
					"sessionId": id,
					"data":      batch.String(),
				})
				batch.Reset()
			}
			flushTimer.Reset(16 * time.Millisecond)
		}
	}
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

func shellLabel() string {
	switch runtime.GOOS {
	case "windows":
		if _, err := exec.LookPath("pwsh.exe"); err == nil {
			return "PowerShell"
		}
		if _, err := exec.LookPath("powershell.exe"); err == nil {
			return "PowerShell"
		}
		return "CMD"
	case "darwin":
		return "zsh"
	default:
		if sh := os.Getenv("SHELL"); sh != "" {
			return sh
		}
		return "bash"
	}
}

func newSessionID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "lterm-" + hex.EncodeToString(b)
}
