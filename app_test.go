package main

import (
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
