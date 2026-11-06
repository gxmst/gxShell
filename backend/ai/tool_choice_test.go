package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReportToolChoiceWireFormatsAndSubmission(t *testing.T) {
	for _, provider := range []Provider{ProviderOpenAI, ProviderAnthropic, ProviderGemini, ProviderOllama} {
		t.Run(string(provider), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["tools"] == nil {
					t.Error("submission tool missing")
				}
				switch provider {
				case ProviderOpenAI:
					choice := body["tool_choice"].(map[string]any)
					if choice["function"].(map[string]any)["name"] != "submit_report" {
						t.Error("wrong OpenAI tool choice")
					}
					_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"report\",\"type\":\"function\",\"function\":{\"name\":\"submit_report\",\"arguments\":\"{\\\"summary\\\":\\\"ok\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n"))
				case ProviderAnthropic:
					choice := body["tool_choice"].(map[string]any)
					if choice["name"] != "submit_report" || choice["type"] != "tool" {
						t.Error("wrong Anthropic tool choice")
					}
					_, _ = w.Write([]byte(strings.ReplaceAll(anthropicStream(), "read_file", "submit_report")))
				case ProviderGemini:
					config := body["toolConfig"].(map[string]any)["functionCallingConfig"].(map[string]any)
					if config["mode"] != "ANY" || config["allowedFunctionNames"].([]any)[0] != "submit_report" {
						t.Error("wrong Gemini tool choice")
					}
					_, _ = w.Write([]byte("data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"submit_report\",\"args\":{\"summary\":\"ok\"}}}]},\"finishReason\":\"STOP\"}]}\n\n"))
				case ProviderOllama:
					if body["tool_choice"] != nil {
						t.Error("unsupported tool choice sent to Ollama")
					}
					_, _ = w.Write([]byte("{\"message\":{\"tool_calls\":[{\"function\":{\"name\":\"submit_report\",\"arguments\":{\"summary\":\"ok\"}}}]},\"done\":true}\n"))
				}
			}))
			defer server.Close()
			var final ChatResponse
			err := NewManager().ChatWithConfig(context.Background(), Config{Provider: provider, Endpoint: server.URL, Model: "test"}, ChatRequest{Messages: []Message{{Role: "user", Content: "submit report"}}, EnableTools: true, Tools: []map[string]any{{"type": "function", "function": map[string]any{"name": "submit_report", "description": "submit", "parameters": map[string]any{"type": "object"}}}}, ForceTool: "submit_report"}, func(chunk ChatResponse) {
				if chunk.Finish {
					final = chunk
				}
			})
			if err != nil || !final.Finish || len(final.ToolCalls) != 1 || final.ToolCalls[0].Function.Name != "submit_report" {
				t.Fatalf("invalid normalized submission: %+v %v", final, err)
			}
		})
	}
}

func TestToolConstraintDowngradeIsBoundedAndNeverReplaysStreamOrAuth(t *testing.T) {
	for _, scenario := range []string{"choice", "tools", "auth", "stream"} {
		t.Run(scenario, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if scenario == "auth" {
					w.WriteHeader(401)
					_, _ = w.Write([]byte(`{"error":"tool_choice requires authorization"}`))
					return
				}
				if calls == 1 && scenario != "stream" {
					w.WriteHeader(400)
					if scenario == "choice" {
						_, _ = w.Write([]byte(`{"error":"unsupported parameter: tool_choice"}`))
					} else {
						_, _ = w.Write([]byte(`{"error":"unsupported parameter: tools"}`))
					}
					return
				}
				if scenario == "choice" && (body["tool_choice"] != nil || body["tools"] == nil) {
					t.Error("choice downgrade changed tool set")
				}
				if scenario == "tools" && (body["tools"] != nil || body["response_format"] == nil) {
					t.Error("unsupported tools did not fall back to JSON")
				}
				_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"summary\\\":\\\"ok\\\"}\"},\"finish_reason\":null}]}\n\n"))
				if scenario != "stream" {
					_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"))
				}
			}))
			defer server.Close()
			var final ChatResponse
			err := NewManager().ChatWithConfig(context.Background(), Config{Provider: ProviderOpenAI, Endpoint: server.URL, Model: "test"}, ChatRequest{Messages: []Message{{Role: "user", Content: "report"}}, EnableTools: true, ForceTool: "submit_report"}, func(chunk ChatResponse) {
				if chunk.Finish {
					final = chunk
				}
			})
			wantCalls := 2
			if scenario == "auth" || scenario == "stream" {
				wantCalls = 1
			}
			if calls != wantCalls {
				t.Fatalf("unexpected retries: %d", calls)
			}
			if scenario == "auth" || scenario == "stream" {
				if err == nil {
					t.Fatal("invalid auth/stream accepted")
				}
			} else if err != nil || !final.ToolFallback {
				t.Fatalf("fallback failed: %+v %v", final, err)
			}
		})
	}
}
