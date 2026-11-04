//go:build !windows

package networkproxy

import (
	"net/http"
	"net/url"

	"golang.org/x/net/http/httpproxy"
)

func systemProxy(req *http.Request) (*url.URL, error) {
	return httpproxy.FromEnvironment().ProxyFunc()(req.URL)
}
