package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func anthropicStream() string {
	return "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":12}}}\n\n" +
		"data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call_a\",\"name\":\"read_file\",\"input\":{}}}\n\n" +
		"data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"/etc/\"}}\n\n" +
		"data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"os-release\\\"}\"}}\n\n" +
		"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":8}}\n\n" +
		"data: {\"type\":\"message_stop\"}\n\n"
}

func TestNativeProvidersToolRoundTrip(t *testing.T) {
	for _, provider := range []Provider{ProviderAnthropic, ProviderGemini, ProviderOllama} {
		t.Run(string(provider), func(t *testing.T) {
			turn := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("key") != "" {
					t.Error("API key leaked into URL")
				}
				if r.Header.Get("Authorization") == "" && r.Header.Get("x-api-key") == "" && r.Header.Get("x-goog-api-key") == "" {
					t.Error("missing authentication header")
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if provider == ProviderAnthropic {
					if r.URL.Path != "/v1/messages" || r.Header.Get("anthropic-version") != "2023-06-01" {
						t.Errorf("invalid Anthropic request: %s", r.URL)
					}
					if body["system"] != "task-specific policy" || body["max_tokens"] == nil {
						t.Error("missing native system/max_tokens")
					}
					if turn == 0 {
						_, _ = w.Write([]byte(anthropicStream()))
					} else {
						messages := body["messages"].([]any)
						last := messages[len(messages)-1].(map[string]any)
						block := last["content"].([]any)[0].(map[string]any)
						if last["role"] != "user" || block["type"] != "tool_result" || block["tool_use_id"] != "call_a" {
							t.Error("tool result was not converted to Anthropic content blocks")
						}
						_, _ = w.Write([]byte("data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"report\"}}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n"))
					}
				} else if provider == ProviderGemini {
					if r.URL.Path != "/v1beta/models/test-model:streamGenerateContent" || r.URL.Query().Get("alt") != "sse" {
						t.Errorf("invalid Gemini URL: %s", r.URL)
					}
					if turn == 0 {
						_, _ = w.Write([]byte("data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"read_file\",\"args\":{\"path\":\"/etc/os-release\"}},\"thoughtSignature\":\"opaque-signature\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":12,\"candidatesTokenCount\":8}}\n\n"))
					} else {
						contents := body["contents"].([]any)
						prev := contents[len(contents)-2].(map[string]any)["parts"].([]any)[0].(map[string]any)
						last := contents[len(contents)-1].(map[string]any)["parts"].([]any)[0].(map[string]any)
						if prev["thoughtSignature"] != "opaque-signature" {
							t.Error("lost Gemini thought signature")
						}
						fr := last["functionResponse"].(map[string]any)
						if fr["name"] != "read_file" || fr["id"] != nil {
							t.Error("invalid Gemini function response or synthetic wire ID")
						}
						_, _ = w.Write([]byte("data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"report\"}]},\"finishReason\":\"STOP\"}]}\n\n"))
					}
				} else {
					if r.URL.Path != "/api/chat" {
						t.Errorf("invalid Ollama URL: %s", r.URL)
					}
					if turn == 0 {
						_, _ = w.Write([]byte("{\"message\":{\"tool_calls\":[{\"function\":{\"name\":\"read_file\",\"arguments\":{\"path\":\"/etc/os-release\"}}}]},\"done\":true,\"prompt_eval_count\":12,\"eval_count\":8}\n"))
					} else {
						messages := body["messages"].([]any)
						last := messages[len(messages)-1].(map[string]any)
						if last["role"] != "tool" || last["tool_name"] != "read_file" {
							t.Error("missing Ollama tool_name")
						}
						prev := messages[len(messages)-2].(map[string]any)
						fn := prev["tool_calls"].([]any)[0].(map[string]any)["function"].(map[string]any)
						if _, ok := fn["arguments"].(map[string]any); !ok {
							t.Error("Ollama arguments should be an object")
						}
						_, _ = w.Write([]byte("{\"message\":{\"content\":\"report\"},\"done\":true,\"done_reason\":\"stop\"}\n"))
					}
				}
				turn++
			}))
			defer server.Close()
			cfg := Config{Provider: provider, APIKey: "test-secret", Endpoint: server.URL, Model: "test-model"}
			manager := NewManager()
			manager.UpdateConfig(cfg)
			messages := []Message{{Role: "user", Content: "inspect"}}
			var result ChatResponse
			err := manager.Chat(ChatRequest{Messages: messages, EnableTools: true, Instructions: "task-specific policy"}, func(chunk ChatResponse) {
				if chunk.Finish {
					result = chunk
				}
			})
			if err != nil {
				t.Fatal(err)
			}
			if len(result.ToolCalls) != 1 || result.PromptTk != 12 || result.CompleteTk != 8 {
				t.Fatalf("invalid normalized result: %#v", result)
			}
			call := result.ToolCalls[0]
			if call.Function.Arguments != "{\"path\":\"/etc/os-release\"}" {
				t.Errorf("invalid arguments: %s", call.Function.Arguments)
			}
			messages = append(messages, Message{Role: "assistant", ToolCalls: result.ToolCalls}, Message{Role: "tool", ToolCallID: call.ID, Content: "Linux"})
			report := ""
			err = manager.Chat(ChatRequest{Messages: messages, EnableTools: true, Instructions: "task-specific policy"}, func(chunk ChatResponse) { report += chunk.Content })
			if err != nil || report != "report" {
				t.Fatalf("second turn: %s, %v", report, err)
			}
		})
	}
}

