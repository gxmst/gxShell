package ai

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestAnthropicToolLimitCountsToolsInsteadOfContentBlocks(t *testing.T) {
	var stream strings.Builder
	stream.WriteString("data: {\"type\":\"message_start\",\"message\":{}}\n\n")
	for index := 0; index < 128; index++ {
		for _, event := range []map[string]any{
			{"type": "content_block_start", "index": index, "content_block": map[string]any{"type": "text", "text": ""}},
			{"type": "content_block_stop", "index": index},
		} {
			encoded, _ := json.Marshal(event)
			stream.WriteString("data: " + string(encoded) + "\n\n")
		}
	}
	tools := strings.ReplaceAll(anthropicStream(), "\"index\":1", "\"index\":128")
	stream.WriteString(tools[strings.Index(tools, "data: {\"type\":\"content_block_start\""):])
	var calls []ToolCall
	err := (&Manager{}).parseNativeStream(ProviderAnthropic, strings.NewReader(stream.String()), func(chunk ChatResponse) { calls = append(calls, chunk.ToolCalls...) })
	if err != nil || len(calls) != 1 || calls[0].Function.Arguments != `{"path":"/etc/os-release"}` {
		t.Fatalf("calls=%v error=%v", calls, err)
	}
}

func TestAnthropicRejectsDuplicateToolBlockIndex(t *testing.T) {
	stream := anthropicStream()
	start := "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"duplicate\",\"name\":\"read_file\",\"input\":{}}}\n\n"
	stream = start + stream
	if err := (&Manager{}).parseNativeStream(ProviderAnthropic, strings.NewReader(stream), func(ChatResponse) { t.Fatal("duplicate tools released") }); err == nil {
		t.Fatal("duplicate tool index accepted")
	}
}

func TestGeminiTruncationRetainsTextAndWithholdsTools(t *testing.T) {
	stream := "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"partial answer\"},{\"functionCall\":{\"name\":\"read_file\",\"args\":{}}}]},\"finishReason\":\"MAX_TOKENS\"}]}\n\n"
	var text string
	err := (&Manager{}).parseNativeStream(ProviderGemini, strings.NewReader(stream), func(chunk ChatResponse) {
		text += chunk.Content
		if chunk.Finish || len(chunk.ToolCalls) != 0 {
			t.Fatal("truncated tools released")
		}
	})
	var truncated *TruncatedResponseError
	if !errors.As(err, &truncated) || text != "partial answer" {
		t.Fatalf("text=%q error=%v", text, err)
	}
}
