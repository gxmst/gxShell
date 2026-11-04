// Package networkproxy owns the application's outbound proxy policy. Local
// control traffic and local services always remain direct.
package networkproxy

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/http/httpproxy"
	"golang.org/x/net/proxy"
	"gxShell/backend/types"
)

type Resolver func(*http.Request) (*url.URL, error)

type state struct {
	ssh       bool
	resolve   Resolver
	transport *http.Transport
}

type Manager struct {
	mu     sync.RWMutex
	state  *state
	system Resolver
}

func New() *Manager {
	m := &Manager{system: systemProxy}
	_ = m.Apply(types.ProxySettings{Mode: "system"})
	return m
}

func Normalize(settings types.ProxySettings) types.ProxySettings {
	settings.Mode = strings.ToLower(strings.TrimSpace(settings.Mode))
	if settings.Mode == "" {
		settings.Mode = "system"
	}
	settings.URL = strings.TrimSpace(settings.URL)
	settings.Bypass = strings.TrimSpace(settings.Bypass)
	return settings
}

func Validate(settings types.ProxySettings) error {
	settings = Normalize(settings)
	switch settings.Mode {
	case "system", "direct", "manual":
	default:
		return fmt.Errorf("proxy mode must be system, direct or manual")
	}
	if len(settings.URL) > 4096 || len(settings.Bypass) > 4096 || strings.ContainsAny(settings.URL+settings.Bypass, "\r\n\x00") {
		return fmt.Errorf("invalid proxy address or bypass list")
	}
	if settings.Mode != "manual" {
		return nil
	}
	u, err := url.Parse(settings.URL)
	if err != nil {
		return fmt.Errorf("invalid proxy URL")
	}
	switch u.Scheme {
	case "http", "https", "socks5", "socks5h":
	default:
		return fmt.Errorf("proxy URL must start with http://, https:// or socks5://")
	}
	if u.User != nil {
		return fmt.Errorf("proxy credentials in URLs are not supported; use a local proxy without authentication")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 || u.Hostname() == "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("proxy URL requires a host and port, without a path, query or fragment")
	}
	return nil
}

func IsLocal(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(strings.Trim(host, "[]")), ".")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback() || ip.IsUnspecified()
	}
	return false
}

func (m *Manager) Apply(settings types.ProxySettings) error {
	settings = Normalize(settings)
	if err := Validate(settings); err != nil {
		return err
	}
	var resolve Resolver
	switch settings.Mode {
	case "direct":
		resolve = func(*http.Request) (*url.URL, error) { return nil, nil }
	case "manual":
		cfg := httpproxy.Config{HTTPProxy: settings.URL, HTTPSProxy: settings.URL, NoProxy: strings.ReplaceAll(settings.Bypass, ";", ",")}
		fn := cfg.ProxyFunc()
		resolve = func(req *http.Request) (*url.URL, error) { return fn(req.URL) }
		baseResolve := resolve
		resolve = func(req *http.Request) (*url.URL, error) {
			for _, entry := range strings.FieldsFunc(settings.Bypass, func(r rune) bool { return r == ',' || r == ';' }) {
				if strings.EqualFold(strings.TrimSpace(entry), "<local>") && !strings.Contains(req.URL.Hostname(), ".") {
					return nil, nil
				}
			}
			return baseResolve(req)
		}
	default:
		resolve = m.system
	}
	m.install(resolve, settings.SSH)
	return nil
}

// Block rejects external traffic for an invalid saved policy rather than
// silently falling back to a different route. Local services stay available.
func (m *Manager) Block(message string) {
	m.install(func(*http.Request) (*url.URL, error) { return nil, fmt.Errorf("%s", message) }, true)
}

