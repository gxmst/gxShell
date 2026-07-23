package firewall

import (
	"errors"
	"strings"
	"testing"
	"time"

	"gxShell/backend/types"
)

type fakeFirewallSSH struct {
	commands []string
	port     int
	exec     func(command string) (string, error)
}

func (f *fakeFirewallSSH) Exec(_ string, command string, _ time.Duration) (string, error) {
	f.commands = append(f.commands, command)
	if f.exec != nil {
		return f.exec(command)
	}
	return "", nil
}

func (f *fakeFirewallSSH) SessionPort(string) (int, error) {
	return f.port, nil
}

const ufwVerboseSample = `Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere
`

func TestParseUfwVerbose(t *testing.T) {
	enabled, policy := parseUfwVerbose(ufwVerboseSample)
	if !enabled {
		t.Error("expected enabled")
	}
	if policy != "deny (incoming), allow (outgoing), disabled (routed)" {
		t.Errorf("policy = %q", policy)
	}

	enabled, policy = parseUfwVerbose("Status: inactive\n")
	if enabled || policy != "" {
		t.Errorf("inactive parse = %v, %q", enabled, policy)
	}
}

const ufwNumberedSample = `Status: active

     To                         Action      From
     --                         ------      ----
[ 1] 8080/tcp                   ALLOW IN    Anywhere
[ 2] 22/tcp                     ALLOW IN    192.168.1.0/24
[ 3] 8000:8100/tcp              ALLOW IN    Anywhere
[ 4] 3306                       DENY IN     10.0.0.5
[ 5] 8080/tcp (v6)              ALLOW IN    Anywhere (v6)
[ 6] Anywhere                   ALLOW IN    203.0.113.0/24
[ 7] 22/tcp                     LIMIT IN    Anywhere
[ 8] 53/udp                     REJECT IN   Anywhere
`

func TestParseUfwNumbered(t *testing.T) {
	rules := parseUfwNumbered(ufwNumberedSample)
	if len(rules) != 8 {
		t.Fatalf("expected 8 rules, got %d", len(rules))
	}

	tests := []struct {
		i    int
		want types.FirewallRule
	}{
		{0, types.FirewallRule{Index: 1, Action: "allow", Port: "8080", Protocol: "tcp"}},
		{1, types.FirewallRule{Index: 2, Action: "allow", Port: "22", Protocol: "tcp", Source: "192.168.1.0/24"}},
		{2, types.FirewallRule{Index: 3, Action: "allow", Port: "8000:8100", Protocol: "tcp"}},
		{3, types.FirewallRule{Index: 4, Action: "deny", Port: "3306", Source: "10.0.0.5"}},
		{4, types.FirewallRule{Index: 5, Action: "allow", Port: "8080", Protocol: "tcp", V6: true}},
		{5, types.FirewallRule{Index: 6, Action: "allow", Source: "203.0.113.0/24"}},
		{6, types.FirewallRule{Index: 7, Action: "limit", Port: "22", Protocol: "tcp"}},
		{7, types.FirewallRule{Index: 8, Action: "reject", Port: "53", Protocol: "udp"}},
	}
	for _, tt := range tests {
		got := rules[tt.i]
		if got.Raw == "" {
			t.Errorf("rule %d has empty Raw", tt.i)
		}
		got.Raw = ""
		if got != tt.want {
			t.Errorf("rule %d = %+v, want %+v", tt.i, got, tt.want)
		}
	}
	if rules[0].Raw != "8080/tcp                   ALLOW IN    Anywhere" {
		t.Errorf("rule 1 raw = %q", rules[0].Raw)
	}
}

func TestParseFirewalldPorts(t *testing.T) {
	rules := parseFirewalldPorts("8080/tcp 9000-9100/udp\n")
	if len(rules) != 2 {
		t.Fatalf("expected 2 rules, got %d", len(rules))
	}
	if rules[0] != (types.FirewallRule{Index: -1, Raw: "8080/tcp", Action: "allow", Port: "8080", Protocol: "tcp"}) {
		t.Errorf("rule 0 = %+v", rules[0])
	}
	// Ranges are normalized to ':' in Port but Raw keeps the backend syntax.
	if rules[1] != (types.FirewallRule{Index: -1, Raw: "9000-9100/udp", Action: "allow", Port: "9000:9100", Protocol: "udp"}) {
		t.Errorf("rule 1 = %+v", rules[1])
	}
	if got := parseFirewalldPorts(""); len(got) != 0 {
		t.Fatalf("empty output produced %d rules", len(got))
	}
}

