package sshmanager

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"gxShell/backend/termio"
	"gxShell/backend/types"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
	"golang.org/x/crypto/ssh/knownhosts"
)

type Manager struct {
	mu             sync.RWMutex
	sessions       map[string]*Session
	emit           func(event string, data any)
	knownHostsPath string
	confirm        func(host, fingerprint string) bool
	// onClosed runs after a session is fully torn down, on EVERY disconnect
	// path: user close, keepalive failure, shell exit, shutdown. The app wires
	// cross-subsystem cleanup (monitor, tunnels, SFTP cache, ping, AI tools)
	// here; without it a server-initiated drop leaks the monitor poller and
	// keeps tunnel listeners bound, so a later auto-reconnect cannot rebind its
	// tunnels (address already in use).
	onClosed func(sessionID string)
	// kiPrompt surfaces keyboard-interactive challenges (2FA / OTP prompts) to
	// the user mid-handshake. Nil means such challenges fail with an error.
	kiPrompt KeyboardInteractivePrompt
	// confirmHostKeyChange is asked when a server presents a DIFFERENT key than
	// the trusted one — possibly a reinstall, possibly an interception. Nil (or
	// answering false) rejects the connection; true replaces the stored key.
	confirmHostKeyChange func(host, oldFingerprint, newFingerprint string) bool
}

// KeyboardInteractivePrompt asks the user to answer server authentication
// prompts. echos[i] reports whether the user's answer to questions[i] may be
// shown in clear text.
type KeyboardInteractivePrompt func(sessionID, name, instruction string, questions []string, echos []bool) ([]string, error)

type Session struct {
	info       types.SessionInfo
	client     *ssh.Client
	jumpClient *ssh.Client
	shell      *ssh.Session
	stdin      io.WriteCloser
	done       chan struct{}
	closeOnce  sync.Once
	mu         sync.RWMutex
	recorder   *castRecorder
}

func NewManager(knownHostsPath string, emit func(event string, data any), confirm func(host, fingerprint string) bool) *Manager {
	return &Manager{
		sessions:       map[string]*Session{},
		emit:           emit,
		knownHostsPath: knownHostsPath,
		confirm:        confirm,
	}
}

// SetOnClosed registers the post-teardown callback. Must be set during app
// startup, before any session can connect.
func (m *Manager) SetOnClosed(fn func(sessionID string)) {
	m.onClosed = fn
}

// SetKeyboardInteractivePrompt registers the UI bridge for interactive auth
// challenges. Must be set during app startup, before any session can connect.
func (m *Manager) SetKeyboardInteractivePrompt(fn KeyboardInteractivePrompt) {
	m.kiPrompt = fn
}

// SetHostKeyChangeConfirm registers the UI bridge for the host-key-changed
// decision. Must be set during app startup, before any session can connect.
func (m *Manager) SetHostKeyChangeConfirm(fn func(host, oldFingerprint, newFingerprint string) bool) {
	m.confirmHostKeyChange = fn
}

const maxSessions = 20

func (m *Manager) Connect(profile types.Profile, timeoutSec int, cols int, rows int) (types.SessionInfo, error) {
	return m.ConnectViaJump(profile, types.Profile{}, timeoutSec, cols, rows)
}

