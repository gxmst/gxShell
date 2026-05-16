package monitor

import (
	"testing"

	"gxShell/backend/types"
)

func TestSection(t *testing.T) {
	input := `GX_BEGIN_UPTIME_9b7c2d
10:30:00 up 5 days
GX_END_UPTIME_9b7c2d
GX_BEGIN_LOAD_9b7c2d
0.50 0.40 0.30
GX_END_LOAD_9b7c2d`

	got := section(input, "UPTIME")
	want := "10:30:00 up 5 days"
	if got != want {
		t.Errorf("section(UPTIME) = %q, want %q", got, want)
	}

	gotLoad := section(input, "LOAD")
	wantLoad := "0.50 0.40 0.30"
	if gotLoad != wantLoad {
		t.Errorf("section(LOAD) = %q, want %q", gotLoad, wantLoad)
	}

	gotMissing := section(input, "MISSING")
	if gotMissing != "" {
		t.Errorf("section(MISSING) = %q, want empty", gotMissing)
	}
}

func TestParseMem(t *testing.T) {
	text := `MemTotal:       16384000 kB
MemAvailable:    8192000 kB
SwapTotal:       4096000 kB
SwapFree:        2048000 kB`

	var m types.Metrics
	parseMem(text, &m)

	if m.MemoryTotalMB != 16000 {
		t.Errorf("MemoryTotalMB = %d, want 16000", m.MemoryTotalMB)
	}
	if m.MemoryUsedMB != 8000 {
		t.Errorf("MemoryUsedMB = %d, want 8000", m.MemoryUsedMB)
	}
	if m.SwapTotalMB != 4000 {
		t.Errorf("SwapTotalMB = %d, want 4000", m.SwapTotalMB)
	}
	if m.SwapUsedMB != 2000 {
		t.Errorf("SwapUsedMB = %d, want 2000", m.SwapUsedMB)
	}
}

func TestParseCPU(t *testing.T) {
	text := "cpu  100 200 300 400 500 600"
	sample, ok := parseCPU(text)
	if !ok {
		t.Fatal("parseCPU returned false")
	}
	if sample.idle != 400 {
		t.Errorf("idle = %d, want 400", sample.idle)
	}
	if sample.total != 2100 {
		t.Errorf("total = %d, want 2100", sample.total)
	}

	_, ok = parseCPU("invalid")
	if ok {
		t.Error("parseCPU should return false for invalid input")
	}

	_, ok = parseCPU("cpu 100")
	if ok {
		t.Error("parseCPU should return false for insufficient fields")
	}
}

func TestParseNet(t *testing.T) {
	text := `eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0
lo: 500 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0`

	sample, ok := parseNet(text, "")
	if !ok {
		t.Fatal("parseNet returned false")
	}
	if sample.rx != 1000 {
		t.Errorf("rx = %d, want 1000", sample.rx)
	}
	if sample.tx != 2000 {
		t.Errorf("tx = %d, want 2000", sample.tx)
	}
}

func TestParseNetDefaultIface(t *testing.T) {
	text := `eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0
eth1: 500 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0`

	sample, _ := parseNet(text, "eth1")
	if sample.rx != 500 {
		t.Errorf("rx = %d, want 500 (only eth1)", sample.rx)
	}
}

func TestShouldIgnoreInterface(t *testing.T) {
	tests := []struct {
		iface string
		want  bool
	}{
		{"lo", true},
		{"docker0", true},
		{"br-abc", true},
		{"veth123", true},
		{"tun0", true},
		{"wg0", true},
		{"eth0", false},
		{"ens33", false},
		{"wlan0", false},
	}

	for _, tt := range tests {
		got := shouldIgnoreInterface(tt.iface)
		if got != tt.want {
			t.Errorf("shouldIgnoreInterface(%q) = %v, want %v", tt.iface, got, tt.want)
		}
	}
}

func TestParseProcesses(t *testing.T) {
	text := `USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
root         1  0.5  1.2 123456 78900 ?        Ss   10:00   0:05 /sbin/init
user      1234  2.5  3.8 234567 89012 ?        Sl   10:01   0:30 node app.js`

	procs := parseProcesses(text)
	if len(procs) != 2 {
		t.Fatalf("expected 2 processes, got %d", len(procs))
	}
	if procs[0].User != "root" {
		t.Errorf("procs[0].User = %q, want %q", procs[0].User, "root")
	}
	if procs[0].CPU != 0.5 {
		t.Errorf("procs[0].CPU = %f, want 0.5", procs[0].CPU)
	}
	if procs[1].Command != "node app.js" {
		t.Errorf("procs[1].Command = %q, want %q", procs[1].Command, "node app.js")
	}
}

func TestParseProcessesEmpty(t *testing.T) {
	procs := parseProcesses("")
	if len(procs) != 0 {
		t.Errorf("expected 0 processes for empty input, got %d", len(procs))
	}
}

func TestParseMetrics(t *testing.T) {
	out := `GX_BEGIN_UPTIME_9b7c2d
10:30:00 up 5 days
GX_END_UPTIME_9b7c2d
GX_BEGIN_LOAD_9b7c2d
0.50 0.40 0.30
GX_END_LOAD_9b7c2d
GX_BEGIN_MEM_9b7c2d
MemTotal:       16384000 kB
MemAvailable:    8192000 kB
SwapTotal:       4096000 kB
SwapFree:        2048000 kB
GX_END_MEM_9b7c2d
GX_BEGIN_DISK_9b7c2d
/dev/sda1       50000000 20000000 30000000  40% /
GX_END_DISK_9b7c2d
GX_BEGIN_PROC_9b7c2d
USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
root         1  0.5  1.2 123456 78900 ?        Ss   10:00   0:05 /sbin/init
GX_END_PROC_9b7c2d`

	m := parseMetrics("test-session", out)
	if m.SessionID != "test-session" {
		t.Errorf("SessionID = %q, want %q", m.SessionID, "test-session")
	}
	if m.Uptime != "10:30:00 up 5 days" {
		t.Errorf("Uptime = %q, want %q", m.Uptime, "10:30:00 up 5 days")
	}
	if m.LoadAverage != "0.50 0.40 0.30" {
		t.Errorf("LoadAverage = %q, want %q", m.LoadAverage, "0.50 0.40 0.30")
	}
	if m.MemoryTotalMB != 16000 {
		t.Errorf("MemoryTotalMB = %d, want 16000", m.MemoryTotalMB)
	}
}