func (m *Manager) install(baseResolve Resolver, ssh bool) {
	resolve := baseResolve
	resolve = func(req *http.Request) (*url.URL, error) {
		if IsLocal(req.URL.Hostname()) {
			return nil, nil
		}
		return baseResolve(req)
	}
	transport := &http.Transport{
		Proxy: resolve, DialContext: (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2: true, MaxIdleConns: 100, IdleConnTimeout: 90 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second, ExpectContinueTimeout: time.Second,
	}
	m.mu.Lock()
	previous := m.state
	m.state = &state{resolve: resolve, transport: transport, ssh: ssh}
	m.mu.Unlock()
	if previous != nil {
		previous.transport.CloseIdleConnections()
	}
}

func (m *Manager) snapshot() *state { m.mu.RLock(); defer m.mu.RUnlock(); return m.state }
func (m *Manager) RoundTrip(req *http.Request) (*http.Response, error) {
	return m.snapshot().transport.RoundTrip(req)
}
func (m *Manager) CloseIdleConnections() { m.snapshot().transport.CloseIdleConnections() }

// DialContext applies the same policy to the first SSH hop. CONNECT preserves
// the target hostname, and SOCKS5 resolves it at the proxy.
func (m *Manager) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if network != "tcp" && network != "tcp4" && network != "tcp6" {
		return nil, fmt.Errorf("proxy supports TCP only")
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	current := m.snapshot()
	if !current.ssh || IsLocal(host) {
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}
	req := (&http.Request{Method: http.MethodGet, URL: &url.URL{Scheme: "https", Host: address}}).WithContext(ctx)
	u, err := current.resolve(req)
	if err != nil {
		return nil, err
	}
	if u == nil || IsLocal(host) {
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}
	if u.Scheme == "socks5" || u.Scheme == "socks5h" {
		dialer, err := proxy.FromURL(u, &net.Dialer{})
		if err != nil {
			return nil, err
		}
		return dialer.(proxy.ContextDialer).DialContext(ctx, network, address)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("unsupported proxy protocol")
	}
	proxyAddress := u.Host
	if u.Port() == "" {
		port := "80"
		if u.Scheme == "https" {
			port = "443"
		}
		proxyAddress = net.JoinHostPort(u.Hostname(), port)
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", proxyAddress)
	if err != nil {
		return nil, err
	}
	pendingConn := conn
	stop := context.AfterFunc(ctx, func() { _ = pendingConn.Close() })
	defer stop()
	success := false
	defer func() {
		if !success {
			_ = conn.Close()
		}
	}()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	if u.Scheme == "https" {
		tlsConn := tls.Client(conn, &tls.Config{ServerName: u.Hostname(), MinVersion: tls.VersionTLS12})
		if err = tlsConn.HandshakeContext(ctx); err != nil {
			return nil, err
		}
		conn = tlsConn
	}
	connect := &http.Request{Method: http.MethodConnect, URL: &url.URL{Opaque: address}, Host: address, Header: make(http.Header)}
	if err = connect.Write(conn); err != nil {
		return nil, err
	}
	reader := bufio.NewReader(conn)
	var headers bytes.Buffer
	lineLength := 0
	for {
		line, err := reader.ReadSlice('\n')
		if len(line)+headers.Len() > 32<<10 {
			return nil, fmt.Errorf("proxy CONNECT headers exceed 32 KiB")
		}
		headers.Write(line)
		lineLength += len(line)
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			return nil, err
		}
		if lineLength == 1 || (lineLength == 2 && bytes.Equal(line, []byte("\r\n"))) {
			break
		}
		lineLength = 0
	}
	response, err := http.ReadResponse(bufio.NewReader(bytes.NewReader(headers.Bytes())), connect)
	if err != nil {
		return nil, fmt.Errorf("invalid proxy CONNECT response")
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("proxy CONNECT rejected (HTTP %d)", response.StatusCode)
	}
	stop()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	_ = conn.SetDeadline(time.Time{})
	success = true
	return &bufferedConn{Conn: conn, reader: reader}, nil
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) { return c.reader.Read(p) }
