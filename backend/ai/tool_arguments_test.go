package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func rejectedArgumentStream(provider Provider, args string) string {
	quote := func(text string) string { value, _ := json.Marshal(text); return string(value) }
	switch provider {
	case ProviderAnthropic:
		return "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":12}}}\n\n" +
			"data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"report\",\"name\":\"submit_report\",\"input\":{}}}\n\n" +
			"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":" + quote(args) + "}}\n\n" +
			"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":8}}\n\n" +
			"data: {\"type\":\"message_stop\"}\n\n"
	case ProviderGemini:
		return fmt.Sprintf("data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"submit_report\",\"args\":%s}}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":12,\"candidatesTokenCount\":8}}\n\n", args)
	case ProviderOllama:
		return fmt.Sprintf("{\"message\":{\"tool_calls\":[{\"function\":{\"name\":\"submit_report\",\"arguments\":%s}}]},\"done\":true,\"done_reason\":\"stop\",\"prompt_eval_count\":12,\"eval_count\":8}\n", args)
	default:
		return "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"report\",\"function\":{\"name\":\"submit_report\",\"arguments\":" + quote(args) + "}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":8}}\n\ndata: [DONE]\n\n"
	}
}

func TestCompleteInvalidArgumentsRetainUsageWithoutReleasingTools(t *testing.T) {
	for _, provider := range []Provider{ProviderOpenAI, ProviderAnthropic, ProviderGemini, ProviderOllama} {
		for _, args := range []string{`[]`, `"not an object"`, `null`, `{`} {
			if (provider == ProviderGemini || provider == ProviderOllama) && (args == "null" || args == "{") {
				continue // Native null/missing input is normalized to an empty object.
			}
			t.Run(string(provider)+"/"+args, func(t *testing.T) {
				requests := 0
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					requests++
					_, _ = w.Write([]byte(rejectedArgumentStream(provider, args)))
				}))
				defer server.Close()
				manager := NewManager()
				released := false
				err := manager.ChatWithConfig(context.Background(), Config{Provider: provider, Endpoint: server.URL, Model: "test", APIKey: "test-key"}, ChatRequest{Messages: []Message{{Role: "user", Content: "report"}}, EnableTools: true}, func(chunk ChatResponse) {
					released = released || chunk.Finish || len(chunk.ToolCalls) > 0
				})
				var rejected *ToolArgumentsError
				if !errors.As(err, &rejected) || released || requests != 1 {
					t.Fatalf("invalid response executed or lost recovery data: %v, released=%v requests=%d", err, released, requests)
				}
				response := rejected.Response
				if !response.Finish || response.PromptTk != 12 || response.CompleteTk != 8 || len(response.ToolCalls) != 1 || response.ToolCalls[0].Function.Arguments != args {
					t.Fatalf("raw arguments/usage lost: %+v", response)
				}
				if usage := manager.GetUsage(); usage.PromptTokens != 12 || usage.CompletionTokens != 8 || usage.TotalTokens != 20 {
					t.Fatalf("billed rejected response counted incorrectly: %+v", usage)
				}
			})
		}
	}
}

func TestInterruptedInvalidArgumentsCannotEnterReportRepair(t *testing.T) {
	for _, provider := range []Provider{ProviderOpenAI, ProviderAnthropic, ProviderGemini, ProviderOllama} {
		for _, truncated := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/truncated=%v", provider, truncated), func(t *testing.T) {
				stream := rejectedArgumentStream(provider, `[]`)
				if truncated {
					switch provider {
					case ProviderOpenAI:
						stream = strings.Split(stream, "data: [DONE]")[0]
					case ProviderAnthropic:
						stream = strings.Split(stream, "data: {\"type\":\"message_stop\"}")[0]
					case ProviderGemini:
						stream = strings.ReplaceAll(stream, `,"finishReason":"STOP"`, "")
					case ProviderOllama:
						stream = strings.ReplaceAll(stream, `"done":true`, `"done":false`)
					}
				} else {
					stream = strings.NewReplacer(`"tool_calls"}]`, `"length"}]`, `"stop_reason":"tool_use"`, `"stop_reason":"max_tokens"`, `"finishReason":"STOP"`, `"finishReason":"MAX_TOKENS"`, `"done_reason":"stop"`, `"done_reason":"length"`).Replace(stream)
				}
				manager := NewManager()
				released := false
				callback := func(chunk ChatResponse) { released = released || chunk.Finish || len(chunk.ToolCalls) > 0 }
				var err error
				if provider == ProviderOpenAI {
					err = manager.parseSSE(strings.NewReader(stream), callback)
				} else {
					err = manager.parseNativeStream(provider, strings.NewReader(stream), callback)
				}
				var rejected *ToolArgumentsError
				if err == nil || errors.As(err, &rejected) || released || manager.GetUsage().TotalTokens != 0 {
					t.Fatalf("incomplete/limited response was recoverable or executed: %v, released=%v", err, released)
				}
			})
		}
	}
}
