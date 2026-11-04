package networkproxy

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"gxShell/backend/types"
)

func TestRoutingModesAndLocalBypass(t *testing.T) {
	m := New()
	systemURL, _ := url.Parse("http://system-proxy.test:8080")
	m.system = func(*http.Request) (*url.URL, error) { return systemURL, nil }
	for _, tc := range []struct {
		settings     types.ProxySettings
		target, want string
	}{
		{types.ProxySettings{Mode: "system"}, "https://remote.test", "http://system-proxy.test:8080"},
		{types.ProxySettings{Mode: "direct"}, "https://remote.test", ""},
		{types.ProxySettings{Mode: "manual", URL: "socks5://127.0.0.1:1080"}, "https://remote.test", "socks5://127.0.0.1:1080"},
		{types.ProxySettings{Mode: "manual", URL: "http://127.0.0.1:7890", Bypass: ".example.com,10.0.0.0/8,<local>"}, "https://app.example.com", ""},
		{types.ProxySettings{Mode: "manual", URL: "http://127.0.0.1:7890", Bypass: "10.0.0.0/8"}, "https://10.2.3.4", ""},
		{types.ProxySettings{Mode: "manual", URL: "http://127.0.0.1:7890", Bypass: "<local>"}, "https://intranet", ""},
		{types.ProxySettings{Mode: "manual", URL: "http://127.0.0.1:7890"}, "http://127.0.0.1:56789/mcp", ""},
		{types.ProxySettings{Mode: "system"}, "http://[::1]:11434", ""},
		{types.ProxySettings{Mode: "system"}, "http://localhost.:11434", ""},
	} {
		if err := m.Apply(tc.settings); err != nil {
			t.Fatal(err)
		}
		req, _ := http.NewRequest("GET", tc.target, nil)
		got, err := m.snapshot().resolve(req)
		if err != nil {
			t.Fatal(err)
		}
		text := ""
		if got != nil {
			text = got.String()
		}
		if text != tc.want {
			t.Fatalf("%s %s: got %s, want %s", tc.settings.Mode, tc.target, text, tc.want)
		}
	}
}

func TestHTTPManualProxyAndLocalService(t *testing.T) {
	var hits atomic.Int32
	proxyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Host != "remote.invalid" {
			t.Errorf("target=%s", r.URL)
		}
		fmt.Fprint(w, "proxied")
	}))
	defer proxyServer.Close()
	m := New()
	defer m.CloseIdleConnections()
	if err := m.Apply(types.ProxySettings{Mode: "manual", URL: proxyServer.URL}); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: m, Timeout: 2 * time.Second}
	resp, err := client.Get("http://remote.invalid/models")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "proxied" || hits.Load() != 1 {
		t.Fatal("HTTP request did not use proxy")
	}
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "local") }))
	defer local.Close()
	resp, err = client.Get(local.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "local" || hits.Load() != 1 {
		t.Fatal("local traffic reached proxy")
	}
}

func startTestProxy(t *testing.T, handle func(net.Conn)) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			defer conn.Close()
			handle(conn)
		}
	}()
	return ln.Addr().String()
}

