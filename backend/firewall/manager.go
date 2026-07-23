package firewall

import (
	"fmt"
	"strings"
	"sync"
	"time"

	sshmanager "gxShell/backend/ssh"
	"gxShell/backend/types"
)

type Manager struct {
	ssh firewallSSH
	// emit is unused today; it is wired at startup like every other remote
	// manager so future rule-change events need no new plumbing.
	emit      func(event string, data any)
	rootMu    sync.Mutex
	rootCache map[string]bool
}

type firewallSSH interface {
	Exec(id string, command string, timeout time.Duration) (string, error)
	SessionPort(id string) (int, error)
}

func NewManager(sshMgr *sshmanager.Manager) *Manager {
	return &Manager{
		ssh:       sshMgr,
		emit:      func(event string, data any) {},
		rootCache: make(map[string]bool),
	}
}

func (m *Manager) SetEmit(fn func(event string, data any)) {
	if fn != nil {
		m.emit = fn
	}
}

// detectBackend probes for a supported firewall frontend. "none" is a valid
// answer, not an error: a host without ufw/firewalld still gets a status.
func (m *Manager) detectBackend(sessionID string) (string, error) {
	// Prefer the backend that is actually active/enabled when both packages are
	// installed. Merely finding /usr/sbin/ufw is not enough: many distributions
	// leave it installed while firewalld is the firewall that owns the rules.
	cmd := `has_ufw=0; has_firewalld=0; command -v ufw >/dev/null 2>&1 && has_ufw=1; command -v firewall-cmd >/dev/null 2>&1 && has_firewalld=1; ` +
		`if [ "$has_firewalld" = 1 ] && { firewall-cmd --state >/dev/null 2>&1 || systemctl is-active --quiet firewalld; }; then echo firewalld; ` +
		`elif [ "$has_ufw" = 1 ] && { systemctl is-active --quiet ufw 2>/dev/null || ufw status 2>/dev/null | grep -qi '^Status: active' || systemctl is-enabled --quiet ufw 2>/dev/null; }; then echo ufw; ` +
		`elif [ "$has_firewalld" = 1 ] && systemctl is-enabled --quiet firewalld 2>/dev/null; then echo firewalld; ` +
		`elif [ "$has_ufw" = 1 ] && [ "$has_firewalld" = 0 ]; then echo ufw; ` +
		`elif [ "$has_firewalld" = 1 ]; then echo firewalld; elif [ "$has_ufw" = 1 ]; then echo ufw; else echo none; fi`
	out, err := m.ssh.Exec(sessionID, cmd, 15*time.Second)
	if err != nil {
		return "", fmt.Errorf("firewall detection failed: %w", err)
	}
	backend := strings.TrimSpace(out)
	switch backend {
	case "ufw", "firewalld", "none":
		return backend, nil
	}
	return "", fmt.Errorf("firewall detection failed: unexpected output %q", backend)
}

func (m *Manager) GetFirewallStatus(sessionID string) (types.FirewallStatus, error) {
	status := types.FirewallStatus{Backend: "none", Rules: []types.FirewallRule{}}
	backend, err := m.detectBackend(sessionID)
	if err != nil {
		return status, err
	}
	status.Backend = backend
	if port, err := m.ssh.SessionPort(sessionID); err == nil {
		status.SSHPort = port
	}
	switch backend {
	case "ufw":
		return m.ufwStatus(sessionID, status)
	case "firewalld":
		return m.firewalldStatus(sessionID, status)
	}
	return status, nil
}

func (m *Manager) ufwStatus(sessionID string, status types.FirewallStatus) (types.FirewallStatus, error) {
	verbose, err := m.execRoot(sessionID, "ufw status verbose", 15*time.Second)
	if err != nil {
		return status, cmdError("ufw status failed", err, verbose)
	}
	status.Enabled, status.DefaultPolicy = parseUfwVerbose(verbose)
	if !status.Enabled {
		return status, nil
	}
	numbered, err := m.execRoot(sessionID, "ufw status numbered", 15*time.Second)
	if err != nil {
		return status, cmdError("ufw status numbered failed", err, numbered)
	}
	status.Rules = parseUfwNumbered(numbered)
	return status, nil
}

func (m *Manager) firewalldStatus(sessionID string, status types.FirewallStatus) (types.FirewallStatus, error) {
	// --state exits non-zero when the daemon is stopped; only treat unexpected
	// failures (e.g. sudo denial) as errors.
	state, err := m.execRoot(sessionID, "firewall-cmd --state 2>&1", 15*time.Second)
	if err != nil && !strings.Contains(state+err.Error(), "not running") {
		return status, cmdError("firewall-cmd --state failed", err, state)
	}
	status.Enabled = strings.TrimSpace(state) == "running"
	if !status.Enabled {
		return status, nil
	}
	if zone, err := m.execRoot(sessionID, "firewall-cmd --get-default-zone", 15*time.Second); err == nil {
		status.DefaultPolicy = strings.TrimSpace(zone)
	}
	ports, err := m.execRoot(sessionID, "firewall-cmd --list-ports", 15*time.Second)
	if err != nil {
		return status, cmdError("firewall-cmd --list-ports failed", err, ports)
	}
	rich, err := m.execRoot(sessionID, "firewall-cmd --list-rich-rules", 15*time.Second)
	if err != nil {
		return status, cmdError("firewall-cmd --list-rich-rules failed", err, rich)
	}
	status.Rules = append(parseFirewalldPorts(ports), parseFirewalldRichRules(rich)...)
	return status, nil
}

