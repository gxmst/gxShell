package tunnel

import (
	"gxShell/backend/types"
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

func TestNegotiateSOCKSRejectsUnavailableAuthMethod(t *testing.T) {
	_, ok := runNegotiate(t, func(conn net.Conn) {
		conn.Write([]byte{5, 1, 2}) // Only username/password; server cannot provide it.
		reply := mustRead(t, conn, 2)
		if reply[1] != 0xff {
			t.Fatalf("server chose unoffered authentication: %v", reply)
		}
	})
	if ok {
		t.Fatal("authentication-only greeting accepted")
	}
}

func TestNegotiateSOCKSRejectsInvalidRequestFields(t *testing.T) {
	for _, request := range [][]byte{{5, 1, 1, 1}, {5, 1, 0, 3, 0}, {5, 1, 0, 1, 127, 0, 0, 1, 0, 0}} {
		_, ok := runNegotiate(t, func(conn net.Conn) { conn.Write([]byte{5, 1, 0}); mustRead(t, conn, 2); conn.Write(request) })
		if ok {
			t.Fatalf("invalid request accepted: %v", request)
		}
	}
}

func TestRemoveTunnelClosesAcceptedConnections(t *testing.T) {
	manager := NewManager(func(string, any) {})
	status := manager.AddTunnel("session", nil, types.TunnelRule{ID: "temporary", Type: types.TunnelDynamic, Local: "127.0.0.1:0"})
	if !status.Active {
		t.Fatal(status.Error)
	}
	defer manager.StopTunnels("session")
	manager.mu.Lock()
	fwd := manager.active["session"][0]
	manager.mu.Unlock()
	conn, err := net.Dial("tcp", status.Rule.Local)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	deadline := time.Now().Add(time.Second)
	for {
		fwd.mu.Lock()
		count := len(fwd.connections)
		fwd.mu.Unlock()
		if count == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("connection not accepted")
		}
		time.Sleep(time.Millisecond)
	}
	manager.RemoveTunnel("session", "temporary")
	conn.SetReadDeadline(time.Now().Add(time.Second))
	_, err = conn.Read(make([]byte, 1))
	if err == nil {
		t.Fatal("removed tunnel still connected")
	}
	if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("accepted connection survived tunnel removal")
	}
}

func TestForwardStopClosesBothSidesAndCancelsDial(t *testing.T) {
	fwd := newForward(types.TunnelRule{}, nil)
	a, peerA := net.Pipe()
	b, peerB := net.Pipe()
	defer peerA.Close()
	defer peerB.Close()
	fwd.track(a)
	fwd.track(b)
	fwd.stop()
	select {
	case <-fwd.ctx.Done():
	default:
		t.Fatal("dial context not cancelled")
	}
	for _, peer := range []net.Conn{peerA, peerB} {
		peer.SetReadDeadline(time.Now().Add(time.Second))
		_, err := peer.Read(make([]byte, 1))
		if err != io.EOF {
			t.Fatalf("connection not closed: %v", err)
		}
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
