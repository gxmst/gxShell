package network

import (
	"testing"

	"gxShell/backend/types"
)

func TestParseRTTs(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  int
	}{
		{"single rtt", "1.234 ms", 1},
		{"multiple rtts", "1.234 ms 2.345 ms 3.456 ms", 3},
		{"no rtts", "no timing info", 0},
		{"mixed", "1.234 ms some text 5.678 ms", 2},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseRTTs(tt.input)
			if len(got) != tt.want {
				t.Errorf("parseRTTs(%q) returned %d values, want %d", tt.input, len(got), tt.want)
			}
		})
	}
}

func TestParseTracerouteLinux(t *testing.T) {
	out := `traceroute to google.com (8.8.8.8), 30 hops max
 1  192.168.1.1  1.234 ms  1.123 ms  1.345 ms
 2  10.0.0.1  5.678 ms  5.432 ms  5.890 ms
 3  * * *`

	hops := parseTraceroute(out)
	if len(hops) != 3 {
		t.Fatalf("expected 3 hops, got %d", len(hops))
	}

	if hops[0].IP != "192.168.1.1" {
		t.Errorf("hop 0 IP = %q, want %q", hops[0].IP, "192.168.1.1")
	}
	if hops[0].RTT1 != 1.234 {
		t.Errorf("hop 0 RTT1 = %f, want %f", hops[0].RTT1, 1.234)
	}

	if hops[2].IP != "" || hops[2].RTT1 != 0 {
		t.Errorf("hop 2 should be timeout, got IP=%q RTT1=%f", hops[2].IP, hops[2].RTT1)
	}
}

func TestParseTracerouteTracepath(t *testing.T) {
	out := `tracepath to 8.8.8.8
 1: 192.168.1.1  1.234 ms
 2: 10.0.0.1  5.678 ms`

	hops := parseTraceroute(out)
	if len(hops) != 2 {
		t.Fatalf("expected 2 hops, got %d", len(hops))
	}
	if hops[0].IP != "192.168.1.1" {
		t.Errorf("hop 0 IP = %q, want %q", hops[0].IP, "192.168.1.1")
	}
}

func TestTruncate(t *testing.T) {
	tests := []struct {
		name   string
		input  string
		maxLen int
		want   string
	}{
		{"short", "hello", 10, "hello"},
		{"exact", "hello", 5, "hello"},
		{"long", "hello world", 5, "hello..."},
		{"empty", "", 5, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := truncate(tt.input, tt.maxLen)
			if got != tt.want {
				t.Errorf("truncate(%q, %d) = %q, want %q", tt.input, tt.maxLen, got, tt.want)
			}
		})
	}
}

func TestParseTracerouteEmpty(t *testing.T) {
	hops := parseTraceroute("")
	if len(hops) != 0 {
		t.Errorf("expected 0 hops for empty input, got %d", len(hops))
	}
}

func TestParseTracerouteHeaderOnly(t *testing.T) {
	out := "traceroute to google.com (8.8.8.8), 30 hops max\n"
	hops := parseTraceroute(out)
	if len(hops) != 0 {
		t.Errorf("expected 0 hops for header-only input, got %d", len(hops))
	}
}

func TestParseRTTsValues(t *testing.T) {
	rtts := parseRTTs("1.500 ms 2.750 ms 3.000 ms")
	if len(rtts) != 3 {
		t.Fatalf("expected 3 RTTs, got %d", len(rtts))
	}
	if rtts[0] != 1.5 {
		t.Errorf("RTT[0] = %f, want 1.5", rtts[0])
	}
	if rtts[1] != 2.75 {
		t.Errorf("RTT[1] = %f, want 2.75", rtts[1])
	}
	if rtts[2] != 3.0 {
		t.Errorf("RTT[2] = %f, want 3.0", rtts[2])
	}
}

func TestParseTracerouteMTR(t *testing.T) {
	out := `HOST: localhost Loss%   Snt   Last   Avg  Best  Wrst
  1.|-- 192.168.1.1  0.0%    10   1.2   1.5   0.8   3.0
  2.|-- 10.0.0.1     5.0%    10   5.6   6.0   4.0   8.0`

	hops := parseTraceroute(out)
	if len(hops) != 2 {
		t.Fatalf("expected 2 hops, got %d", len(hops))
	}
	if hops[0].IP != "192.168.1.1" {
		t.Errorf("hop 0 IP = %q, want %q", hops[0].IP, "192.168.1.1")
	}
	if hops[0].Loss != 0.0 {
		t.Errorf("hop 0 Loss = %f, want 0.0", hops[0].Loss)
	}
	if hops[1].Loss != 5.0 {
		t.Errorf("hop 1 Loss = %f, want 5.0", hops[1].Loss)
	}
}

func init() {
	_ = types.NetworkHop{}
}
