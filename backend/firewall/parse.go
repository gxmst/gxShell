package firewall

import (
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"

	"gxShell/backend/types"
)

// parseUfwVerbose extracts the enabled state and default policy from
// `ufw status verbose` output.
func parseUfwVerbose(out string) (enabled bool, defaultPolicy string) {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if v, ok := strings.CutPrefix(line, "Status:"); ok {
			enabled = strings.TrimSpace(v) == "active"
		}
		if v, ok := strings.CutPrefix(line, "Default:"); ok {
			defaultPolicy = strings.TrimSpace(v)
		}
	}
	return enabled, defaultPolicy
}

var (
	ufwNumberedRe = regexp.MustCompile(`^\[\s*(\d+)\]\s+(.*)$`)
	// The rule body is column-aligned: TO, ACTION (verb plus optional
	// direction), FROM, separated by runs of 2+ spaces.
	ufwRuleRe = regexp.MustCompile(`^(.+?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)(?:\s+(?:IN|OUT|FWD))?\s{2,}(.+)$`)
	ufwPortRe = regexp.MustCompile(`^(\d{1,5}(?::\d{1,5})?)(?:/(tcp|udp))?$`)
)

// parseUfwNumbered turns `ufw status numbered` output into rules. Lines whose
// body defies the column layout still surface with Index and Raw set, so the
// UI never silently drops a rule it cannot classify.
func parseUfwNumbered(out string) []types.FirewallRule {
	rules := []types.FirewallRule{}
	for _, line := range strings.Split(out, "\n") {
		match := ufwNumberedRe.FindStringSubmatch(strings.TrimSpace(line))
		if match == nil {
			continue
		}
		index, _ := strconv.Atoi(match[1])
		body := strings.TrimSpace(match[2])
		rule := types.FirewallRule{Index: index, Raw: body, V6: strings.Contains(body, "(v6)")}
		parts := ufwRuleRe.FindStringSubmatch(body)
		if parts == nil {
			rules = append(rules, rule)
			continue
		}
		rule.Action = strings.ToLower(parts[2])
		// The To column may be "8080/tcp", a bare port, an interface-scoped or
		// app-profile name; only the port/proto forms are classified. A leading
		// address ("10.0.0.5 8080/tcp") leaves the port in the last field.
		to := strings.TrimSpace(strings.ReplaceAll(parts[1], "(v6)", ""))
		if fields := strings.Fields(to); len(fields) > 0 {
			if pm := ufwPortRe.FindStringSubmatch(fields[len(fields)-1]); pm != nil {
				rule.Port = pm[1]
				rule.Protocol = pm[2]
			}
		}
		from := strings.TrimSpace(strings.ReplaceAll(parts[3], "(v6)", ""))
		if !strings.EqualFold(from, "Anywhere") {
			rule.Source = from
		}
		rules = append(rules, rule)
	}
	return rules
}

// parseFirewalldPorts turns `firewall-cmd --list-ports` output ("8080/tcp
// 9000-9100/udp") into allow rules. firewalld has no rule indexes, so Index
// is -1 and deletion goes by Raw.
func parseFirewalldPorts(out string) []types.FirewallRule {
	rules := []types.FirewallRule{}
	for _, token := range strings.Fields(out) {
		port, proto, ok := strings.Cut(token, "/")
		if !ok {
			continue
		}
		rules = append(rules, types.FirewallRule{
			Index:    -1,
			Raw:      token,
			Action:   "allow",
			Port:     strings.ReplaceAll(port, "-", ":"),
			Protocol: proto,
		})
	}
	return rules
}

var (
	richFamilyRe = regexp.MustCompile(`family="?(ipv[46])"?`)
	richSourceRe = regexp.MustCompile(`source address="?([0-9A-Fa-f.:/]+)"?`)
	richPortRe   = regexp.MustCompile(`port port="?(\d+(?:-\d+)?)"?\s+protocol="?(tcp|udp)"?`)
	richActionRe = regexp.MustCompile(`\b(accept|reject|drop)\b`)
)