func (m *Manager) ConnectViaJump(profile types.Profile, jumpProfile types.Profile, timeoutSec int, cols int, rows int) (types.SessionInfo, error) {
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

	config, closeAuth, err := m.clientConfig(profile, id, timeoutSec)
	defer closeAuth()
	if err != nil {
		m.failConnect(id, err, nil, nil, nil)
		return info, err
	}

	var client *ssh.Client
	var jumpClient *ssh.Client

	if jumpProfile.ID != "" {
		jumpConfig, closeJumpAuth, err := m.clientConfig(jumpProfile, id, timeoutSec)
		defer closeJumpAuth()
		if err != nil {
			m.failConnect(id, fmt.Errorf("jump host config error: %w", err), nil, nil, nil)
			return info, err
		}
		jumpAddr := sshAddress(jumpProfile.Host, jumpProfile.Port)
		jumpConn, err := net.DialTimeout("tcp", jumpAddr, time.Duration(timeoutSec)*time.Second)
		if err != nil {
			m.failConnect(id, fmt.Errorf("jump host connection failed: %w", err), nil, nil, nil)
			return info, err
		}
		jumpClientConn, chans, reqs, err := ssh.NewClientConn(jumpConn, jumpAddr, jumpConfig)
		if err != nil {
			_ = jumpConn.Close()
			m.failConnect(id, fmt.Errorf("jump host SSH handshake failed: %w", err), nil, nil, nil)
			return info, err
		}
		jumpClient = ssh.NewClient(jumpClientConn, chans, reqs)

		targetAddr := sshAddress(profile.Host, profile.Port)
		dialCtx, dialCancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
		targetConn, err := jumpClient.DialContext(dialCtx, "tcp", targetAddr)
		if err != nil {
			dialCancel()
			m.failConnect(id, fmt.Errorf("jump host cannot reach target %s: %w", targetAddr, err), nil, jumpClient, nil)
			return info, err
		}
		targetClientConn, chans, reqs, err := ssh.NewClientConn(targetConn, targetAddr, config)
		dialCancel()
		if err != nil {
			_ = targetConn.Close()
			m.failConnect(id, fmt.Errorf("target SSH handshake via jump failed: %w", err), nil, jumpClient, nil)
			return info, err
		}
		client = ssh.NewClient(targetClientConn, chans, reqs)
	} else {
		addr := sshAddress(profile.Host, profile.Port)
		conn, err := net.DialTimeout("tcp", addr, time.Duration(timeoutSec)*time.Second)
		if err != nil {
			m.failConnect(id, err, nil, nil, nil)
			return info, err
		}
		clientConn, chans, reqs, err := ssh.NewClientConn(conn, addr, config)
		if err != nil {
			m.failConnect(id, err, nil, nil, conn)
			return info, err
		}
		client = ssh.NewClient(clientConn, chans, reqs)
	}
	shell, err := client.NewSession()
	if err != nil {
		m.failConnect(id, err, client, jumpClient, nil)
		return info, err
	}

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := shell.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		_ = shell.Close()
		m.failConnect(id, err, client, jumpClient, nil)
		return info, err
	}

	stdin, err := shell.StdinPipe()
	if err != nil {
		_ = shell.Close()
		m.failConnect(id, err, client, jumpClient, nil)
		return info, err
	}
	stdout, err := shell.StdoutPipe()
	if err != nil {
		_ = shell.Close()
		m.failConnect(id, err, client, jumpClient, nil)
		return info, err
	}
	stderr, err := shell.StderrPipe()
	if err != nil {
		_ = shell.Close()
		m.failConnect(id, err, client, jumpClient, nil)
		return info, err
	}
	if err := shell.Shell(); err != nil {
		_ = shell.Close()
		m.failConnect(id, err, client, jumpClient, nil)
		return info, err
	}

	session.mu.Lock()
	select {
	case <-session.done:
		// Disconnect/Shutdown removed this session while the handshake was still
		// in flight. closeOnce already ran with every field nil, so nothing else
		// will ever close what we just opened — close it here, or the TCP
		// connection and remote shell leak with no code path left to reach them.
		session.mu.Unlock()
		_ = shell.Close()
		_ = client.Close()
		if jumpClient != nil {
			_ = jumpClient.Close()
		}
		return info, errors.New("connection cancelled")
	default:
	}
	session.client = client
	session.jumpClient = jumpClient
	session.shell = shell
	session.stdin = stdin
	session.info.State = types.SessionConnected
	info = session.info
	session.mu.Unlock()
	m.emit("terminal:connected", info)

	go m.forwardOutput(id, stdout)
	go m.forwardOutput(id, stderr)
	go m.keepalive(id)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				m.emit("terminal:error", map[string]any{
					"sessionId": id,
					"error":     fmt.Sprintf("internal panic: %v", r),
				})
				m.Disconnect(id)
			}
		}()
		err := shell.Wait()
		if err != nil && !isBenignShellWaitError(err) {
			m.emit("terminal:error", map[string]any{"sessionId": id, "error": err.Error()})
		}
		m.Disconnect(id)
	}()

	return info, nil
}

