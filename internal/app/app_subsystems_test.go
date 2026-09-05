package app

// Direct unit tests for the subsystems extracted from App (allowedFileSet and
// aiToolRegistry). App-level tests already exercise these through the binding
// delegates; these pin the isolated behaviour so the subsystems can be reasoned
// about and evolved on their own.

import (
	"path/filepath"
	"testing"
	"time"

	"gxShell/backend/ai"
)

func TestAllowedFileSetNormalizesAndAuthorizes(t *testing.T) {
	set := newAllowedFileSet()
	dir := t.TempDir()

	// An un-cleaned path (built as a raw string so filepath.Join does not
	// pre-clean it) must normalize to the cleaned absolute path that contains()
	// is later queried with.
	raw := dir + string(filepath.Separator) + "sub" + string(filepath.Separator) + ".." + string(filepath.Separator) + "note.md"
	abs, err := set.allow(raw)
	if err != nil {
		t.Fatal(err)
	}
	if abs == "" {
		t.Fatal("allow returned empty for a resolvable path")
	}
	if abs != filepath.Join(dir, "note.md") {
		t.Fatalf("allow did not clean path: got %q", abs)
	}
	if !set.contains(abs) {
		t.Fatal("cleaned path should be authorized")
	}
	// The un-normalized form is not what reads pass in; only the cleaned form is
	// authoritative.
	if set.contains(raw) {
		t.Fatal("un-cleaned path must not be treated as authorized")
	}
}

func TestAllowedFileSetUnknownPathDenied(t *testing.T) {
	set := newAllowedFileSet()
	if set.contains(filepath.Join(t.TempDir(), "never-opened.md")) {
		t.Fatal("a path that was never allowed must be denied")
	}
}

func TestAiToolRegistryClaimIsOneTimeAndSessionScoped(t *testing.T) {
	reg := newAiToolRegistry(time.Minute, nil)
	reg.register("sess-1", []ai.ToolCall{
		{ID: "call-1", Type: "function", Function: ai.FunctionCall{Name: "execute_command", Arguments: `{"command":"uptime"}`}},
	})

	if _, err := reg.claim("sess-2", "call-1"); err == nil {
		t.Fatal("claim from another session must fail")
	}
	got, err := reg.claim("sess-1", "call-1")
	if err != nil {
		t.Fatalf("first claim failed: %v", err)
	}
	if got.ToolName != "execute_command" || got.Arguments != `{"command":"uptime"}` {
		t.Fatalf("claimed wrong call: %#v", got)
	}
	if _, err := reg.claim("sess-1", "call-1"); err == nil {
		t.Fatal("second claim must fail (one-time consumption)")
	}
}

func TestAiToolRegistrySkipsUnknownToolsAndReportsCollisions(t *testing.T) {
	collisions := 0
	reg := newAiToolRegistry(time.Minute, func(_, _, _ string) { collisions++ })

	// Unknown tool name is not authorized.
	reg.register("sess-1", []ai.ToolCall{
		{ID: "call-x", Type: "function", Function: ai.FunctionCall{Name: "rm_rf", Arguments: `{}`}},
	})
	if _, err := reg.claim("sess-1", "call-x"); err == nil {
		t.Fatal("unknown tool must not be claimable")
	}

	// A duplicate ID for the same session is reported, not silently overwritten.
	reg.register("sess-1", []ai.ToolCall{
		{ID: "dup", Type: "function", Function: ai.FunctionCall{Name: "read_file", Arguments: `{"path":"/a"}`}},
	})
	reg.register("sess-1", []ai.ToolCall{
		{ID: "dup", Type: "function", Function: ai.FunctionCall{Name: "read_file", Arguments: `{"path":"/b"}`}},
	})
	if collisions != 1 {
		t.Fatalf("collision callback fired %d times, want 1", collisions)
	}
	got, err := reg.claim("sess-1", "dup")
	if err != nil {
		t.Fatalf("claim of first registration failed: %v", err)
	}
	if got.Arguments != `{"path":"/a"}` {
		t.Fatalf("duplicate overwrote the original: %#v", got)
	}
}

func TestAiToolRegistryExpiredClaimIsPruned(t *testing.T) {
	reg := newAiToolRegistry(-time.Second, nil) // already-expired TTL
	reg.register("sess-1", []ai.ToolCall{
		{ID: "call-1", Type: "function", Function: ai.FunctionCall{Name: "read_file", Arguments: `{"path":"/x"}`}},
	})
	if _, err := reg.claim("sess-1", "call-1"); err == nil {
		t.Fatal("expired authorization must not be claimable")
	}
}

func TestAiToolRegistryDiscardOnlyTargetsSession(t *testing.T) {
	reg := newAiToolRegistry(time.Minute, nil)
	reg.register("sess-1", []ai.ToolCall{
		{ID: "c1", Type: "function", Function: ai.FunctionCall{Name: "read_file", Arguments: `{"path":"/a"}`}},
	})
	reg.register("sess-2", []ai.ToolCall{
		{ID: "c2", Type: "function", Function: ai.FunctionCall{Name: "read_file", Arguments: `{"path":"/b"}`}},
	})

	reg.discard("sess-1")

	if _, err := reg.claim("sess-1", "c1"); err == nil {
		t.Fatal("discarded session call must fail")
	}
	if _, err := reg.claim("sess-2", "c2"); err != nil {
		t.Fatalf("other session call must survive discard: %v", err)
	}
}