// parseFirewalldRichRules parses `firewall-cmd --list-rich-rules` output, one
// rule per line. Parsing is tolerant by design: an exotic rule the regexes
// cannot classify still appears with Raw and a best-effort Action, so it can
// be shown and deleted verbatim.
func parseFirewalldRichRules(out string) []types.FirewallRule {
	rules := []types.FirewallRule{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		rule := types.FirewallRule{Index: -1, Raw: line, Action: "allow"}
		if m := richActionRe.FindStringSubmatch(line); m != nil {
			switch m[1] {
			case "reject":
				rule.Action = "reject"
			case "drop":
				rule.Action = "deny"
			}
		}
		if m := richFamilyRe.FindStringSubmatch(line); m != nil {
			rule.V6 = m[1] == "ipv6"
		}
		if m := richSourceRe.FindStringSubmatch(line); m != nil {
			rule.Source = m[1]
		}
		if m := richPortRe.FindStringSubmatch(line); m != nil {
			rule.Port = strings.ReplaceAll(m[1], "-", ":")
			rule.Protocol = m[2]
		}
		rules = append(rules, rule)
	}
	return rules
}

var portSpecRe = regexp.MustCompile(`^(\d{1,5})(?:[:-](\d{1,5}))?$`)

// parsePortSpec validates "8080", "8000:8100" or "8000-8100" and returns the
// numeric bounds (start == end for a single port).
func parsePortSpec(port string) (start, end int, err error) {
	m := portSpecRe.FindStringSubmatch(port)
	if m == nil {
		return 0, 0, fmt.Errorf("invalid port: %s", port)
	}
	start, _ = strconv.Atoi(m[1])
	end = start
	if m[2] != "" {
		end, _ = strconv.Atoi(m[2])
	}
	if start < 1 || start > 65535 || end > 65535 || start > end {
		return 0, 0, fmt.Errorf("invalid port: %s", port)
	}
	return start, end, nil
}

// validateSource accepts an empty source (anywhere), an IP or a CIDR, and
// reports whether it is IPv6. net.ParseIP/ParseCIDR only accept hex digits,
// dots, colons and a prefix, so a validated source is shell-safe by
// construction.
func validateSource(source string) (v6 bool, err error) {
	if source == "" {
		return false, nil
	}
	var ip net.IP
	if strings.Contains(source, "/") {
		ip, _, err = net.ParseCIDR(source)
	} else {
		ip = net.ParseIP(source)
		if ip == nil {
			err = fmt.Errorf("not an IP")
		}
	}
	if err != nil {
		return false, fmt.Errorf("invalid source address: %s", source)
	}
	return ip.To4() == nil, nil
}

// firewalldPortRawRe recognizes a --list-ports token ("8080/tcp",
// "9000-9100/udp"); everything else is treated as a rich rule.
var firewalldPortRawRe = regexp.MustCompile(`^\d{1,5}(?:-\d{1,5})?/(?:tcp|udp)$`)

// rawRuleRe whitelists the characters that appear in ufw numbered rule bodies
// and firewalld rich rules. Raw strings are interpolated into remote commands
// (single-quoted for rich rules), so quotes other than '"' and all shell
// metacharacters are rejected.
var rawRuleRe = regexp.MustCompile(`^[A-Za-z0-9 ()\[\]"=#.,/:_-]+$`)

func sanitizeRawRule(raw string) error {
	if raw == "" || len(raw) > 512 || !rawRuleRe.MatchString(raw) {
		return fmt.Errorf("invalid rule text")
	}
	return nil
}

// ruleCoversPort reports whether a parsed rule's port (or range) covers the
// given TCP port. Rules without a parsed port never match: the guard prefers
// false negatives over blocking deletions of unrelated rules.
func ruleCoversPort(rule types.FirewallRule, port int) bool {
	if rule.Port == "" || rule.Protocol == "udp" {
		return false
	}
	start, end, err := parsePortSpec(rule.Port)
	if err != nil {
		return false
	}
	return start <= port && port <= end
}

var spacesRe = regexp.MustCompile(`\s+`)

// normalizeSpaces collapses whitespace runs so a ufw rule body survives the
// round trip through UI display and back for the delete-verification compare.
func normalizeSpaces(s string) string {
	return spacesRe.ReplaceAllString(strings.TrimSpace(s), " ")
}
