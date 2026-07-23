package tunnel

import (
	"io"
	"net"
	"testing"
	"time"
)

// runNegotiate drives negotiateSOCKS on one end of a pipe while the test
// script writes to the other, returning the negotiated target.
func runNegotiate(t *testing.T, script func(c net.Conn)) (string, bool) {
	t.Helper()
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()

	type result struct {
		target string
		ok     bool
	}
	done := make(chan result, 1)
	go func() {
		target, ok := negotiateSOCKS(server)
		done <- result{target, ok}
	}()
	script(client)
	select {
	case r := <-done:
		return r.target, r.ok
	case <-time.After(2 * time.Second):
		t.Fatal("negotiateSOCKS did not return")
		return "", false
	}
}

func mustRead(t *testing.T, c net.Conn, n int) []byte {
	t.Helper()
	buf := make([]byte, n)
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatalf("read reply: %v", err)
	}
	return buf
}

// The handshake must survive arbitrary TCP segmentation: here every field —
// and even the domain name itself — arrives in separate writes.
func TestNegotiateSOCKSFragmented(t *testing.T) {
	target, ok := runNegotiate(t, func(c net.Conn) {
		c.Write([]byte{0x05})       // VER alone
		c.Write([]byte{0x01})       // NMETHODS alone
		c.Write([]byte{0x00})       // METHODS
		mustRead(t, c, 2)           // server method choice
		c.Write([]byte{0x05, 0x01}) // VER CMD split from the rest
		c.Write([]byte{0x00, 0x03}) // RSV ATYP
		c.Write([]byte{0x0b})       // domain length 11
		c.Write([]byte("example"))  // first half of the name
		c.Write([]byte(".com"))     // second half
		c.Write([]byte{0x00})       // port high byte
		c.Write([]byte{0x50})       // port low byte
	})
	if !ok {
		t.Fatal("handshake failed")
	}
	if target != "example.com:80" {
		t.Fatalf("target = %q, want example.com:80", target)
	}
}

func TestNegotiateSOCKSIPv4(t *testing.T) {
	target, ok := runNegotiate(t, func(c net.Conn) {
		c.Write([]byte{0x05, 0x01, 0x00})
		mustRead(t, c, 2)
		c.Write([]byte{0x05, 0x01, 0x00, 0x01, 10, 0, 0, 1, 0x1f, 0x90})
	})
	if !ok {
		t.Fatal("handshake failed")
	}
	if target != "10.0.0.1:8080" {
		t.Fatalf("target = %q, want 10.0.0.1:8080", target)
	}
}

func TestNegotiateSOCKSRejectsNonConnect(t *testing.T) {
	_, ok := runNegotiate(t, func(c net.Conn) {
		c.Write([]byte{0x05, 0x01, 0x00})
		mustRead(t, c, 2)
		// negotiateSOCKS rejects unsupported commands as soon as it has the
		// request header. net.Pipe has no buffering, so writing the unused
		// address bytes here would deadlock with the server's error reply.
		c.Write([]byte{0x05, 0x02, 0x00, 0x01}) // BIND
		mustRead(t, c, 10)                      // error reply
	})
	if ok {
		t.Fatal("BIND command must be rejected")
	}
}

func TestNegotiateSOCKSRejectsWrongVersion(t *testing.T) {
	_, ok := runNegotiate(t, func(c net.Conn) {
		c.Write([]byte{0x04, 0x01}) // SOCKS4
	})
	if ok {
		t.Fatal("non-SOCKS5 greeting must be rejected")
	}
}

// resolveAddr / resolveDialAddr behavior is load-bearing for rule parsing.
func TestResolveAddr(t *testing.T) {
	cases := []struct {
		addr, bind, def, want string
	}{
		{"8080", "", "127.0.0.1", "127.0.0.1:8080"},
		{"8080", "0.0.0.0", "127.0.0.1", "0.0.0.0:8080"},
		{"192.168.1.5:8080", "ignored", "127.0.0.1", "192.168.1.5:8080"},
	}
	for _, tc := range cases {
		if got := resolveAddr(tc.addr, tc.bind, tc.def); got != tc.want {
			t.Errorf("resolveAddr(%q,%q,%q) = %q, want %q", tc.addr, tc.bind, tc.def, got, tc.want)
		}
	}
}