func TestNativeStreamsDoNotReleaseIncompleteTools(t *testing.T) {
	tests := []struct {
		provider Provider
		stream   string
	}{
		{ProviderAnthropic, strings.TrimSuffix(anthropicStream(), "data: {\"type\":\"message_stop\"}\n\n")},
		{ProviderAnthropic, strings.Replace(anthropicStream(), "\"tool_use\"},\"usage\"", "\"max_tokens\"},\"usage\"", 1)},
		{ProviderGemini, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"read_file\",\"args\":{}}}]}}]}\n\n"},
		{ProviderGemini, "data: {\"candidates\":[{\"finishReason\":\"MAX_TOKENS\"}]}\n\n"},
		{ProviderOllama, "{\"message\":{\"tool_calls\":[{\"function\":{\"name\":\"read_file\",\"arguments\":{}}}]}}\n"},
		{ProviderAnthropic, "data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}\n\n"},
	}
	for _, test := range tests {
		released := false
		err := (&Manager{}).parseNativeStream(test.provider, strings.NewReader(test.stream), func(chunk ChatResponse) { released = released || chunk.Finish || len(chunk.ToolCalls) > 0 })
		if err == nil || released {
			t.Fatalf("%s released an incomplete response: %v, %v", test.provider, err, released)
		}
	}
}

// Gemini and Ollama can omit call IDs. Generated IDs must differ between
// rounds, or round 2's result overwrites round 1's in the renderer.
func TestNativeLocalToolCallIDsAreUniqueAcrossResponses(t *testing.T) {
	streams := map[Provider]string{
		ProviderGemini: "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"read_file\",\"args\":{}}}]},\"finishReason\":\"STOP\"}]}\n\n",
		ProviderOllama: "{\"message\":{\"tool_calls\":[{\"function\":{\"name\":\"read_file\",\"arguments\":{}}}]},\"done\":true,\"done_reason\":\"stop\"}\n",
	}
	for provider, stream := range streams {
		seen := map[string]bool{}
		for round := 0; round < 2; round++ {
			var calls []ToolCall
			if err := (&Manager{}).parseNativeStream(provider, strings.NewReader(stream), func(chunk ChatResponse) {
				if chunk.Finish {
					calls = chunk.ToolCalls
				}
			}); err != nil {
				t.Fatalf("%s: %v", provider, err)
			}
			if len(calls) != 1 || seen[calls[0].ID] {
				t.Fatalf("%s round %d: calls %#v, seen %v", provider, round, calls, seen)
			}
			seen[calls[0].ID] = true
		}
	}
}