func TestCONNECTPreservesBufferedSSHBanner(t *testing.T) {
	address := startTestProxy(t, func(conn net.Conn) {
		req, err := http.ReadRequest(bufio.NewReader(conn))
		if err != nil {
			t.Error(err)
			return
		}
		if req.Method != "CONNECT" || req.Host != "remote.invalid:22" {
			t.Errorf("request=%s %s", req.Method, req.Host)
		}
		fmt.Fprint(conn, "HTTP/1.1 200 Connection Established\r\n\r\nSSH-2.0-test\r\n")
	})
	m := New()
	if err := m.Apply(types.ProxySettings{Mode: "manual", URL: "http://" + address, SSH: true}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, err := m.DialContext(ctx, "tcp", "remote.invalid:22")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	banner, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || banner != "SSH-2.0-test\r\n" {
		t.Fatalf("banner=%q err=%v", banner, err)
	}
}

func TestCONNECTCancellationAndOversizedHeaders(t *testing.T) {
	for _, large := range []bool{false, true} {
		address := startTestProxy(t, func(conn net.Conn) {
			_, _ = http.ReadRequest(bufio.NewReader(conn))
			if large {
				fmt.Fprint(conn, "HTTP/1.1 200 OK\r\nX-Fill: "+strings.Repeat("x", 40<<10))
				return
			}
			_, _ = io.Copy(io.Discard, conn)
		})
		m := New()
		_ = m.Apply(types.ProxySettings{Mode: "manual", URL: "http://" + address, SSH: true})
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		started := time.Now()
		conn, err := m.DialContext(ctx, "tcp", "remote.invalid:22")
		cancel()
		if conn != nil {
			conn.Close()
		}
		if err == nil || time.Since(started) > time.Second {
			t.Fatalf("large=%v err=%v", large, err)
		}
	}
}

func TestSOCKS5PreservesTargetHostname(t *testing.T) {
	address := startTestProxy(t, func(conn net.Conn) {
		reader := bufio.NewReader(conn)
		greeting := make([]byte, 2)
		io.ReadFull(reader, greeting)
		methods := make([]byte, int(greeting[1]))
		io.ReadFull(reader, methods)
		conn.Write([]byte{5, 0})
		header := make([]byte, 5)
		io.ReadFull(reader, header)
		if header[3] != 3 {
			t.Errorf("SOCKS resolved locally: %v", header)
			return
		}
		name := make([]byte, int(header[4]))
		io.ReadFull(reader, name)
		port := make([]byte, 2)
		io.ReadFull(reader, port)
		if string(name) != "remote.invalid" || port[1] != 22 {
			t.Errorf("target=%s port=%v", name, port)
		}
		conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 22})
		fmt.Fprint(conn, "SSH-2.0-socks\r\n")
	})
	m := New()
	_ = m.Apply(types.ProxySettings{Mode: "manual", URL: "socks5://" + address, SSH: true})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, err := m.DialContext(ctx, "tcp", "remote.invalid:22")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	banner, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || banner != "SSH-2.0-socks\r\n" {
		t.Fatalf("banner=%q error=%v", banner, err)
	}
}

func TestInvalidPolicyDoesNotReplaceCurrentRoute(t *testing.T) {
	m := New()
	_ = m.Apply(types.ProxySettings{Mode: "manual", URL: "http://127.0.0.1:7890"})
	for _, settings := range []types.ProxySettings{
		{Mode: "invalid"}, {Mode: "manual", URL: "http://user:secret@proxy.test:8080"},
		{Mode: "manual", URL: "http://proxy.test"}, {Mode: "manual", URL: "http://proxy.test:8080/path"},
	} {
		if err := m.Apply(settings); err == nil {
			t.Fatalf("accepted %#v", settings)
		}
	}
	req, _ := http.NewRequest("GET", "https://remote.test", nil)
	u, err := m.snapshot().resolve(req)
	if err != nil || u.String() != "http://127.0.0.1:7890" {
		t.Fatal("invalid save replaced routing policy")
	}
	m.Block("invalid configuration")
	if _, err = m.snapshot().resolve(req); err == nil {
		t.Fatal("invalid saved policy fell back to direct")
	}
}

func TestSSHProxyRequiresOptIn(t *testing.T) {
	m := New()
	var resolved bool
	m.system = func(*http.Request) (*url.URL, error) {
		resolved = true
		return nil, fmt.Errorf("proxy resolver called")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, enabled := range []bool{false, true} {
		resolved = false
		if err := m.Apply(types.ProxySettings{Mode: "system", SSH: enabled}); err != nil {
			t.Fatal(err)
		}
		conn, err := m.DialContext(ctx, "tcp", "remote.invalid:22")
		if conn != nil {
			conn.Close()
		}
		if err == nil || resolved != enabled {
			t.Fatalf("ssh=%v resolved=%v err=%v", enabled, resolved, err)
		}
	}
}
