package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"gxShell/backend/ai"
)

func TestAIToolAuthorizationClaimOnce(t *testing.T) {
	app := NewApp()
	app.registerAuthorizedAiToolCalls("sess-1", []ai.ToolCall{
		{
			ID:   "call-1",
			Type: "function",
			Function: ai.FunctionCall{
				Name:      "execute_command",
				Arguments: `{"command":"uptime"}`,
			},
		},
	})

	if _, err := app.claimAuthorizedAiToolCall("sess-2", "call-1"); err == nil {
		t.Fatal("claim from a different session should fail")
	}

	toolCall, err := app.claimAuthorizedAiToolCall("sess-1", "call-1")
	if err != nil {
		t.Fatalf("claimAuthorizedAiToolCall error: %v", err)
	}
	if toolCall.ToolName != "execute_command" || toolCall.Arguments != `{"command":"uptime"}` {
		t.Fatalf("claimed tool = %#v, want execute_command with original arguments", toolCall)
	}

	if _, err := app.claimAuthorizedAiToolCall("sess-1", "call-1"); err == nil {
		t.Fatal("second claim should fail after one-time consumption")
	}
}

func TestAIToolAuthorizationIgnoresUnknownTools(t *testing.T) {
	app := NewApp()
	app.registerAuthorizedAiToolCalls("sess-1", []ai.ToolCall{
		{
			ID:   "call-1",
			Type: "function",
			Function: ai.FunctionCall{
				Name:      "unknown_tool",
				Arguments: `{}`,
			},
		},
	})

	if _, err := app.claimAuthorizedAiToolCall("sess-1", "call-1"); err == nil {
		t.Fatal("unknown tools should not be authorized")
	}
}

func TestAIToolAuthorizationExpires(t *testing.T) {
	app := NewApp()
	key := aiToolAuthorizationKey("sess-1", "call-1")
	app.aiTools[key] = authorizedAIToolCall{
		SessionID:  "sess-1",
		ToolCallID: "call-1",
		ToolName:   "read_file",
		Arguments:  `{"path":"/var/log/syslog"}`,
		ExpiresAt:  time.Now().Add(-time.Second),
	}

	if _, err := app.claimAuthorizedAiToolCall("sess-1", "call-1"); err == nil {
		t.Fatal("expired tool call should not be claimable")
	}
	if _, ok := app.aiTools[key]; ok {
		t.Fatal("expired tool call should be pruned")
	}
}

func TestDiscardAuthorizedAiToolCalls(t *testing.T) {
	app := NewApp()
	app.registerAuthorizedAiToolCalls("sess-1", []ai.ToolCall{
		{ID: "call-1", Type: "function", Function: ai.FunctionCall{Name: "read_file", Arguments: `{"path":"/tmp/a"}`}},
	})
	app.registerAuthorizedAiToolCalls("sess-2", []ai.ToolCall{
		{ID: "call-2", Type: "function", Function: ai.FunctionCall{Name: "read_file", Arguments: `{"path":"/tmp/b"}`}},
	})

	app.discardAuthorizedAiToolCalls("sess-1")

	if _, err := app.claimAuthorizedAiToolCall("sess-1", "call-1"); err == nil {
		t.Fatal("discarded session tool call should fail")
	}
	if _, err := app.claimAuthorizedAiToolCall("sess-2", "call-2"); err != nil {
		t.Fatalf("other session tool call should remain claimable: %v", err)
	}
}

func TestReadLocalFileRequiresAllowedFile(t *testing.T) {
	app := NewApp()
	dir := t.TempDir()
	path := filepath.Join(dir, "note.md")
	if err := os.WriteFile(path, []byte("# hello"), 0600); err != nil {
		t.Fatal(err)
	}

	if _, err := app.ReadLocalFile(path); err == nil {
		t.Fatal("unallowed file should not be readable")
	}

	allowed := app.allowFile(path)
	got, err := app.ReadLocalFile(allowed)
	if err != nil {
		t.Fatalf("allowed file should be readable: %v", err)
	}
	if got != "# hello" {
		t.Fatalf("content = %q, want %q", got, "# hello")
	}
}

func TestListMarkdownFilesInDirAuthorizesOnlyMarkdownSiblings(t *testing.T) {
	app := NewApp()
	dir := t.TempDir()
	first := filepath.Join(dir, "first.md")
	second := filepath.Join(dir, "second.MD")
	text := filepath.Join(dir, "notes.txt")
	for path, content := range map[string]string{
		first:  "# first",
		second: "# second",
		text:   "plain text",
	} {
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}

	app.allowFile(first)
	files, err := app.ListMarkdownFilesInDir(first)
	if err != nil {
		t.Fatalf("ListMarkdownFilesInDir error: %v", err)
	}
	if len(files) != 2 {
		t.Fatalf("markdown files = %#v, want 2 files", files)
	}
	if _, err := app.ReadLocalFile(second); err != nil {
		t.Fatalf("markdown sibling should be authorized: %v", err)
	}
	if _, err := app.ReadLocalFile(text); err == nil {
		t.Fatal("non-markdown sibling should not be authorized")
	}
}

func TestListMarkdownFilesInDirRejectsNonMarkdownFile(t *testing.T) {
	app := NewApp()
	path := filepath.Join(t.TempDir(), "notes.txt")
	if err := os.WriteFile(path, []byte("plain text"), 0600); err != nil {
		t.Fatal(err)
	}
	app.allowFile(path)

	if _, err := app.ListMarkdownFilesInDir(path); err == nil {
		t.Fatal("non-markdown file should be rejected")
	}
}
