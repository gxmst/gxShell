package sshmanager

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"gxShell/backend/types"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

type Manager struct {
	mu             sync.RWMutex
	sessions       map[string]*Session
	emit           func(event string, data any)
	knownHostsPath string
	confirm        func(host, fingerprint string) bool
}

type Session struct {
	info      types.SessionInfo
	client    *ssh.Client
	shell     *ssh.Session
	stdin     io.WriteCloser
	done      chan struct{}
	closeOnce sync.Once
	mu        sync.RWMutex
}

func NewManager(knownHostsPath string, emit func(event string, data any), confirm func(host, fingerprint string) bool) *Manager {
        return &Manager{
                sessions:       map[string]*Session{},
                emit:           emit,
                knownHostsPath: knownHostsPath,
                confirm:        confirm,
        }
}
const maxSessions = 20

func (m *Manager) Connect(profile types.Profile, timeoutSec int, cols int, rows int) (types.SessionInfo, error) {
	m.mu.RLock()
	count := len(m.sessions)
	m.mu.RUnlock()
	if count >= maxSessions {
		return types.SessionInfo{}, fmt.Errorf("connection limit reached (%d sessions max)", maxSessions)
	}
	if cols <= 0 {
		cols = 120
	}
	if rows <= 0 {
		rows = 34
	}
	if timeoutSec <= 0 {
		timeoutSec = 15
	}

	id := newSessionID()
	info := types.SessionInfo{
		ID:        id,
		ProfileID: profile.ID,
		Name:      profile.Name,
		State:     types.SessionConnecting,
		Cols:      cols,
		Rows:      rows,
		StartedAt: time.Now(),
	}
	session := &Session{info: info, done: make(chan struct{})}
	m.mu.Lock()
	m.sessions[id] = session
	m.mu.Unlock()
	m.emit("terminal:connecting", info)

	config, err := clientConfig(profile, timeoutSec, m.knownHostsPath, m.emit, m.confirm)
	if err != nil {
		m.failConnect(id, err, nil, nil)
		return info, err
	}

	addr := fmt.Sprintf("%s:%d", profile.Host, profile.Port)
	conn, err := net.DialTimeout("tcp", addr, time.Duration(timeoutSec)*time.Second)
	if err != nil {
		m.failConnect(id, err, nil, nil)
		return info, err
	}

	clientConn, chans, reqs, err := ssh.NewClientConn(conn, addr, config)
	if err != nil {
		m.failConnect(id, err, nil, conn)
		return info, err
	}
	client := ssh.NewClient(clientConn, chans, reqs)
	shell, err := client.NewSession()
	if err != nil {
		m.failConnect(id, err, client, nil)
		return info, err
	}

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := shell.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		_ = shell.Close()
		m.failConnect(id, err, client, nil)
		return info, err
	}

	stdin, err := shell.StdinPipe()
	if err != nil {
		_ = shell.Close()
		m.failConnect(id, err, client, nil)
		return info, err
	}
	stdout, err := shell.StdoutPipe()
	if err != nil {
		_ = shell.Close()
		m.failConnect(id, err, client, nil)
		return info, err
	}
	stderr, err := shell.StderrPipe()
	if err != nil {
		_ = shell.Close()
		m.failConnect(id, err, client, nil)
		return info, err
	}
	if err := shell.Shell(); err != nil {
		_ = shell.Close()
		m.failConnect(id, err, client, nil)
		return info, err
	}

	session.mu.Lock()
	session.client = client
	session.shell = shell
	session.stdin = stdin
	session.info.State = types.SessionConnected
	info = session.info
	session.mu.Unlock()
	m.emit("terminal:connected", info)

	go m.forwardOutput(id, stdout)
	go m.forwardOutput(id, stderr)
	go func() {
		panicHandler(id, m)
		err := shell.Wait()
		if err != nil && !errors.Is(err, io.EOF) {
			m.emit("terminal:error", map[string]any{"sessionId": id, "error": err.Error()})
		}
		m.Disconnect(id)
	}()

	return info, nil
}

