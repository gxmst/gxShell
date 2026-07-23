package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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

func TestHandleCliExecValidationErrorKind(t *testing.T) {
	app := NewApp()
	body := []byte(`{"server":"prod","command":"uptime","timeoutMs":500}`)
	req := httptest.NewRequest(http.MethodPost, "/cli/exec", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	app.handleCliExec(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload["errorKind"] != "validation" {
		t.Fatalf("errorKind = %#v, want validation", payload["errorKind"])
	}
}

func TestHandleCliExecRejectsHeredocWithStructuredGuidance(t *testing.T) {
	app := NewApp()
	body := []byte(`{"server":"prod","command":"cat <<'EOF'\nhello\nEOF"}`)
	req := httptest.NewRequest(http.MethodPost, "/cli/exec", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	app.handleCliExec(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["errorKind"] != "script_input_required" || payload["outcome"] != "validation_error" || payload["blocked"] != false {
		t.Fatalf("payload = %#v", payload)
	}
	if !strings.Contains(payload["recommendedCommand"].(string), "exec-stdin prod") {
		t.Fatalf("missing recommendation: %#v", payload)
	}
}

func TestCliDefaultTimeoutAndHint(t *testing.T) {
	if cliCommandTimeout != 2*time.Minute {
		t.Fatalf("cliCommandTimeout = %s, want 2m", cliCommandTimeout)
	}
	hint := cliTimeoutHint(cliCommandTimeout)
	if !strings.Contains(hint, "2m0s remote timeout") || !strings.Contains(hint, "--timeout 10m") {
		t.Fatalf("cliTimeoutHint = %q", hint)
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

func TestChooseConnectedCliSessionKeepsPreferredSession(t *testing.T) {
	sessions := []types.SessionInfo{
		{ID: "session-b", ProfileID: "profile-1", State: types.SessionConnected},
		{ID: "session-a", ProfileID: "profile-1", State: types.SessionConnected},
		{ID: "session-other", ProfileID: "profile-2", State: types.SessionConnected},
	}
	if got := chooseConnectedCliSession("profile-1", "session-a", sessions); got != "session-a" {
		t.Fatalf("preferred session = %q, want session-a", got)
	}
	if got := chooseConnectedCliSession("profile-1", "missing", sessions); got != "session-b" {
		t.Fatalf("fallback session = %q, want session-b", got)
	}
	sessions[1].State = types.SessionDisconnected
	if got := chooseConnectedCliSession("profile-1", "session-a", sessions); got != "session-b" {
		t.Fatalf("stale preferred fallback = %q, want session-b", got)
	}
}

func TestCliSessionAvailableUsesEventSeam(t *testing.T) {
	app := NewApp()
	var got types.SessionInfo
	app.cliSessionEventFn = func(info types.SessionInfo) {
		got = info
	}
	want := types.SessionInfo{ID: "session-1", ProfileID: "profile-1", State: types.SessionConnected}
	app.emitCliSessionAvailable(want)
	if got.ID != want.ID || got.ProfileID != want.ProfileID || got.State != want.State {
		t.Fatalf("event = %#v, want %#v", got, want)
	}
}
