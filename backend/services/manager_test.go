package services

import (
	"sync/atomic"
	"testing"

	"gxShell/backend/types"
)

const listUnitsSample = `cron.service                          loaded    active   running Regular background program processing daemon
getty@tty1.service                    loaded    active   running Getty on tty1
networking.service                    loaded    active   exited  Raise network interfaces
nginx.service                         loaded    active   running A high performance web server and a reverse proxy server
snapd.service                         loaded    inactive dead    Snap Daemon
ssh.service                           loaded    active   running OpenBSD Secure Shell server
● systemd-vconsole-setup.service      not-found inactive dead    systemd-vconsole-setup.service
x nvidia-fallback.service             not-found inactive dead    nvidia-fallback.service
`

func TestParseListUnits(t *testing.T) {
	services := parseListUnits(listUnitsSample)
	if len(services) != 8 {
		t.Fatalf("expected 8 services, got %d", len(services))
	}

	nginx := services[3]
	if nginx.Name != "nginx.service" || nginx.LoadState != "loaded" || nginx.ActiveState != "active" || nginx.SubState != "running" {
		t.Errorf("nginx = %+v", nginx)
	}
	if nginx.Description != "A high performance web server and a reverse proxy server" {
		t.Errorf("nginx description = %q", nginx.Description)
	}

	if got := services[1].Name; got != "getty@tty1.service" {
		t.Errorf("template instance name = %q", got)
	}

	// Marker columns ("●"/"x") on not-found units must be stripped.
	vconsole := services[6]
	if vconsole.Name != "systemd-vconsole-setup.service" || vconsole.LoadState != "not-found" {
		t.Errorf("marker-prefixed unit = %+v", vconsole)
	}
	nvidia := services[7]
	if nvidia.Name != "nvidia-fallback.service" || nvidia.LoadState != "not-found" || nvidia.SubState != "dead" {
		t.Errorf("x-prefixed unit = %+v", nvidia)
	}
}

func TestParseListUnitsEmptyAndShortLines(t *testing.T) {
	if got := parseListUnits(""); len(got) != 0 {
		t.Fatalf("empty output produced %d services", len(got))
	}
	if got := parseListUnits("\n  \nfoo.service loaded\n"); len(got) != 0 {
		t.Fatalf("short lines produced %d services", len(got))
	}
}

const unitFilesSample = `cron.service                    enabled enabled
getty@.service                  static  -
nginx.service                   disabled disabled
ssh.service                     enabled enabled
systemd-fsck-root.service       static  -
udev.service                    masked  -
junk-line
`

func TestParseUnitFilesAndMergeEnabled(t *testing.T) {
	states := parseUnitFiles(unitFilesSample)
	if states["cron.service"] != "enabled" || states["nginx.service"] != "disabled" || states["getty@.service"] != "static" {
		t.Fatalf("parseUnitFiles = %v", states)
	}
	if states["udev.service"] != "masked" {
		t.Errorf("udev state = %q", states["udev.service"])
	}
	// A line without a state column is skipped, not misparsed.
	if _, ok := states["junk-line"]; ok {
		t.Fatal("stateless line should be skipped")
	}

	services := parseListUnits(listUnitsSample)
	mergeEnabled(services, states)
	byName := map[string]string{}
	for _, s := range services {
		byName[s.Name] = s.Enabled
	}
	if byName["cron.service"] != "enabled" {
		t.Errorf("cron enabled = %q", byName["cron.service"])
	}
	if byName["nginx.service"] != "disabled" {
		t.Errorf("nginx enabled = %q", byName["nginx.service"])
	}
	// Template instances fall back to their template's unit file.
	if byName["getty@tty1.service"] != "static" {
		t.Errorf("getty@tty1 enabled = %q", byName["getty@tty1.service"])
	}
	// Units without a unit file stay unknown.
	if byName["systemd-vconsole-setup.service"] != "" {
		t.Errorf("not-found unit enabled = %q", byName["systemd-vconsole-setup.service"])
	}
}

