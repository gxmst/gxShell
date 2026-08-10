package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNormalizeCliLoopbackEndpoint(t *testing.T) {
	for _, input := range []string{"0", "1080", "127.0.0.1:8080", "[::1]:0", "localhost:9000"} {
		if _, err := normalizeCliLoopbackEndpoint(input); err != nil {
			t.Errorf("%q rejected: %v", input, err)
		}
	}
	for _, input := range []string{"0.0.0.0:8080", "192.0.2.10:8080", "[::]:8080", "bad"} {
		if _, err := normalizeCliLoopbackEndpoint(input); err == nil {
			t.Errorf("%q should be rejected", input)
		}
	}
}

func TestValidateCliRemoteEndpoint(t *testing.T) {
	if err := validateCliRemoteEndpoint("127.0.0.1:80"); err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{"localhost", ":80", "host:0", "host:70000"} {
		if err := validateCliRemoteEndpoint(input); err == nil {
			t.Errorf("%q should be rejected", input)
		}
	}
}

func TestHandleCliTransferRejectsInvalidOperationBeforeProfileLookup(t *testing.T) {
	app := NewApp()
	req := httptest.NewRequest(http.MethodPost, "/cli/transfer", bytes.NewBufferString(`{"operation":"sync","server":"prod","localPath":"x","remotePath":"/tmp/x"}`))
	rec := httptest.NewRecorder()
	app.handleCliTransfer(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["errorKind"] != "validation" || payload["outcome"] != "validation_error" {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestHandleCliTransferRejectsPullMkdir(t *testing.T) {
	app := NewApp()
	req := httptest.NewRequest(http.MethodPost, "/cli/transfer", bytes.NewBufferString(`{"operation":"pull","server":"prod","localPath":"x","remotePath":"/tmp/x","mkdir":true}`))
	rec := httptest.NewRecorder()
	app.handleCliTransfer(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["errorKind"] != "validation" {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestWriteCliTransferConflictUsesStructuredOverwriteOutcome(t *testing.T) {
	rec := httptest.NewRecorder()
	writeCliTransferConflict(rec, "prod:/srv/app.tar.gz", true)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusConflict)
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]any{
		"outcome": "blocked", "blocked": true, "blockedBy": "overwrite-policy",
		"errorKind": "overwrite_required", "overwriteRequired": true,
	} {
		if payload[key] != want {
			t.Fatalf("payload[%q] = %#v, want %#v", key, payload[key], want)
		}
	}
}

func TestCheckCliTransferSensitivePathCoversRelativeSpellings(t *testing.T) {
	for _, input := range []string{"etc/shadow", "../etc/shadow", "home/alice/.ssh/id_rsa", "foo/../.aws/credentials"} {
		if block, blocked := checkCliTransferSensitivePath(input); !blocked || block.Kind != "sensitive-path" {
			t.Fatalf("path %q was not blocked: %#v, %v", input, block, blocked)
		}
	}
	if _, blocked := checkCliTransferSensitivePath("tmp/release.tar.gz"); blocked {
		t.Fatal("ordinary relative transfer path was blocked")
	}
}
