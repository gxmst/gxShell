package app

import (
	"strings"
	"testing"
	"unicode/utf8"

	"gxShell/backend/types"
)

func TestToAiChatRequestCompactsToolResultsByAge(t *testing.T) {
	big := "BEGIN\n" + strings.Repeat("日志行 log line\n", 8000) + "END"
	small := "ok\n"
	req := types.AiChatRequest{Messages: []types.AiMessage{
		{Role: "user", Content: "check disk"},
		{Role: "assistant", ToolCalls: []types.AiToolCall{{ID: "a", Type: "function", Function: types.AiFunctionCall{Name: "execute_command", Arguments: `{"command":"df"}`}}}},
		{Role: "tool", ToolCallID: "a", Content: big},
		{Role: "user", Content: strings.Repeat("x", 3*aiRecentToolResultLimit)},
		{Role: "assistant", ToolCalls: []types.AiToolCall{{ID: "b", Type: "function", Function: types.AiFunctionCall{Name: "execute_command", Arguments: `{"command":"uptime"}`}}, {ID: "c", Type: "function", Function: types.AiFunctionCall{Name: "read_file", Arguments: `{"path":"/var/log/syslog"}`}}}},
		{Role: "tool", ToolCallID: "b", Content: small},
		{Role: "tool", ToolCallID: "c", Content: big},
	}}
	got := toAiChatRequest(req).Messages

	older, recent := got[2].Content, got[6].Content
	if len(older) > aiOlderToolResultLimit+256 || len(recent) > aiRecentToolResultLimit+256 {
		t.Fatalf("not compacted: older %d bytes, recent %d bytes", len(older), len(recent))
	}
	for _, text := range []string{older, recent} {
		if !strings.HasPrefix(text, "BEGIN\n") || !strings.HasSuffix(text, "END") || !strings.Contains(text, "bytes omitted") || !utf8.ValidString(text) {
			t.Fatalf("head, tail, marker or encoding lost:\n%.200s ... %.200s", text, text[len(text)-200:])
		}
	}
	if got[5].Content != small || got[3].Content != req.Messages[3].Content || got[2].ToolCallID != "a" || got[6].ToolCallID != "c" {
		t.Fatal("small tool results, user text and tool call IDs must pass through unchanged")
	}
	if req.Messages[2].Content != big {
		t.Fatal("the renderer's copy must keep the full output")
	}
}

func TestClipToolResultKeepsInvalidBytesOutsideTheCut(t *testing.T) {
	text := "\xff\xfe" + strings.Repeat("a", 4000) + "\xff"
	got := clipToolResult(text, 1024)
	if !strings.HasPrefix(got, "\xff\xfe") || !strings.HasSuffix(got, "a\xff") {
		t.Fatal("bytes that the cut did not split were dropped")
	}
	if clipToolResult("short", 1024) != "short" {
		t.Fatal("short output changed")
	}
}
