package tunnel

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"gxShell/backend/types"

	"golang.org/x/crypto/ssh"
)

type Manager struct {
	mu     sync.Mutex
	active map[string][]*forward
	emit   func(event string, data any)
}

type forward struct {
	rule     types.TunnelRule
	listener net.Listener
	done     chan struct{}
	// dead flips when serve exits on its own (listener broken, SSH client
	// gone) so ListStatus stops reporting a forward that no longer accepts
	// connections as active. Atomic because serve cannot take m.mu: StopTunnels
	// holds it while waiting on done.
	dead atomic.Bool
}

func NewManager(emit func(event string, data any)) *Manager {
	return &Manager{
		active: map[string][]*forward{},
		emit:   emit,
	}
}

func (m *Manager) StartTunnels(sessionID string, client *ssh.Client, rules []types.TunnelRule) []types.TunnelStatus {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.stopAllLocked(sessionID)

	var statuses []types.TunnelStatus
	for _, rule := range rules {
		status := types.TunnelStatus{Rule: rule}
		fwd, err := m.startOne(client, rule)
		if err != nil {
			status.Error = err.Error()
			m.emit("tunnel:error", map[string]any{"sessionId": sessionID, "ruleId": rule.ID, "error": err.Error()})
		} else {
			status.Active = true
			status.Rule = fwd.rule
			fwd.done = make(chan struct{})
			m.active[sessionID] = append(m.active[sessionID], fwd)
			go m.serve(sessionID, fwd, client)
			m.emit("tunnel:started", map[string]any{"sessionId": sessionID, "ruleId": rule.ID})
		}
		statuses = append(statuses, status)
	}
	return statuses
}

func (m *Manager) startOne(client *ssh.Client, rule types.TunnelRule) (*forward, error) {
	switch rule.Type {
	case types.TunnelLocal:
		addr := resolveAddr(rule.Local, rule.BindHost, "127.0.0.1")
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("local listen failed: %w", err)
		}
		rule.Local = ln.Addr().String()
		return &forward{rule: rule, listener: ln}, nil

	case types.TunnelRemote:
		// Default to loopback on the remote host. Binding 0.0.0.0 would expose the
		// forwarded port on every interface of the remote server; require the user
		// to set BindHost explicitly to opt into a non-loopback bind.
		addr := resolveAddr(rule.Remote, rule.BindHost, "127.0.0.1")
		ln, err := client.Listen("tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("remote listen failed: %w", err)
		}
		rule.Remote = ln.Addr().String()
		return &forward{rule: rule, listener: ln}, nil

	case types.TunnelDynamic:
		addr := resolveAddr(rule.Local, rule.BindHost, "127.0.0.1")
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("dynamic listen failed: %w", err)
		}
		rule.Local = ln.Addr().String()
		return &forward{rule: rule, listener: ln}, nil

	default:
		return nil, fmt.Errorf("unknown tunnel type: %s", rule.Type)
	}
}

func resolveAddr(addr, bindHost, defaultHost string) string {
	if strings.Contains(addr, ":") {
		return addr
	}
	host := bindHost
	if host == "" {
		host = defaultHost
	}
	return fmt.Sprintf("%s:%s", host, addr)
}

func resolveDialAddr(addr, defaultHost string) string {
	if strings.Contains(addr, ":") {
		return addr
	}
	return fmt.Sprintf("%s:%s", defaultHost, addr)
}

func (m *Manager) serve(sessionID string, fwd *forward, client *ssh.Client) {
	defer close(fwd.done)
	defer fwd.dead.Store(true)
	for {
		conn, err := fwd.listener.Accept()
		if err != nil {
			return
		}
		go m.handleConn(sessionID, fwd, client, conn)
	}
}

func (m *Manager) handleConn(sessionID string, fwd *forward, client *ssh.Client, localConn net.Conn) {
	defer localConn.Close()

	switch fwd.rule.Type {
	case types.TunnelLocal:
		remoteAddr := resolveDialAddr(fwd.rule.Remote, "127.0.0.1")
		remoteConn, err := client.Dial("tcp", remoteAddr)
		if err != nil {
			m.emit("tunnel:error", map[string]any{"sessionId": sessionID, "ruleId": fwd.rule.ID, "error": err.Error()})
			return
		}
		defer remoteConn.Close()
		relay(localConn, remoteConn)

	case types.TunnelRemote:
		remoteAddr := resolveDialAddr(fwd.rule.Local, "127.0.0.1")
		remoteConn, err := net.Dial("tcp", remoteAddr)
		if err != nil {
			m.emit("tunnel:error", map[string]any{"sessionId": sessionID, "ruleId": fwd.rule.ID, "error": err.Error()})
			return
		}
		defer remoteConn.Close()
		relay(localConn, remoteConn)

	case types.TunnelDynamic:
		m.handleSOCKS(sessionID, fwd, client, localConn)
	}
}