func (m *Manager) AddFirewallRule(sessionID, action, port, protocol, source string, force bool) error {
	if action != "allow" && action != "deny" {
		return fmt.Errorf("invalid firewall action: %s", action)
	}
	start, end, err := parsePortSpec(port)
	if err != nil {
		return err
	}
	if protocol != "tcp" && protocol != "udp" {
		return fmt.Errorf("invalid protocol: %s", protocol)
	}
	sourceV6, err := validateSource(source)
	if err != nil {
		return err
	}
	// Lockout guard: a deny covering this session's own SSH port needs an
	// explicit force, whatever the source — the operator's address may match it.
	if action == "deny" && !force {
		if sshPort, err := m.ssh.SessionPort(sessionID); err == nil && start <= sshPort && sshPort <= end && protocol == "tcp" {
			return fmt.Errorf("rule would block port %d used by this SSH session and may lock you out (use force to override)", sshPort)
		}
	}
	backend, err := m.detectBackend(sessionID)
	if err != nil {
		return err
	}
	switch backend {
	case "ufw":
		return m.ufwAddRule(sessionID, action, port, protocol, source)
	case "firewalld":
		return m.firewalldAddRule(sessionID, action, port, protocol, source, sourceV6)
	}
	return fmt.Errorf("no supported firewall detected on this host")
}

func (m *Manager) ufwAddRule(sessionID, action, port, protocol, source string) error {
	port = strings.ReplaceAll(port, "-", ":") // ufw ranges use ':'
	var cmd string
	if source == "" {
		cmd = fmt.Sprintf("ufw %s %s/%s", action, port, protocol)
	} else {
		cmd = fmt.Sprintf("ufw %s from %s to any port %s proto %s", action, source, port, protocol)
	}
	if out, err := m.execRoot(sessionID, cmd, 20*time.Second); err != nil {
		return cmdError("failed to add rule", err, out)
	}
	return nil
}

func (m *Manager) firewalldAddRule(sessionID, action, port, protocol, source string, sourceV6 bool) error {
	port = strings.ReplaceAll(port, ":", "-") // firewalld ranges use '-'
	var cmd string
	if action == "allow" && source == "" {
		cmd = fmt.Sprintf("firewall-cmd --permanent --add-port=%s/%s", port, protocol)
	} else {
		// deny or source-scoped rules need a rich rule; --add-port cannot
		// express either. All interpolated values were validated above.
		family := "ipv4"
		if sourceV6 {
			family = "ipv6"
		}
		verb := "accept"
		if action == "deny" {
			verb = "reject"
		}
		srcPart := ""
		if source != "" {
			srcPart = fmt.Sprintf(` source address="%s"`, source)
		}
		rich := fmt.Sprintf(`rule family="%s"%s port port="%s" protocol="%s" %s`, family, srcPart, port, protocol, verb)
		cmd = fmt.Sprintf("firewall-cmd --permanent --add-rich-rule='%s'", rich)
	}
	if out, err := m.execRoot(sessionID, cmd, 20*time.Second); err != nil {
		return cmdError("failed to add rule", err, out)
	}
	if out, err := m.execRoot(sessionID, "firewall-cmd --reload", 30*time.Second); err != nil {
		return cmdError("failed to reload firewalld", err, out)
	}
	return nil
}

func (m *Manager) DeleteFirewallRule(sessionID string, index int, raw string, force bool) error {
	if err := sanitizeRawRule(raw); err != nil {
		return err
	}
	backend, err := m.detectBackend(sessionID)
	if err != nil {
		return err
	}
	switch backend {
	case "ufw":
		return m.ufwDeleteRule(sessionID, index, raw, force)
	case "firewalld":
		return m.firewalldDeleteRule(sessionID, raw, force)
	}
	return fmt.Errorf("no supported firewall detected on this host")
}