// forwardOutput streams one output pipe (stdout or stderr) to the frontend and
// the recorder. termio.Pump batches the raw reads (16ms/32KB) and re-splits
// them on UTF-8 rune boundaries, so high-throughput output does not flood the
// IPC bridge and CJK/emoji never straddle a chunk as invalid UTF-8.
func (m *Manager) forwardOutput(id string, reader io.Reader) {
	defer panicHandler(id, m)
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
		session.mu.RLock()
		rec := session.recorder
		session.mu.RUnlock()
		if rec != nil {
			rec.writeOutput(chunk)
		}
	})
}

// keepalive probes the connection with want-reply global requests — the same
// semantics as OpenSSH's ServerAliveInterval. The want-reply flag is what makes
// it a real liveness probe: on a silently dead link (NAT timeout, pulled cable,
// sleep/resume) a fire-and-forget request just sits in the kernel send buffer
// and never errors, while a missing reply here is detected within replyTimeout.
func (m *Manager) keepalive(id string) {
	defer panicHandler(id, m)
	const interval = 30 * time.Second
	const replyTimeout = 15 * time.Second
	m.mu.RLock()
	session := m.sessions[id]
	m.mu.RUnlock()
	if session == nil {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-session.done:
			return
		case <-ticker.C:
		}
		session.mu.RLock()
		client := session.client
		session.mu.RUnlock()
		if client == nil {
			return
		}
		replied := make(chan error, 1)
		go func() {
			// Servers answer an unknown global request with REQUEST_FAILURE, which
			// still counts as a reply; only a transport error means the link died.
			_, _, err := client.SendRequest("keepalive@openssh.com", true, nil)
			replied <- err
		}()
		select {
		case err := <-replied:
			if err != nil {
				m.emit("terminal:error", map[string]any{"sessionId": id, "error": "connection lost (keepalive failed)"})
				go m.Disconnect(id)
				return
			}
		case <-time.After(replyTimeout):
			// Disconnect closes the transport, which unblocks the probe goroutine.
			m.emit("terminal:error", map[string]any{"sessionId": id, "error": "connection lost (keepalive timeout)"})
			go m.Disconnect(id)
			return
		case <-session.done:
			return
		}
	}
}

func (m *Manager) Write(id string, data string) error {
	session, err := m.get(id)
	if err != nil {
		return err
	}
	// Copy the pipe under the lock but write outside it: an SSH channel write
	// blocks indefinitely when the remote stops draining its window, and if that
	// happened while holding the lock, Disconnect could never acquire it to run
	// client.Close() — the only call that unblocks the stuck writer.
	session.mu.RLock()
	stdin := session.stdin
	session.mu.RUnlock()
	if stdin == nil {
		return errors.New("terminal is not writable")
	}
	_, err = stdin.Write([]byte(data))
	return err
}

func (m *Manager) Resize(id string, cols int, rows int) error {
	session, err := m.get(id)
	if err != nil {
		return err
	}
	session.mu.Lock()
	shell := session.shell
	if shell == nil {
		session.mu.Unlock()
		return errors.New("terminal session is not ready")
	}
	session.info.Cols = cols
	session.info.Rows = rows
	rec := session.recorder
	session.mu.Unlock()
	// Network I/O stays outside the lock; see Write.
	if err := shell.WindowChange(rows, cols); err != nil {
		return err
	}
	if rec != nil {
		rec.writeResize(cols, rows)
	}
	return nil
}

