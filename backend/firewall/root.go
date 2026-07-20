package firewall

import (
	"fmt"
	"strings"
	"time"
)

// maxRootCacheEntries bounds the per-session root cache. The SSH manager caps
// live sessions at 20, so growing past this means the map is mostly stale
// session IDs; a wholesale reset is cheaper than tracking disconnects.
const maxRootCacheEntries = 64

// sudoPrefix returns the prefix needed to run privileged commands in this
// session: empty for root, "sudo -n " otherwise. The `id -u` probe runs once
// per session and is cached.
func (m *Manager) sudoPrefix(sessionID string) string {
	m.rootMu.Lock()
	isRoot, ok := m.rootCache[sessionID]
	m.rootMu.Unlock()
	if !ok {
		out, err := m.ssh.Exec(sessionID, "id -u", 10*time.Second)
		isRoot = err == nil && strings.TrimSpace(out) == "0"
		m.rootMu.Lock()
		if len(m.rootCache) >= maxRootCacheEntries {
			m.rootCache = make(map[string]bool)
		}
		m.rootCache[sessionID] = isRoot
		m.rootMu.Unlock()
	}
	if isRoot {
		return ""
	}
	return "sudo -n "
}

// execRoot runs a privileged command, prefixing "sudo -n" for non-root users.
// A sudo password prompt cannot be answered over this exec channel, so it is
// translated into an actionable error instead of raw sudo noise.
func (m *Manager) execRoot(sessionID, cmd string, timeout time.Duration) (string, error) {
	prefix := m.sudoPrefix(sessionID)
	out, err := m.ssh.Exec(sessionID, prefix+cmd, timeout)
	if err != nil && prefix != "" && looksLikeSudoFailure(out, err.Error()) {
		return out, fmt.Errorf("this operation requires root or passwordless sudo on the remote host")
	}
	return out, err
}

// looksLikeSudoFailure matches "sudo: a password is required", "sudo: command
// not found" and similar prompts; both stdout and the stderr folded into err
// are checked because sudo's destination varies by configuration.
func looksLikeSudoFailure(out, errMsg string) bool {
	combined := strings.ToLower(out + " " + errMsg)
	return strings.Contains(combined, "sudo:") || strings.Contains(combined, "password is required")
}

// cmdError folds trimmed command output into err when it adds information:
// ufw and firewall-cmd print the actual reason to stdout/stderr more reliably
// than to the exit status.
func cmdError(prefix string, err error, out string) error {
	if msg := strings.TrimSpace(out); msg != "" && !strings.Contains(err.Error(), msg) {
		return fmt.Errorf("%s: %v: %s", prefix, err, msg)
	}
	return fmt.Errorf("%s: %w", prefix, err)
}