// ufwDeleteRule deletes by index, but only after verifying the rule at that
// index still matches what the UI displayed: indexes shift whenever another
// actor adds or removes a rule, and a blind delete would then remove the
// wrong one.
func (m *Manager) ufwDeleteRule(sessionID string, index int, raw string, force bool) error {
	if index < 1 || index > 65535 {
		return fmt.Errorf("invalid rule index: %d", index)
	}
	numbered, err := m.execRoot(sessionID, "ufw status numbered", 15*time.Second)
	if err != nil {
		return cmdError("ufw status failed", err, numbered)
	}
	var current *types.FirewallRule
	rules := parseUfwNumbered(numbered)
	for i := range rules {
		if rules[i].Index == index {
			current = &rules[i]
			break
		}
	}
	if current == nil || normalizeSpaces(current.Raw) != normalizeSpaces(raw) {
		return fmt.Errorf("firewall rules changed since the list was loaded; refresh and try again")
	}
	if err := m.guardAllowDeletion(sessionID, *current, force); err != nil {
		return err
	}
	if out, err := m.execRoot(sessionID, fmt.Sprintf("ufw --force delete %d", index), 20*time.Second); err != nil {
		return cmdError("failed to delete rule", err, out)
	}
	return nil
}

func (m *Manager) firewalldDeleteRule(sessionID, raw string, force bool) error {
	var cmd string
	var rule types.FirewallRule
	if firewalldPortRawRe.MatchString(raw) {
		port, proto, _ := strings.Cut(raw, "/")
		rule = types.FirewallRule{Action: "allow", Port: strings.ReplaceAll(port, "-", ":"), Protocol: proto}
		cmd = fmt.Sprintf("firewall-cmd --permanent --remove-port=%s", raw)
	} else {
		if parsed := parseFirewalldRichRules(raw); len(parsed) > 0 {
			rule = parsed[0]
		}
		// sanitizeRawRule already rejected quoting/injection characters.
		cmd = fmt.Sprintf("firewall-cmd --permanent --remove-rich-rule='%s'", raw)
	}
	if err := m.guardAllowDeletion(sessionID, rule, force); err != nil {
		return err
	}
	if out, err := m.execRoot(sessionID, cmd, 20*time.Second); err != nil {
		return cmdError("failed to delete rule", err, out)
	}
	if out, err := m.execRoot(sessionID, "firewall-cmd --reload", 30*time.Second); err != nil {
		return cmdError("failed to reload firewalld", err, out)
	}
	return nil
}

// guardAllowDeletion blocks removing an ALLOW rule that keeps this session's
// SSH port open, unless forced.
func (m *Manager) guardAllowDeletion(sessionID string, rule types.FirewallRule, force bool) error {
	if force || rule.Action != "allow" {
		return nil
	}
	if sshPort, err := m.ssh.SessionPort(sessionID); err == nil && ruleCoversPort(rule, sshPort) {
		return fmt.Errorf("deleting this rule may block port %d used by this SSH session (use force to override)", sshPort)
	}
	return nil
}

func (m *Manager) SetFirewallEnabled(sessionID string, enable, force bool) error {
	// Disabling always needs force: it drops every filter at once.
	if !enable && !force {
		return fmt.Errorf("disabling the firewall removes all filtering (use force to confirm)")
	}
	backend, err := m.detectBackend(sessionID)
	if err != nil {
		return err
	}
	switch backend {
	case "ufw":
		if !enable {
			if out, err := m.execRoot(sessionID, "ufw disable", 20*time.Second); err != nil {
				return cmdError("failed to disable ufw", err, out)
			}
			return nil
		}
		sshPort, err := m.ssh.SessionPort(sessionID)
		if err != nil {
			return err
		}
		// Allow this session's SSH port BEFORE enabling: ufw defaults to
		// deny-incoming, so the reverse order would cut this very connection.
		if out, err := m.execRoot(sessionID, fmt.Sprintf("ufw allow %d/tcp", sshPort), 20*time.Second); err != nil {
			return cmdError("failed to keep SSH port open", err, out)
		}
		if out, err := m.execRoot(sessionID, "ufw --force enable", 30*time.Second); err != nil {
			return cmdError("failed to enable ufw", err, out)
		}
		return nil
	case "firewalld":
		if !enable {
			if out, err := m.execRoot(sessionID, "systemctl stop firewalld", 30*time.Second); err != nil {
				return cmdError("failed to stop firewalld", err, out)
			}
			return nil
		}
		sshPort, err := m.ssh.SessionPort(sessionID)
		if err != nil {
			return err
		}
		// A stopped firewalld can apply its default zone immediately on start.
		// Configure the SSH exception in the offline permanent store first; using
		// firewall-cmd after systemctl start creates a lockout window in which this
		// very SSH connection may already be gone.
		if out, err := m.ssh.Exec(sessionID, "command -v firewall-offline-cmd >/dev/null 2>&1", 10*time.Second); err != nil {
			return cmdError("cannot safely enable firewalld remotely because firewall-offline-cmd is unavailable", err, out)
		}
		if out, err := m.execRoot(sessionID, fmt.Sprintf("firewall-offline-cmd --add-port=%d/tcp", sshPort), 20*time.Second); err != nil {
			return cmdError("failed to keep SSH port open before starting firewalld", err, out)
		}
		if out, err := m.execRoot(sessionID, "systemctl start firewalld", 30*time.Second); err != nil {
			return cmdError("failed to start firewalld", err, out)
		}
		return nil
	}
	return fmt.Errorf("no supported firewall detected on this host")
}
