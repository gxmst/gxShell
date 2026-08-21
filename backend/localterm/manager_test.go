package localterm

import (
	"os"
	"path/filepath"
	"testing"

	"gxShell/backend/types"
)

func TestResolveShellAutoUsesAvailableDefault(t *testing.T) {
	got, err := resolveShell("auto")
	if err != nil {
		t.Fatal(err)
	}
	if got == "" {
		t.Fatal("expected a platform default shell")
	}
}

func TestEmitSessionIncludesRuntimeEnvelope(t *testing.T) {
	var eventName string
	var payload map[string]any
	manager := NewManager(func(event string, data any) {
		eventName = event
		payload, _ = data.(map[string]any)
	})
	session := &Session{info: types.SessionInfo{
		ID: "local-1", RuntimeID: "local:local-1", Generation: 1,
		State: types.SessionConnected,
	}}
	manager.emitSession("terminal:data", session, map[string]any{"data": "hello"})
	if eventName != "terminal:data" {
		t.Fatalf("event = %q, want terminal:data", eventName)
	}
	if payload["sessionId"] != "local-1" || payload["runtimeId"] != "local:local-1" || payload["generation"] != uint64(1) || payload["data"] != "hello" {
		t.Fatalf("unexpected local terminal envelope: %#v", payload)
	}
}

func TestResolveShellRejectsMissingExecutable(t *testing.T) {
	if _, err := resolveShell("gxshell-definitely-missing-shell"); err == nil {
		t.Fatal("expected a missing executable error")
	}
}

func TestResolveStartDirectory(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("GXSHELL_LOCALTERM_TEST_DIR", dir)
	got, err := resolveStartDirectory("$GXSHELL_LOCALTERM_TEST_DIR")
	if err != nil {
		t.Fatal(err)
	}
	want, err := filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != filepath.Clean(want) {
		t.Fatalf("got %q, want %q", got, filepath.Clean(want))
	}

	file := filepath.Join(dir, "not-a-directory")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveStartDirectory(file); err == nil {
		t.Fatal("expected a non-directory error")
	}
}
