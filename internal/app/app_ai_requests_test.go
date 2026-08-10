package app

import (
	"context"
	"testing"
	"time"

	"gxShell/backend/ai"
	"gxShell/backend/types"
)

func TestValidateAiChatRequestRequiresRoutingIDs(t *testing.T) {
	valid := types.AiChatRequest{
		ChatID:    "chat-1",
		RequestID: "request-1",
		Messages:  []types.AiMessage{{Role: "user", Content: "hello"}},
	}
	if err := validateAiChatRequest(valid); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*types.AiChatRequest)
	}{
		{"missing chat ID", func(req *types.AiChatRequest) { req.ChatID = "" }},
		{"missing request ID", func(req *types.AiChatRequest) { req.RequestID = "" }},
		{"missing messages", func(req *types.AiChatRequest) { req.Messages = nil }},
		{"tools without session", func(req *types.AiChatRequest) { req.EnableTools = true }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := valid
			test.mutate(&req)
			if err := validateAiChatRequest(req); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestActiveAiChatCancellationIsScopedToChat(t *testing.T) {
	app := &App{}
	ctx, cancel := context.WithCancel(context.Background())
	entry, ok := registerActiveAiChat(app, "chat-1", "request-1", cancel)
	if !ok {
		t.Fatal("failed to register request")
	}
	defer unregisterActiveAiChat(app, "request-1", entry)

	if cancelActiveAiChat(app, "chat-2", "request-1") {
		t.Fatal("a different chat ID cancelled the request")
	}
	select {
	case <-ctx.Done():
		t.Fatal("request was cancelled by a mismatched chat")
	default:
	}

	if !cancelActiveAiChat(app, "chat-1", "request-1") {
		t.Fatal("exact request was not cancelled")
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("cancel function was not called")
	}
	if cancelActiveAiChat(app, "chat-1", "request-1") {
		t.Fatal("request was cancelled more than once")
	}
}

func TestToAiChatRequestPreservesToolsAndRoutingPolicy(t *testing.T) {
	req := types.AiChatRequest{
		Context:     "terminal context",
		EnableTools: true,
		Messages: []types.AiMessage{{
			Role:             "assistant",
			Content:          "",
			ReasoningContent: "reasoning",
			ToolCalls: []types.AiToolCall{{
				ID:   "call-1",
				Type: "function",
				Function: types.AiFunctionCall{
					Name:      "execute_command",
					Arguments: `{"command":"uptime"}`,
				},
			}},
		}},
	}

	got := toAiChatRequest(req)
	if got.Context != req.Context || !got.EnableTools {
		t.Fatalf("request policy not preserved: %#v", got)
	}
	if len(got.Messages) != 1 || len(got.Messages[0].ToolCalls) != 1 {
		t.Fatalf("tool calls not preserved: %#v", got.Messages)
	}
	tool := got.Messages[0].ToolCalls[0]
	if tool.ID != "call-1" || tool.Function.Name != "execute_command" {
		t.Fatalf("unexpected tool conversion: %#v", tool)
	}
	if got.Messages[0].ReasoningContent != "reasoning" {
		t.Fatalf("reasoning content lost: %#v", got.Messages[0])
	}

	serialized := serializeAiToolCalls([]ai.ToolCall{tool})
	if len(serialized) != 1 || serialized[0]["id"] != "call-1" {
		t.Fatalf("unexpected serialized tool calls: %#v", serialized)
	}
}
