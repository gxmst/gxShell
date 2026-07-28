package main

import (
	"fmt"
	"net"
	"strings"

	"gxShell/backend/logger"
	"gxShell/backend/types"
)

// GetFirewallStatus detects the remote firewall backend (ufw/firewalld/none)
// and returns its state and rules.
func (a *App) GetFirewallStatus(sessionID string) (types.FirewallStatus, error) {
	return a.firewall.GetFirewallStatus(sessionID)
}

// AddFirewallRule adds an allow|deny rule. A deny covering this session's SSH
// port requires force.
func (a *App) AddFirewallRule(sessionID string, action string, port string, protocol string, source string, force bool) (types.FirewallActionResult, error) {
	target := fmt.Sprintf("%s %s/%s", action, port, protocol)
	audit := a.beginChangeAudit("firewall.rule.add", target, sessionID, logger.LogFields{"force": force, "sourceScoped": strings.TrimSpace(source) != ""})
	if err := a.firewall.AddFirewallRule(sessionID, action, port, protocol, source, force); err != nil {
		audit.finish(err, false, "")
		return types.FirewallActionResult{}, err
	}
	result := a.verifyFirewallRuleChange(sessionID, true, action, port, protocol, source, "")
	audit.finish(nil, result.Verified, result.Verification)
	return result, nil
}

// DeleteFirewallRule deletes one rule (ufw: verified by index+raw; firewalld:
// by raw). Removing an allow covering this session's SSH port requires force.
func (a *App) DeleteFirewallRule(sessionID string, index int, raw string, force bool) (types.FirewallActionResult, error) {
	target := fmt.Sprintf("rule-index-%d", index)
	audit := a.beginChangeAudit("firewall.rule.delete", target, sessionID, logger.LogFields{"force": force})
	if err := a.firewall.DeleteFirewallRule(sessionID, index, raw, force); err != nil {
		audit.finish(err, false, "")
		return types.FirewallActionResult{}, err
	}
	result := a.verifyFirewallRuleChange(sessionID, false, "", "", "", "", raw)
	audit.finish(nil, result.Verified, result.Verification)
	return result, nil
}

// SetFirewallEnabled enables or disables the firewall. Enabling preserves this
// session's SSH port before activation; disabling always requires force.
func (a *App) SetFirewallEnabled(sessionID string, enable bool, force bool) (types.FirewallActionResult, error) {
	target := map[bool]string{true: "enabled", false: "disabled"}[enable]
	audit := a.beginChangeAudit("firewall.set-enabled", target, sessionID, logger.LogFields{"force": force})
	if err := a.firewall.SetFirewallEnabled(sessionID, enable, force); err != nil {
		audit.finish(err, false, "")
		return types.FirewallActionResult{}, err
	}
	status, err := a.firewall.GetFirewallStatus(sessionID)
	if err != nil {
		result := types.FirewallActionResult{Verification: "change completed but firewall state readback failed: " + err.Error()}
		audit.finish(nil, false, result.Verification)
		return result, nil
	}
	verified := status.Enabled == enable
	verification := fmt.Sprintf("firewall enabled=%t", status.Enabled)
	result := types.FirewallActionResult{Status: status, Verified: verified, Verification: verification}
	audit.finish(nil, verified, verification)
	return result, nil
}

func (a *App) verifyFirewallRuleChange(sessionID string, shouldExist bool, action, port, protocol, source, raw string) types.FirewallActionResult {
	status, err := a.firewall.GetFirewallStatus(sessionID)
	if err != nil {
		return types.FirewallActionResult{Verification: "rule change completed but firewall state readback failed: " + err.Error()}
	}
	found := false
	for _, rule := range status.Rules {
		if raw != "" {
			if normalizeFirewallAuditText(rule.Raw) == normalizeFirewallAuditText(raw) {
				found = true
				break
			}
			continue
		}
		if firewallRuleMatches(rule, action, port, protocol, source) {
			found = true
			break
		}
	}
	verified := found == shouldExist
	verification := map[bool]string{true: "rule is present in readback", false: "rule is absent from readback"}[found]
	return types.FirewallActionResult{Status: status, Verified: verified, Verification: verification}
}

func firewallRuleMatches(rule types.FirewallRule, action, port, protocol, source string) bool {
	return normalizeFirewallAction(rule.Action) == normalizeFirewallAction(action) &&
		normalizeFirewallPort(rule.Port) == normalizeFirewallPort(port) &&
		strings.EqualFold(strings.TrimSpace(rule.Protocol), strings.TrimSpace(protocol)) &&
		normalizeFirewallSource(rule.Source) == normalizeFirewallSource(source)
}

func normalizeFirewallAction(action string) string {
	fields := strings.Fields(strings.ToLower(action))
	if len(fields) == 0 {
		return ""
	}
	switch fields[0] {
	case "accept":
		return "allow"
	case "reject", "drop":
		return "deny"
	default:
		return fields[0]
	}
}

func normalizeFirewallPort(port string) string {
	return strings.ReplaceAll(strings.TrimSpace(port), "-", ":")
}

func normalizeFirewallSource(source string) string {
	source = strings.TrimSpace(source)
	if source == "" || strings.EqualFold(source, "anywhere") {
		return ""
	}
	if strings.Contains(source, "/") {
		if _, network, err := net.ParseCIDR(source); err == nil {
			return network.String()
		}
	}
	if ip := net.ParseIP(source); ip != nil {
		return ip.String()
	}
	return strings.ToLower(source)
}

func normalizeFirewallAuditText(value string) string {
	return strings.Join(strings.Fields(value), " ")
}