func TestOpenAIStreamRejectsTruncatedToolJSON(t *testing.T) {
	for _, stream := range []string{
		"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\"}}]}}]}\n\n",
		"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n",
		// A "stop" finish is only accepted with the [DONE] terminator.
		"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"stop\"}]}\n\n",
		"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n",
	} {
		released := false
		err := (&Manager{}).parseSSE(strings.NewReader(stream), func(chunk ChatResponse) { released = released || chunk.Finish })
		if err == nil || released {
			t.Fatalf("incomplete tools released: %v, %v", err, released)
		}
	}
}

// Relays such as LiteLLM and Gemini's OpenAI endpoint finish tool turns with
// "stop" instead of "tool_calls".
func TestOpenAIStreamAcceptsStopFinishedToolCalls(t *testing.T) {
	stream := "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"/etc/hosts\\\"}\"}}]},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
	var calls []ToolCall
	if err := (&Manager{}).parseSSE(strings.NewReader(stream), func(chunk ChatResponse) {
		if chunk.Finish {
			calls = chunk.ToolCalls
		}
	}); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || calls[0].ID != "call" || calls[0].Function.Name != "read_file" {
		t.Fatalf("tool calls = %#v", calls)
	}
}

func TestNativeModelPagination(t *testing.T) {
	for _, provider := range []Provider{ProviderAnthropic, ProviderGemini} {
		t.Run(string(provider), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if provider == ProviderAnthropic {
					if r.URL.Query().Get("after_id") == "" {
						_, _ = w.Write([]byte("{\"data\":[{\"id\":\"model-a\"}],\"has_more\":true,\"last_id\":\"model-a\"}"))
					} else {
						_, _ = w.Write([]byte("{\"data\":[{\"id\":\"model-b\"}]}"))
					}
				} else {
					if r.URL.Query().Get("pageToken") == "" {
						_, _ = w.Write([]byte("{\"models\":[{\"name\":\"models/model-a\",\"supportedGenerationMethods\":[\"generateContent\"]},{\"name\":\"models/embedding\",\"supportedGenerationMethods\":[\"embedContent\"]}],\"nextPageToken\":\"next\"}"))
					} else {
						_, _ = w.Write([]byte("{\"models\":[{\"name\":\"models/model-b\",\"supportedGenerationMethods\":[\"generateContent\"]}]}"))
					}
				}
			}))
			defer server.Close()
			models, err := NewManager().ListModels(Config{Provider: provider, Endpoint: server.URL})
			if err != nil || strings.Join(models, ",") != "model-a,model-b" {
				t.Fatalf("models: %v, %v", models, err)
			}
		})
	}
}

func TestProtocolValidationAndCancellation(t *testing.T) {
	for _, endpoint := range []string{"file:///tmp/x", "https://user:secret@example.com/v1", "https://example.com/v1?key=secret"} {
		if ValidateConfig(Config{Endpoint: endpoint}) == nil {
			t.Errorf("accepted credential-bearing or non-HTTP endpoint %s", endpoint)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	manager := NewManager()
	manager.UpdateConfig(Config{Provider: ProviderAnthropic, Endpoint: "http://127.0.0.1:1", Model: "test"})
	if err := manager.ChatWithContext(ctx, ChatRequest{}, func(ChatResponse) {}); err == nil {
		t.Error("cancelled call succeeded")
	}
}

func TestProviderRedirectDoesNotForwardCredentials(t *testing.T) {
	var forwarded atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer other.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	for _, provider := range []Provider{ProviderOpenAI, ProviderAnthropic, ProviderGemini, ProviderOllama} {
		t.Run(string(provider), func(t *testing.T) {
			manager := NewManager()
			err := manager.ChatWithConfig(context.Background(), Config{Provider: provider, APIKey: "private-key", Endpoint: source.URL, Model: "test"}, ChatRequest{Messages: []Message{{Role: "user", Content: "hello"}}}, func(ChatResponse) {})
			if err == nil || forwarded.Load() != 0 {
				t.Fatalf("cross-origin API redirect was followed: %v", err)
			}
		})
	}
}