func (m *Manager) forwardOutput(id string, reader io.Reader) {
	defer panicHandler(id, m)
	buf := make([]byte, 4096)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			m.emit("terminal:data", map[string]string{
				"sessionId": id,
				"data":      string(buf[:n]),
			})
		}
		if err != nil {
			return
		}
		m.mu.RLock()
		session := m.sessions[id]
		m.mu.RUnlock()
		if session == nil {
			return
		}
		select {
		case <-session.done:
			return
		default:
		}
	}
}

func (m *Manager) Write(id string, data string) error {
	session, err := m.get(id)
	if err != nil {
		return err
	}
	session.mu.RLock()
	defer session.mu.RUnlock()
	if session.stdin == nil {
		return errors.New("terminal is not writable")
	}
	_, err = session.stdin.Write([]byte(data))
	return err
}

func (m *Manager) Resize(id string, cols int, rows int) error {
	session, err := m.get(id)
	if err != nil {
		return err
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.shell == nil {
		return errors.New("terminal session is not ready")
	}
	if err := session.shell.WindowChange(rows, cols); err != nil {
		return err
	}
	session.info.Cols = cols
	session.info.Rows = rows
	return nil
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
		if session.stdin != nil {
			_ = session.stdin.Close()
		}
		if session.shell != nil {
			_ = session.shell.Close()
		}
		if session.client != nil {
			_ = session.client.Close()
		}
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

func (m *Manager) Client(id string) (*ssh.Client, error) {
	session, err := m.get(id)
	if err != nil {
		return nil, err
	}
	session.mu.RLock()
	defer session.mu.RUnlock()
	if session.client == nil {
		return nil, errors.New("ssh client is not connected")
	}
	return session.client, nil
}

func (m *Manager) Exec(id string, command string, timeout time.Duration) (string, error) {
	client, err := m.Client(id)
	if err != nil {
		return "", err
	}
	s, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer s.Close()
	var out bytes.Buffer
	var stderr bytes.Buffer
	s.Stdout = &out
	s.Stderr = &stderr

	done := make(chan error, 1)
	go func() {
		done <- s.Run(command)
	}()
	select {
	case err := <-done:
		if err != nil {
			if stderr.Len() > 0 {
				return out.String(), fmt.Errorf("%w: %s", err, stderr.String())
			}
			return out.String(), err
		}
		return out.String(), nil
	case <-time.After(timeout):
		_ = s.Close()
		go func() {
			select {
			case <-done:
			case <-time.After(5 * time.Second):
			}
		}()
		return out.String(), errors.New("remote command timeout")
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

func (m *Manager) ExecuteCommand(sessionID string, command string) (string, error) {
	session, err := m.get(sessionID)
	if err != nil {
		return "", err
	}
	session.mu.RLock()
	client := session.client
	session.mu.RUnlock()
	if client == nil {
		return "", errors.New("SSH client not available")
	}
	sshSession, err := client.NewSession()
	if err != nil {
		return "", fmt.Errorf("failed to create SSH session: %w", err)
	}
	defer sshSession.Close()
	var stdout, stderr bytes.Buffer
	sshSession.Stdout = &stdout
	sshSession.Stderr = &stderr
	err = sshSession.Run(command)
	output := stdout.String()
	if stderrStr := stderr.String(); stderrStr != "" {
		if output != "" {
			output += "\n"
		}
		output += stderrStr
	}
	if err != nil {
		var exitErr *ssh.ExitError
		if errors.As(err, &exitErr) {
			if output != "" {
				output += "\n"
			}
			output += fmt.Sprintf("(exit code: %d)", exitErr.ExitStatus())
		} else {
			if output != "" {
				output += "\n"
			}
			output += "error: " + err.Error()
		}
	}
	return output, nil
}

func (m *Manager) remove(id string) {
	m.mu.Lock()
	delete(m.sessions, id)
	m.mu.Unlock()
}

func (m *Manager) failConnect(id string, err error, client *ssh.Client, conn net.Conn) {
	if client != nil {
		_ = client.Close()
	}
	if conn != nil {
		_ = conn.Close()
	}
	m.setError(id, err)
	m.remove(id)
}

func (m *Manager) setError(id string, err error) {
	m.mu.RLock()
	session := m.sessions[id]
	m.mu.RUnlock()
	if session != nil {
		session.mu.Lock()
		session.info.State = types.SessionError
		session.info.Error = err.Error()
		info := session.info
		session.mu.Unlock()
		m.emit("terminal:error", map[string]any{"sessionId": id, "error": err.Error()})
		m.emit("terminal:state", info)
	}
}

func clientConfig(profile types.Profile, timeoutSec int, knownHostsPath string, emit func(event string, data any), confirm func(host, fingerprint string) bool) (*ssh.ClientConfig, error) {
	var auth []ssh.AuthMethod
	switch profile.AuthType {
	case types.AuthPrivateKey:
		key, err := os.ReadFile(profile.PrivateKeyPath)
		if err != nil {
			return nil, err
		}
		var signer ssh.Signer
		if profile.PrivateKeyPassphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase(key, []byte(profile.PrivateKeyPassphrase))
		} else {
			signer, err = ssh.ParsePrivateKey(key)
		}
		if err != nil {
			return nil, err
		}
		auth = append(auth, ssh.PublicKeys(signer))
	default:
		auth = append(auth, ssh.Password(profile.Password))
	}
	return &ssh.ClientConfig{
		User:            profile.Username,
		Auth:            auth,
		HostKeyCallback: hostKeyCallback(profile, knownHostsPath, emit, confirm),
		Timeout:         time.Duration(timeoutSec) * time.Second,
		ClientVersion:   "SSH-2.0-gxShell",
	}, nil
}

func hostKeyCallback(profile types.Profile, knownHostsPath string, emit func(event string, data any), confirm func(host, fingerprint string) bool) ssh.HostKeyCallback {
	if err := os.MkdirAll(filepath.Dir(knownHostsPath), 0700); err != nil {
		return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
			return fmt.Errorf("cannot create known_hosts dir: %w", err)
		}
	}
	if err := ensureFile(knownHostsPath, 0600); err != nil {
		return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
			return fmt.Errorf("cannot create known_hosts file: %w", err)
		}
	}
	callback, err := knownhosts.New(knownHostsPath)
	if err != nil {
		return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
			return err
		}
	}
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		err := callback(hostname, remote, key)
		if err == nil {
			return nil
		}
		var keyErr *knownhosts.KeyError
		if errors.As(err, &keyErr) && len(keyErr.Want) == 0 {
			fingerprint := ssh.FingerprintSHA256(key)
			if confirm != nil && !confirm(hostname, fingerprint) {
				return errors.New("host key rejected by user")
			}
			hostPort := knownhosts.Normalize(fmt.Sprintf("%s:%d", profile.Host, profile.Port))
			line := knownhosts.Line([]string{hostPort}, key)
			if writeErr := appendKnownHost(knownHostsPath, line); writeErr != nil {
				return writeErr
			}
			if emit != nil {
				emit("security:hostkey:trusted", map[string]string{
					"host":        profile.Host,
					"fingerprint": ssh.FingerprintSHA256(key),
					"mode":        "trust-on-first-use",
				})
			}
			return nil
		}
		return err
	}
}

func ensureFile(path string, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND, mode)
	if err != nil {
		return err
	}
	return f.Close()
}

var knownHostsWriteMu sync.Mutex

func appendKnownHost(path string, line string) error {
	knownHostsWriteMu.Lock()
	defer knownHostsWriteMu.Unlock()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(line + "\n")
	return err
}

func panicHandler(sessionID string, m *Manager) {
	if r := recover(); r != nil {
		m.emit("terminal:error", map[string]any{
			"sessionId": sessionID,
			"error":     fmt.Sprintf("internal panic: %v", r),
		})
	}
}

func newSessionID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "sess-" + hex.EncodeToString(b)
}