// handleSOCKS speaks the SOCKS5 CONNECT handshake and relays the connection
// through the SSH client.
func (m *Manager) handleSOCKS(sessionID string, fwd *forward, client *ssh.Client, conn net.Conn) {
	target, ok := negotiateSOCKS(conn)
	if !ok {
		return
	}

	remoteConn, err := client.Dial("tcp", target)
	if err != nil {
		_, _ = conn.Write([]byte{0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	defer remoteConn.Close()

	if _, err := conn.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0}); err != nil {
		return
	}
	relay(conn, remoteConn)
}

// negotiateSOCKS reads the SOCKS5 greeting and CONNECT request and returns the
// dial target. Each protocol element is read with io.ReadFull at its exact
// wire length: a single conn.Read may return a TCP segment that splits the
// greeting or request, which must not fail the handshake. The deadline bounds
// how long a silent client can pin this goroutine.
func negotiateSOCKS(conn net.Conn) (string, bool) {
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))

	// Greeting: VER NMETHODS METHODS...
	head := make([]byte, 2)
	if _, err := io.ReadFull(conn, head); err != nil || head[0] != 0x05 {
		return "", false
	}
	methods := make([]byte, int(head[1]))
	if _, err := io.ReadFull(conn, methods); err != nil {
		return "", false
	}
	if _, err := conn.Write([]byte{0x05, 0x00}); err != nil {
		return "", false
	}

	// Request: VER CMD RSV ATYP DST.ADDR DST.PORT
	req := make([]byte, 4)
	if _, err := io.ReadFull(conn, req); err != nil || req[0] != 0x05 {
		return "", false
	}
	if req[1] != 0x01 { // only CONNECT
		_, _ = conn.Write([]byte{0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return "", false
	}

	var host string
	switch req[3] {
	case 0x01: // IPv4
		addr := make([]byte, 4)
		if _, err := io.ReadFull(conn, addr); err != nil {
			return "", false
		}
		host = net.IP(addr).String()
	case 0x03: // domain
		lenByte := make([]byte, 1)
		if _, err := io.ReadFull(conn, lenByte); err != nil {
			return "", false
		}
		name := make([]byte, int(lenByte[0]))
		if _, err := io.ReadFull(conn, name); err != nil {
			return "", false
		}
		host = string(name)
	case 0x04: // IPv6
		addr := make([]byte, 16)
		if _, err := io.ReadFull(conn, addr); err != nil {
			return "", false
		}
		host = net.IP(addr).String()
	default:
		_, _ = conn.Write([]byte{0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return "", false
	}

	portBytes := make([]byte, 2)
	if _, err := io.ReadFull(conn, portBytes); err != nil {
		return "", false
	}
	port := binary.BigEndian.Uint16(portBytes)

	// Handshake complete; the relay itself has no deadline.
	_ = conn.SetReadDeadline(time.Time{})
	return net.JoinHostPort(host, fmt.Sprintf("%d", port)), true
}

func relay(a, b net.Conn) {
	// Either endpoint may be an SSH channel (not *net.TCPConn), so we cannot rely
	// on CloseWrite for half-close signalling. Instead, when either copy direction
	// finishes we force-close both connections exactly once. This unblocks the
	// peer's Read so the other goroutine returns, preventing goroutine/socket
	// leaks for connections closed from the SSH side first.
	var once sync.Once
	closeBoth := func() {
		once.Do(func() {
			_ = a.Close()
			_ = b.Close()
		})
	}
	done := make(chan struct{}, 2)
	cp := func(dst, src net.Conn) {
		defer func() { done <- struct{}{} }()
		buf := make([]byte, 32*1024)
		for {
			n, err := src.Read(buf)
			if n > 0 {
				if _, werr := dst.Write(buf[:n]); werr != nil {
					closeBoth()
					return
				}
			}
			if err != nil {
				closeBoth()
				return
			}
		}
	}
	go cp(a, b)
	go cp(b, a)
	<-done
	<-done
}

func (m *Manager) StopTunnels(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopAllLocked(sessionID)
}

func (m *Manager) stopAllLocked(sessionID string) {
	fwds := m.active[sessionID]
	for _, fwd := range fwds {
		if fwd.listener != nil {
			_ = fwd.listener.Close()
		}
		if fwd.done != nil {
			<-fwd.done
		}
		m.emit("tunnel:stopped", map[string]any{"sessionId": sessionID, "ruleId": fwd.rule.ID})
	}
	delete(m.active, sessionID)
}

func (m *Manager) ListStatus(sessionID string) []types.TunnelStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	fwds := m.active[sessionID]
	statuses := make([]types.TunnelStatus, 0, len(fwds))
	for _, fwd := range fwds {
		status := types.TunnelStatus{
			Rule:   fwd.rule,
			Active: !fwd.dead.Load(),
		}
		if fwd.dead.Load() {
			status.Error = "forward stopped (listener closed or connection lost)"
		}
		statuses = append(statuses, status)
	}
	return statuses
}

func (m *Manager) AddTunnel(sessionID string, client *ssh.Client, rule types.TunnelRule) types.TunnelStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	status := types.TunnelStatus{Rule: rule}
	fwd, err := m.startOne(client, rule)
	if err != nil {
		status.Error = err.Error()
		m.emit("tunnel:error", map[string]any{"sessionId": sessionID, "ruleId": rule.ID, "error": err.Error()})
		return status
	}
	status.Active = true
	status.Rule = fwd.rule
	fwd.done = make(chan struct{})
	m.active[sessionID] = append(m.active[sessionID], fwd)
	go m.serve(sessionID, fwd, client)
	m.emit("tunnel:started", map[string]any{"sessionId": sessionID, "ruleId": rule.ID})
	return status
}

func (m *Manager) RemoveTunnel(sessionID string, ruleID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	fwds := m.active[sessionID]
	for i, fwd := range fwds {
		if fwd.rule.ID == ruleID {
			if fwd.listener != nil {
				_ = fwd.listener.Close()
			}
			if fwd.done != nil {
				<-fwd.done
			}
			m.active[sessionID] = append(fwds[:i], fwds[i+1:]...)
			m.emit("tunnel:stopped", map[string]any{"sessionId": sessionID, "ruleId": ruleID})
			return
		}
	}
}
