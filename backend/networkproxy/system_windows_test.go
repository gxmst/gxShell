package networkproxy

import (
	"net/url"
	"testing"
)

func TestWindowsStaticProxySelectionAndBypass(t *testing.T) {
	for _, tc := range []struct{ raw, bypass, target, want string }{
		{"http=proxy.test:8080;https=secure.test:8443", "", "https://remote.test", "http://secure.test:8443"},
		{"proxy.test:8080", "*.example.com", "https://api.example.com", ""},
		{"proxy.test:8080", "<local>;10.0.0.0/8", "https://intranet", ""},
		{"socks=proxy.test:1080", "", "https://remote.test", "socks5://proxy.test:1080"},
	} {
		target, _ := url.Parse(tc.target)
		u, err := staticSystemProxy(tc.raw, tc.bypass, target)
		if err != nil {
			t.Fatal(err)
		}
		got := ""
		if u != nil {
			got = u.String()
		}
		if got != tc.want {
			t.Fatalf("got %s, want %s", got, tc.want)
		}
	}
}
