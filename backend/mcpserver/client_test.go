package mcpserver

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCallersPreserveAuthFailuresAndRequestMetadata(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("missing token")
		}
		if r.Header.Get("X-GxShell-Request-ID") != "request-1" {
			t.Error("missing request ID")
		}
		w.Header().Set("X-GxShell-Request-ID", "request-1")
		w.Header().Set("X-GxShell-Request-Replayed", "true")
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `{"outcome":"blocked","blocked":true,"error":"user declined","errorKind":"blocked"}`)
	})
	host := httptest.NewServer(handler)
	defer host.Close()
	for _, call := range []Caller{HandlerCaller(handler, "test-token"), HTTPCaller(host.URL, func() (string, error) { return "test-token", nil })} {
		result, err := call(context.Background(), "POST", "/cli/exec", map[string]any{"command": "uptime"}, "request-1")
		if err != nil {
			t.Fatal(err)
		}
		if result["outcome"] != "blocked" || result["requestProtected"] != true || result["replayed"] != true {
			t.Fatalf("result = %#v", result)
		}
	}
}

func TestHTTPCallerDoesNotFollowRedirectsWithToken(t *testing.T) {
	called := false
	destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	call := HTTPCaller(source.URL, func() (string, error) { return "token", nil })
	_, err := call(context.Background(), "GET", "/cli/list", nil, "")
	if err == nil || called {
		t.Fatalf("redirect followed = %v, error = %v", called, err)
	}
}