func TestParseFirewalldRichRules(t *testing.T) {
	out := `rule family="ipv4" source address="192.168.1.0/24" port port="8080" protocol="tcp" accept
rule family="ipv4" port port="3306" protocol="tcp" reject
rule family="ipv6" source address="2001:db8::/32" port port="8000-8100" protocol="udp" drop
rule family="ipv4" service name="ftp" log prefix="ftp" level="info" accept
`
	rules := parseFirewalldRichRules(out)
	if len(rules) != 4 {
		t.Fatalf("expected 4 rules, got %d", len(rules))
	}

	r := rules[0]
	if r.Action != "allow" || r.Port != "8080" || r.Protocol != "tcp" || r.Source != "192.168.1.0/24" || r.V6 || r.Index != -1 {
		t.Errorf("rule 0 = %+v", r)
	}
	r = rules[1]
	if r.Action != "reject" || r.Port != "3306" || r.Source != "" {
		t.Errorf("rule 1 = %+v", r)
	}
	r = rules[2]
	if r.Action != "deny" || r.Port != "8000:8100" || r.Protocol != "udp" || !r.V6 || r.Source != "2001:db8::/32" {
		t.Errorf("rule 2 = %+v", r)
	}
	// A rule without a port still appears with Raw and a best-effort action.
	r = rules[3]
	if r.Action != "allow" || r.Port != "" || r.Raw == "" {
		t.Errorf("rule 3 = %+v", r)
	}
}

func TestParsePortSpec(t *testing.T) {
	tests := []struct {
		port    string
		start   int
		end     int
		wantErr bool
	}{
		{"8080", 8080, 8080, false},
		{"1", 1, 1, false},
		{"65535", 65535, 65535, false},
		{"8000:8100", 8000, 8100, false},
		{"8000-8100", 8000, 8100, false},
		{"", 0, 0, true},
		{"0", 0, 0, true},
		{"65536", 0, 0, true},
		{"8100:8000", 0, 0, true},
		{"8080/tcp", 0, 0, true},
		{"80;rm -rf /", 0, 0, true},
		{"abc", 0, 0, true},
	}
	for _, tt := range tests {
		start, end, err := parsePortSpec(tt.port)
		if (err != nil) != tt.wantErr {
			t.Errorf("parsePortSpec(%q) error = %v, wantErr %v", tt.port, err, tt.wantErr)
			continue
		}
		if err == nil && (start != tt.start || end != tt.end) {
			t.Errorf("parsePortSpec(%q) = %d..%d, want %d..%d", tt.port, start, end, tt.start, tt.end)
		}
	}
}

func TestValidateSource(t *testing.T) {
	tests := []struct {
		source  string
		v6      bool
		wantErr bool
	}{
		{"", false, false},
		{"192.168.1.5", false, false},
		{"192.168.1.0/24", false, false},
		{"2001:db8::1", true, false},
		{"2001:db8::/32", true, false},
		{"999.1.1.1", false, true},
		{"192.168.1.0/33", false, true},
		{"anywhere", false, true},
		{"1.2.3.4; rm -rf /", false, true},
		{"$(id)", false, true},
	}
	for _, tt := range tests {
		v6, err := validateSource(tt.source)
		if (err != nil) != tt.wantErr {
			t.Errorf("validateSource(%q) error = %v, wantErr %v", tt.source, err, tt.wantErr)
			continue
		}
		if err == nil && v6 != tt.v6 {
			t.Errorf("validateSource(%q) v6 = %v, want %v", tt.source, v6, tt.v6)
		}
	}
}

func TestSanitizeRawRule(t *testing.T) {
	valid := []string{
		"8080/tcp                   ALLOW IN    Anywhere",
		"22/tcp (v6)                ALLOW IN    Anywhere (v6)",
		"9000-9100/udp",
		`rule family="ipv4" source address="192.168.1.0/24" port port="8080" protocol="tcp" accept`,
	}
	for _, raw := range valid {
		if err := sanitizeRawRule(raw); err != nil {
			t.Errorf("sanitizeRawRule(%q): %v", raw, err)
		}
	}
	invalid := []string{
		"",
		"8080/tcp'; reboot; '",
		"rule `id`",
		"rule $(id)",
		"a && b",
		"a | b",
		"a\nb",
		string(make([]byte, 513)),
	}
	for _, raw := range invalid {
		if err := sanitizeRawRule(raw); err == nil {
			t.Errorf("sanitizeRawRule(%q) unexpectedly succeeded", raw)
		}
	}
}

