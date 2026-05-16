package tunnel

import (
	"fmt"
	"net"
	"strings"
	"sync"

	"gxShell/backend/types"

	"golang.org/x/crypto/ssh"
)

type Manager struct {
	mu      sync.Mutex
	active  map[string][]*forward
	emit    func(event string, data any)
}

type forward struct {
	rule    types.TunnelRule
	listener net.Listener
	done    chan struct{}
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
		return &forward{rule: rule, listener: ln}, nil

	case types.TunnelRemote:
		addr := resolveAddr(rule.Remote, rule.BindHost, "0.0.0.0")
		ln, err := client.Listen("tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("remote listen failed: %w", err)
		}
		return &forward{rule: rule, listener: ln}, nil

	case types.TunnelDynamic:
		addr := resolveAddr(rule.Local, rule.BindHost, "127.0.0.1")
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("dynamic listen failed: %w", err)
		}
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

func (m *Manager) handleSOCKS(sessionID string, fwd *forward, client *ssh.Client, conn net.Conn) {
	buf := make([]byte, 262)
	n, err := conn.Read(buf)
	if err != nil || n < 3 {
		return
	}
	if buf[0] != 0x05 {
		return
	}
	conn.Write([]byte{0x05, 0x00})

	n, err = conn.Read(buf)
	if err != nil || n < 7 {
		return
	}
	if buf[0] != 0x05 || buf[1] != 0x01 {
		conn.Write([]byte{0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}

	var host string
	var portIdx int
	switch buf[3] {
	case 0x01:
		if n < 10 {
			return
		}
		host = fmt.Sprintf("%d.%d.%d.%d", buf[4], buf[5], buf[6], buf[7])
		portIdx = 8
	case 0x03:
		hostLen := int(buf[4])
		if n < 5+hostLen+2 {
			return
		}
		host = string(buf[5 : 5+hostLen])
		portIdx = 5 + hostLen
	case 0x04:
		conn.Write([]byte{0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	default:
		return
	}

	if portIdx+2 > n {
		return
	}
	port := uint16(buf[portIdx])<<8 | uint16(buf[portIdx+1])
	target := fmt.Sprintf("%s:%d", host, port)

	remoteConn, err := client.Dial("tcp", target)
	if err != nil {
		conn.Write([]byte{0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	defer remoteConn.Close()

	conn.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
	relay(conn, remoteConn)
}

func relay(a, b net.Conn) {
	done := make(chan struct{}, 2)
	copy := func(dst, src net.Conn) {
		defer func() { done <- struct{}{} }()
		buf := make([]byte, 32*1024)
		for {
			n, err := src.Read(buf)
			if n > 0 {
				_, werr := dst.Write(buf[:n])
				if werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}
	go copy(a, b)
	go copy(b, a)
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
		statuses = append(statuses, types.TunnelStatus{
			Rule:   fwd.rule,
			Active: true,
		})
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
