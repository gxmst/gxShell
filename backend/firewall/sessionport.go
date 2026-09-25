package firewall

import (
	"strconv"
	"strings"
	"time"
)

// sshConnectionProbe asks sshd for the connection tuple it exports into every
// session's environment. printf is used so an unset variable yields an empty
// line with a success status, which keeps "no value" distinguishable from "the
// channel is broken".
const sshConnectionProbe = `printf '%s\n' "$SSH_CONNECTION"`

// defaultSSHPort is assumed when the server-side port cannot be read.
const defaultSSHPort = 22

// maxPortCacheEntries bounds the per-session port cache the same way
// maxRootCacheEntries bounds the root cache.
const maxPortCacheEntries = 64

// sshPorts describes where this session's SSH connection actually terminates.
//
// The two ports differ exactly when the client reaches the host through a
// forward: the profile stores the public port (20022) while sshd listens on
// the internal one (22). Firewall decisions must be made against Server,
// because that is the port a rule has to keep open for the session to survive.
// The mistake is silent at first — conntrack keeps the established connection
// alive — and only becomes a lockout once the entry expires.
type sshPorts struct {
	// Server is the port sshd accepted this connection on. Zero when it could
	// not be determined.
	Server int
	// Dial is the port the client dialled, as recorded in the profile.
	Dial int
}

// guardPorts returns every port a dangerous rule could cover. Over-reporting
// costs one extra force confirmation, so both known ports are included, and
// when the server-side port could not be read the conventional one is added as
// well: `deny 22` behind an unprobed forward is exactly the lockout this guard
// exists to catch.
func (p sshPorts) guardPorts() []int {
	ports := []int{}
	if p.Server > 0 {
		ports = append(ports, p.Server)
	}
	if p.Dial > 0 && p.Dial != p.Server {
		ports = append(ports, p.Dial)
	}
	if p.Server == 0 {
		ports = append(ports, defaultSSHPort)
	}
	return dedupePorts(ports)
}

// keepOpenPorts returns the ports to allow before switching a default-deny
// firewall on. Server is authoritative, so it is the only one allowed in the
// normal case: on a NAT'd host the dialled port is the public one and allowing
// it here would open whatever unrelated service owns that port internally.
// When Server is unknown both candidates are kept open, because a lockout is
// worse than one extra rule.
func (p sshPorts) keepOpenPorts() []int {
	if p.Server > 0 {
		return []int{p.Server}
	}
	return dedupePorts([]int{p.Dial, defaultSSHPort})
}

// dedupePorts drops unusable entries and repeats while preserving order, so
// the first element stays the most trustworthy candidate.
func dedupePorts(ports []int) []int {
	out := make([]int, 0, len(ports))
	seen := make(map[int]bool, len(ports))
	for _, port := range ports {
		if port < 1 || port > 65535 || seen[port] {
			continue
		}
		seen[port] = true
		out = append(out, port)
	}
	return out
}

// sshSessionPorts probes where this session's SSH connection terminates. The
// answer cannot change for the life of a connection, so a successful probe is
// cached per session; a failed one is retried on the next call rather than
// pinned for the session's lifetime.
func (m *Manager) sshSessionPorts(sessionID string) sshPorts {
	m.portMu.Lock()
	cached, ok := m.portCache[sessionID]
	m.portMu.Unlock()
	if ok {
		return cached
	}
	ports := sshPorts{}
	if dial, err := m.ssh.SessionPort(sessionID); err == nil && dial > 0 {
		ports.Dial = dial
	}
	if out, err := m.ssh.Exec(sessionID, sshConnectionProbe, 10*time.Second); err == nil {
		ports.Server = parseSSHConnectionPort(out)
	}
	if ports.Server > 0 {
		m.portMu.Lock()
		if len(m.portCache) >= maxPortCacheEntries {
			m.portCache = make(map[string]sshPorts)
		}
		m.portCache[sessionID] = ports
		m.portMu.Unlock()
	}
	return ports
}

// parseSSHConnectionPort reads the server-side port out of $SSH_CONNECTION,
// which sshd formats as "client_ip client_port server_ip server_port". Zero is
// returned for anything else, including an empty value.
func parseSSHConnectionPort(out string) int {
	fields := strings.Fields(out)
	if len(fields) < 4 {
		return 0
	}
	port, err := strconv.Atoi(fields[3])
	if err != nil || port < 1 || port > 65535 {
		return 0
	}
	return port
}