func TestParseAndMergeResourceUsage(t *testing.T) {
	usage := parseResourceUsage(`nginx.service 1.5 10240
nginx.service 0.7 5120
ssh.service 0.1 2048
- 99.0 9999
bad.service nope 10`)
	nginx := usage["nginx.service"]
	if nginx.cpuPercent != 2.2 || nginx.memoryBytes != 15*1024*1024 {
		t.Fatalf("nginx usage = %+v", nginx)
	}
	services := []types.ServiceInfo{{Name: "nginx.service"}, {Name: "cron.service"}}
	mergeResourceUsage(services, usage)
	if services[0].CPUPercent != 2.2 || services[0].MemoryBytes != 15*1024*1024 {
		t.Fatalf("merged nginx = %+v", services[0])
	}
	if services[1].CPUPercent != 0 || services[1].MemoryBytes != 0 {
		t.Fatalf("missing usage should stay zero: %+v", services[1])
	}
}

func TestSanitizeUnit(t *testing.T) {
	tests := []struct {
		name    string
		unit    string
		wantErr bool
	}{
		{"simple", "nginx.service", false},
		{"no suffix", "nginx", false},
		{"template instance", "getty@tty1.service", false},
		{"dashes and dots", "systemd-networkd.service", false},
		{"colon", "postfix@-.service:x", false},
		{"empty", "", true},
		{"space", "nginx .service", true},
		{"shell injection semicolon", "nginx;reboot", true},
		{"shell injection dollar", "nginx$(id)", true},
		{"shell injection backtick", "nginx`id`", true},
		{"slash", "../nginx", true},
		{"too long", string(make([]byte, 257)), true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := sanitizeUnit(tt.unit)
			if (err != nil) != tt.wantErr {
				t.Errorf("sanitizeUnit(%q) error = %v, wantErr %v", tt.unit, err, tt.wantErr)
			}
		})
	}
}

func TestClampLogLines(t *testing.T) {
	tests := []struct {
		in   int
		want int
	}{
		{0, 300},
		{-5, 300},
		{1, 1},
		{500, 500},
		{100000, 100000},
		{100001, 100000},
	}
	for _, tt := range tests {
		if got := clampLogLines(tt.in); got != tt.want {
			t.Errorf("clampLogLines(%d) = %d, want %d", tt.in, got, tt.want)
		}
	}
}

func TestServiceActionValidation(t *testing.T) {
	m := NewManager(nil)
	// All of these must fail before any remote command is attempted (the nil
	// ssh manager would panic otherwise).
	if err := m.ServiceAction("s", "nginx;id", "stop", false); err == nil {
		t.Fatal("injection in unit name accepted")
	}
	if err := m.ServiceAction("s", "nginx.service", "mask", false); err == nil {
		t.Fatal("non-whitelisted action accepted")
	}
	for _, unit := range []string{"ssh", "sshd.service", "NetworkManager", "systemd-networkd.service", "networking"} {
		if err := m.ServiceAction("s", unit, "stop", false); err == nil {
			t.Fatalf("stopping critical unit %q without force accepted", unit)
		}
		if err := m.ServiceAction("s", unit, "disable", false); err == nil {
			t.Fatalf("disabling critical unit %q without force accepted", unit)
		}
	}
	// Non-destructive actions on critical units need no force gate.
	if !isCriticalUnit("ssh.service") || isCriticalUnit("nginx.service") {
		t.Fatal("isCriticalUnit misclassifies units")
	}
}

func TestLogStreamReplacementAndExactStop(t *testing.T) {
	m := NewManager(nil)
	var firstCancelled atomic.Int32
	var secondCancelled atomic.Int32
	first := &logStream{id: "first", key: "session:unit", cancel: func() { firstCancelled.Add(1) }}
	second := &logStream{id: "second", key: "session:unit", cancel: func() { secondCancelled.Add(1) }}

	if err := m.activateLogStream(first); err != nil {
		t.Fatal(err)
	}
	if err := m.activateLogStream(second); err != nil {
		t.Fatal(err)
	}
	if got := firstCancelled.Load(); got != 1 {
		t.Fatalf("replaced stream cancel count = %d, want 1", got)
	}

	// A stale UI stop names the old stream and must not affect its successor.
	m.StopServiceLogs("first")
	if got := secondCancelled.Load(); got != 0 {
		t.Fatalf("stale stop cancelled replacement %d times", got)
	}
	if m.logStreams["second"] != second {
		t.Fatal("replacement stream is no longer active")
	}

	m.StopServiceLogs("second")
	if got := secondCancelled.Load(); got != 1 {
		t.Fatalf("exact stop cancel count = %d, want 1", got)
	}
	if len(m.logStreams) != 0 || len(m.logByKey) != 0 {
		t.Fatalf("stream indexes not cleaned up: streams=%d keys=%d", len(m.logStreams), len(m.logByKey))
	}
}
