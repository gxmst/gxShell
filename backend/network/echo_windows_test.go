package network

import (
	"net/netip"
	"testing"
	"time"
)

func TestWindowsEchoLoopback(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "::1"} {
		state, rtt := Echo(netip.MustParseAddr(address), 2*time.Second)
		if state != "reply" || rtt < 0 || rtt > 2000 {
			t.Errorf("loopback %s: %s %.1fms", address, state, rtt)
		}
	}
}