// StartRecording begins recording the session's terminal output to a .cast file
// at path. It taps only stdout/stderr, not stdin. Shell-echoed commands are part
// of terminal output, while password prompts with echo disabled are not captured.
// Returns an error if the session is missing or already recording. The current
// terminal size seeds the .cast header.
func (m *Manager) StartRecording(id, path, title string) error {
	session, err := m.get(id)
	if err != nil {
		return err
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.recorder != nil {
		return recordingError("session is already recording")
	}
	cols, rows := session.info.Cols, session.info.Rows
	rec, err := newCastRecorder(path, title, cols, rows)
	if err != nil {
		return err
	}
	session.recorder = rec
	return nil
}

// StopRecording finalizes the recording and returns the file path. Returns an
// error if the session is missing or was not recording.
func (m *Manager) StopRecording(id string) (string, error) {
	session, err := m.get(id)
	if err != nil {
		return "", err
	}
	session.mu.Lock()
	rec := session.recorder
	session.recorder = nil
	session.mu.Unlock()
	if rec == nil {
		return "", recordingError("session is not recording")
	}
	path := rec.filePath()
	if err := rec.close(); err != nil {
		return path, err
	}
	return path, nil
}

// IsRecording reports whether the session is currently recording.
func (m *Manager) IsRecording(id string) bool {
	session, err := m.get(id)
	if err != nil {
		return false
	}
	session.mu.RLock()
	defer session.mu.RUnlock()
	return session.recorder != nil
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

	var recCloseErr error
	session.closeOnce.Do(func() {
		session.mu.Lock()
		stdin := session.stdin
		shell := session.shell
		client := session.client
		jumpClient := session.jumpClient
		// Take the recorder under the lock but flush/close it after unlocking:
		// most disconnects (shell.Wait returning, keepalive failure, user close)
		// go through here rather than StopRecording, so without this an in-progress
		// recording would leak its file handle and lose its final buffered output.
		rec := session.recorder
		session.recorder = nil
		close(session.done)
		if session.info.State != types.SessionError {
			session.info.State = types.SessionDisconnected
		}
		info := session.info
		session.mu.Unlock()

		// Close the transport first: client.Close() tears down the TCP socket
		// without writing any SSH message, which unblocks channel writers stuck
		// on a dead link. Closing shell/stdin first would try to SEND close/EOF
		// messages over that same dead link and could block forever.
		if client != nil {
			_ = client.Close()
		}
		if jumpClient != nil {
			_ = jumpClient.Close()
		}
		if shell != nil {
			_ = shell.Close()
		}
		if stdin != nil {
			_ = stdin.Close()
		}
		if rec != nil {
			if err := rec.close(); err != nil {
				recCloseErr = err
				m.emit("recording:error", map[string]any{
					"sessionId": id,
					"error":     "failed to finalize recording: " + err.Error(),
				})
			}
		}
		m.emit("terminal:disconnected", info)
		if m.onClosed != nil {
			m.onClosed(id)
		}
	})
	return recCloseErr
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

type CommandExecutionResult struct {
	Stdout    string
	Stderr    string
	Output    string
	Summary   string
	ExitCode  int
	TimedOut  bool
	Truncated bool
	Duration  time.Duration
	Error     string
}

func (r CommandExecutionResult) DisplayOutput() string {
	return appendLine(r.Output, r.Summary)
}

func (m *Manager) ExecuteCommand(sessionID string, command string, timeout time.Duration, maxOutput int64) (string, error) {
	result, err := m.ExecuteCommandResult(sessionID, command, timeout, maxOutput)
	return result.DisplayOutput(), err
}

func (m *Manager) ExecuteCommandResult(sessionID string, command string, timeout time.Duration, maxOutput int64) (CommandExecutionResult, error) {
	var result CommandExecutionResult
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	session, err := m.get(sessionID)
	if err != nil {
		return result, err
	}
	session.mu.RLock()
	client := session.client
	session.mu.RUnlock()
	if client == nil {
		return result, errors.New("SSH client not available")
	}
	sshSession, err := client.NewSession()
	if err != nil {
		return result, fmt.Errorf("failed to create SSH session: %w", err)
	}
	defer sshSession.Close()
	stdout := newLimitedBuffer(maxOutput)
	stderr := newLimitedBuffer(maxOutput)
	sshSession.Stdout = stdout
	sshSession.Stderr = stderr

	started := time.Now()
	done := make(chan error, 1)
	go func() {
		done <- sshSession.Run(command)
	}()

	select {
	case err = <-done:
	case <-time.After(timeout):
		_ = sshSession.Close()
		err = errors.New("remote command timeout")
		result.TimedOut = true
		result.ExitCode = 124
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	}
	result.Duration = time.Since(started)

	stdoutStr := stdout.String()
	stderrStr := stderr.String()
	result.Stdout = stdoutStr
	result.Stderr = stderrStr

	output := stdoutStr
	if stderrStr != "" {
		output = appendLine(output, stderrStr)
	}
	if err != nil {
		var exitErr *ssh.ExitError
		if errors.As(err, &exitErr) {
			result.ExitCode = exitErr.ExitStatus()
			result.Summary = appendLine(result.Summary, fmt.Sprintf("(exit code: %d)", result.ExitCode))
		} else {
			if result.ExitCode == 0 {
				result.ExitCode = 1
			}
			result.Error = err.Error()
			result.Summary = appendLine(result.Summary, "error: "+err.Error())
		}
	}
	if stdout.Truncated() || stderr.Truncated() {
		result.Truncated = true
		result.Summary = appendLine(result.Summary, fmt.Sprintf("(output truncated after %d bytes)", maxOutput))
	}
	result.Output = output
	return result, nil
}

func isBenignShellWaitError(err error) bool {
	if err == nil || errors.Is(err, io.EOF) {
		return true
	}
	var missing *ssh.ExitMissingError
	if errors.As(err, &missing) {
		return true
	}
	return strings.Contains(err.Error(), "remote command exited without exit status or exit signal")
}

func (m *Manager) remove(id string) {
	m.mu.Lock()
	delete(m.sessions, id)
	m.mu.Unlock()
}

func (m *Manager) failConnect(id string, err error, client *ssh.Client, jumpClient *ssh.Client, conn net.Conn) {
	if client != nil {
		_ = client.Close()
	}
	if jumpClient != nil {
		_ = jumpClient.Close()
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

// clientConfig assembles the auth methods and host-key policy for a profile.
// The returned cleanup func must be called once the handshake is over (either
// way); it closes the SSH agent connection, which has to stay open while the
// handshake signs with agent-held keys. sessionID routes keyboard-interactive
// prompts to the right UI surface.
func (m *Manager) clientConfig(profile types.Profile, sessionID string, timeoutSec int) (*ssh.ClientConfig, func(), error) {
	cleanup := func() {}
	var auth []ssh.AuthMethod
	switch profile.AuthType {
	case types.AuthPrivateKey:
		key, err := os.ReadFile(profile.PrivateKeyPath)
		if err != nil {
			return nil, cleanup, err
		}
		var signer ssh.Signer
		if profile.PrivateKeyPassphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase(key, []byte(profile.PrivateKeyPassphrase))
		} else {
			signer, err = ssh.ParsePrivateKey(key)
		}
		if err != nil {
			return nil, cleanup, err
		}
		auth = append(auth, ssh.PublicKeys(signer))
	case types.AuthAgent:
		conn, err := dialAgent()
		if err != nil {
			return nil, cleanup, err
		}
		agentClient := agent.NewClient(conn)
		signers, err := agentClient.Signers()
		if err != nil {
			_ = conn.Close()
			return nil, cleanup, fmt.Errorf("SSH agent: %w", err)
		}
		if len(signers) == 0 {
			_ = conn.Close()
			return nil, cleanup, errors.New("SSH agent holds no keys (ssh-add a key first)")
		}
		// Signing happens over this connection during the handshake, so it is
		// closed by the caller afterwards, not here.
		cleanup = func() { _ = conn.Close() }
		auth = append(auth, ssh.PublicKeysCallback(agentClient.Signers))
	default:
		auth = append(auth, ssh.Password(profile.Password))
	}
	// keyboard-interactive is offered for every auth type: hardened servers
	// often disable plain password auth in favour of PAM keyboard-interactive,
	// and 2FA/OTP servers require it on top of key auth.
	auth = append(auth, ssh.KeyboardInteractive(m.kiChallenge(sessionID, profile.Password)))
	return &ssh.ClientConfig{
		User:            profile.Username,
		Auth:            auth,
		HostKeyCallback: m.hostKeyCallback(profile),
		Timeout:         time.Duration(timeoutSec) * time.Second,
		ClientVersion:   "SSH-2.0-gxShell",
	}, cleanup, nil
}

// kiChallenge answers keyboard-interactive rounds. A single hidden
// password-looking prompt is answered with the stored password automatically
// (PAM password-over-KI, so the user is not re-prompted for a secret the app
// already holds); everything else — OTP codes, multi-prompt 2FA — goes to the
// user through the registered prompt bridge.
func (m *Manager) kiChallenge(sessionID string, password string) ssh.KeyboardInteractiveChallenge {
	return func(name, instruction string, questions []string, echos []bool) ([]string, error) {
		if len(questions) == 0 {
			return []string{}, nil
		}
		if password != "" && len(questions) == 1 && len(echos) == 1 && !echos[0] && looksLikePasswordPrompt(questions[0]) {
			return []string{password}, nil
		}
		if m.kiPrompt == nil {
			return nil, errors.New("server requires interactive authentication")
		}
		return m.kiPrompt(sessionID, name, instruction, questions, echos)
	}
}

func looksLikePasswordPrompt(q string) bool {
	q = strings.ToLower(q)
	return strings.Contains(q, "password") || strings.Contains(q, "密码")
}

func (m *Manager) hostKeyCallback(profile types.Profile) ssh.HostKeyCallback {
	knownHostsPath, emit, confirm := m.knownHostsPath, m.emit, m.confirm
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
		if !errors.As(err, &keyErr) {
			return err
		}
		fingerprint := ssh.FingerprintSHA256(key)
		hostPort := knownhosts.Normalize(sshAddress(profile.Host, profile.Port))
		if len(keyErr.Want) == 0 {
			// Unknown host: trust-on-first-use after native confirmation.
			if confirm != nil && !confirm(hostname, fingerprint) {
				return errors.New("host key rejected by user")
			}
			line := knownhosts.Line([]string{hostPort}, key)
			if writeErr := appendKnownHost(knownHostsPath, line); writeErr != nil {
				return writeErr
			}
			if emit != nil {
				emit("security:hostkey:trusted", map[string]string{
					"host":        profile.Host,
					"fingerprint": fingerprint,
					"mode":        "trust-on-first-use",
				})
			}
			return nil
		}
		// Known host presenting a DIFFERENT key: reinstall or interception.
		// Surface both fingerprints and let the user decide instead of dumping
		// the raw knownhosts mismatch error.
		oldFingerprint := fingerprintOfWanted(keyErr)
		if m.confirmHostKeyChange == nil || !m.confirmHostKeyChange(hostname, oldFingerprint, fingerprint) {
			return fmt.Errorf("host key for %s has changed and was not accepted (stored %s, server now presents %s)", hostname, oldFingerprint, fingerprint)
		}
		line := knownhosts.Line([]string{hostPort}, key)
		if writeErr := replaceKnownHost(knownHostsPath, hostPort, line); writeErr != nil {
			return writeErr
		}
		if emit != nil {
			emit("security:hostkey:changed", map[string]string{
				"host":           profile.Host,
				"fingerprint":    fingerprint,
				"oldFingerprint": oldFingerprint,
				"mode":           "user-accepted-change",
			})
		}
		return nil
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

func sshAddress(host string, port int) string {
	return net.JoinHostPort(host, strconv.Itoa(port))
}

func appendLine(base string, line string) string {
	if line == "" {
		return base
	}
	if base == "" {
		return line
	}
	return base + "\n" + line
}

type limitedBuffer struct {
	bytes.Buffer
	limit     int
	truncated bool
}

func newLimitedBuffer(limit int64) *limitedBuffer {
	if limit <= 0 || limit > int64(int(^uint(0)>>1)) {
		limit = int64(int(^uint(0) >> 1))
	}
	return &limitedBuffer{limit: int(limit)}
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	remaining := b.limit - b.Len()
	if remaining <= 0 {
		b.truncated = true
		return len(p), nil
	}
	if len(p) > remaining {
		_, _ = b.Buffer.Write(p[:remaining])
		b.truncated = true
		return len(p), nil
	}
	_, err := b.Buffer.Write(p)
	return len(p), err
}

func (b *limitedBuffer) Truncated() bool {
	return b.truncated
}

func panicHandler(sessionID string, m *Manager) {
	if r := recover(); r != nil {
		m.emit("terminal:error", map[string]any{
			"sessionId": sessionID,
			"error":     fmt.Sprintf("internal panic: %v", r),
		})
		m.Disconnect(sessionID)
	}
}

func newSessionID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "sess-" + hex.EncodeToString(b)
}
