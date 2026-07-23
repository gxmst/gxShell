package main

import "gxShell/backend/types"

// GetFirewallStatus detects the remote firewall backend (ufw/firewalld/none)
// and returns its state and rules.
func (a *App) GetFirewallStatus(sessionID string) (types.FirewallStatus, error) {
	return a.firewall.GetFirewallStatus(sessionID)
}

// AddFirewallRule adds an allow|deny rule. A deny covering this session's SSH
// port requires force.
func (a *App) AddFirewallRule(sessionID string, action string, port string, protocol string, source string, force bool) error {
	return a.firewall.AddFirewallRule(sessionID, action, port, protocol, source, force)
}

// DeleteFirewallRule deletes one rule (ufw: verified by index+raw; firewalld:
// by raw). Removing an allow covering this session's SSH port requires force.
func (a *App) DeleteFirewallRule(sessionID string, index int, raw string, force bool) error {
	return a.firewall.DeleteFirewallRule(sessionID, index, raw, force)
}

// SetFirewallEnabled enables or disables the firewall. Enabling preserves this
// session's SSH port before activation; disabling always requires force.
func (a *App) SetFirewallEnabled(sessionID string, enable bool, force bool) error {
	return a.firewall.SetFirewallEnabled(sessionID, enable, force)
}