func TestRuleCoversPort(t *testing.T) {
	tests := []struct {
		name string
		rule types.FirewallRule
		port int
		want bool
	}{
		{"exact tcp", types.FirewallRule{Port: "22", Protocol: "tcp"}, 22, true},
		{"no protocol", types.FirewallRule{Port: "22"}, 22, true},
		{"other port", types.FirewallRule{Port: "80", Protocol: "tcp"}, 22, false},
		{"range covering", types.FirewallRule{Port: "20:25", Protocol: "tcp"}, 22, true},
		{"range not covering", types.FirewallRule{Port: "8000:8100", Protocol: "tcp"}, 22, false},
		{"udp never matches ssh", types.FirewallRule{Port: "22", Protocol: "udp"}, 22, false},
		{"portless rule", types.FirewallRule{Raw: "Anywhere ALLOW IN 10.0.0.0/8"}, 22, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ruleCoversPort(tt.rule, tt.port); got != tt.want {
				t.Errorf("ruleCoversPort(%+v, %d) = %v, want %v", tt.rule, tt.port, got, tt.want)
			}
		})
	}
}

func TestNormalizeSpaces(t *testing.T) {
	a := normalizeSpaces("8080/tcp                   ALLOW IN    Anywhere")
	b := normalizeSpaces("  8080/tcp ALLOW IN Anywhere ")
	if a != b || a != "8080/tcp ALLOW IN Anywhere" {
		t.Errorf("normalizeSpaces mismatch: %q vs %q", a, b)
	}
}

func TestAddFirewallRuleValidation(t *testing.T) {
	m := NewManager(nil)
	// All of these must fail before any remote command is attempted (the nil
	// ssh manager would panic otherwise).
	if err := m.AddFirewallRule("s", "drop", "80", "tcp", "", false); err == nil {
		t.Fatal("invalid action accepted")
	}
	if err := m.AddFirewallRule("s", "allow", "80;id", "tcp", "", false); err == nil {
		t.Fatal("invalid port accepted")
	}
	if err := m.AddFirewallRule("s", "allow", "80", "icmp", "", false); err == nil {
		t.Fatal("invalid protocol accepted")
	}
	if err := m.AddFirewallRule("s", "allow", "80", "tcp", "$(id)", false); err == nil {
		t.Fatal("invalid source accepted")
	}
	if err := m.DeleteFirewallRule("s", 1, "8080/tcp'; reboot", false); err == nil {
		t.Fatal("raw rule injection accepted")
	}
}

func TestEnableFirewalldOpensSSHPortOfflineBeforeStart(t *testing.T) {
	fake := &fakeFirewallSSH{port: 2222}
	fake.exec = func(command string) (string, error) {
		switch {
		case strings.Contains(command, "has_ufw=0"):
			return "firewalld\n", nil
		case command == "id -u":
			return "0\n", nil
		default:
			return "", nil
		}
	}
	m := NewManager(nil)
	m.ssh = fake
	if err := m.SetFirewallEnabled("session", true, false); err != nil {
		t.Fatalf("SetFirewallEnabled: %v", err)
	}
	want := []string{
		"command -v firewall-offline-cmd >/dev/null 2>&1",
		"firewall-offline-cmd --add-port=2222/tcp",
		"systemctl start firewalld",
	}
	positions := make([]int, len(want))
	for i := range positions {
		positions[i] = -1
	}
	for i, command := range fake.commands {
		for j, expected := range want {
			if command == expected {
				positions[j] = i
			}
		}
	}
	if positions[0] < 0 || positions[1] <= positions[0] || positions[2] <= positions[1] {
		t.Fatalf("unsafe firewalld command order: %#v", fake.commands)
	}
}

func TestEnableFirewalldRefusesUnsafeStartWithoutOfflineTool(t *testing.T) {
	fake := &fakeFirewallSSH{port: 2222}
	fake.exec = func(command string) (string, error) {
		switch {
		case strings.Contains(command, "has_ufw=0"):
			return "firewalld\n", nil
		case command == "id -u":
			return "0\n", nil
		case command == "command -v firewall-offline-cmd >/dev/null 2>&1":
			return "", errors.New("exit status 1")
		default:
			return "", nil
		}
	}
	m := NewManager(nil)
	m.ssh = fake
	if err := m.SetFirewallEnabled("session", true, false); err == nil {
		t.Fatal("expected safe enable refusal")
	}
	for _, command := range fake.commands {
		if command == "systemctl start firewalld" {
			t.Fatalf("firewalld was started without an offline SSH exception: %#v", fake.commands)
		}
	}
}
