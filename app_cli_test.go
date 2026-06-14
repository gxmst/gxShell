package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"gxShell/backend/types"
)

func TestCliAuthRequiresBearerToken(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/cli/list", nil)
	if isAuthorizedCliRequest(req, "secret") {
		t.Fatal("request without token was authorized")
	}

	req.Header.Set("Authorization", "Bearer wrong")
	if isAuthorizedCliRequest(req, "secret") {
		t.Fatal("request with wrong token was authorized")
	}

	req.Header.Set("Authorization", "Bearer secret")
	if !isAuthorizedCliRequest(req, "secret") {
		t.Fatal("request with bearer token was rejected")
	}
}

func TestCliAuthAllowsTokenHeader(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/cli/list", nil)
	req.Header.Set("X-GxShell-CLI-Token", "secret")
	if !isAuthorizedCliRequest(req, "secret") {
		t.Fatal("request with CLI token header was rejected")
	}
}

func TestLoadOrCreateCliTokenPersistsToken(t *testing.T) {
	dir := t.TempDir()

	first, err := loadOrCreateCliToken(dir)
	if err != nil {
		t.Fatalf("create token: %v", err)
	}
	if first == "" {
		t.Fatal("created empty token")
	}

	second, err := loadOrCreateCliToken(dir)
	if err != nil {
		t.Fatalf("load token: %v", err)
	}
	if first != second {
		t.Fatalf("token was not persisted: %q != %q", first, second)
	}
}

func TestCliProfileNamePrefersAlias(t *testing.T) {
	profile := types.Profile{Name: "root@10.0.0.1", CliAlias: "prod-web"}
	if got := cliProfileName(profile); got != "prod-web" {
		t.Fatalf("got %q", got)
	}
}

func TestCliProfileNameDoesNotExposeProfileName(t *testing.T) {
	profile := types.Profile{Name: "root@10.0.0.1"}
	if got := cliProfileName(profile); got != "" {
		t.Fatalf("got %q", got)
	}
}
