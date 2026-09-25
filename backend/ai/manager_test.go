package ai

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseOpenAIModels(t *testing.T) {
	body := `{"object":"list","data":[{"id":"gpt-4o","object":"model"},{"id":"gpt-4o-mini","object":"model"},{"id":"gpt-3.5-turbo","object":"model"}]}`
	models, err := parseOpenAIModels([]byte(body))
	if err != nil {
		t.Fatalf("parseOpenAIModels error: %v", err)
	}
	if len(models) != 3 {
		t.Fatalf("expected 3 models, got %d", len(models))
	}
	if models[0] != "gpt-4o" {
		t.Errorf("models[0] = %q, want %q", models[0], "gpt-4o")
	}
	if models[1] != "gpt-4o-mini" {
		t.Errorf("models[1] = %q, want %q", models[1], "gpt-4o-mini")
	}
	if models[2] != "gpt-3.5-turbo" {
		t.Errorf("models[2] = %q, want %q", models[2], "gpt-3.5-turbo")
	}
}

func TestParseOpenAIModelsEmpty(t *testing.T) {
	body := `{"object":"list","data":[]}`
	models, err := parseOpenAIModels([]byte(body))
	if err != nil {
		t.Fatalf("parseOpenAIModels error: %v", err)
	}
	if len(models) != 0 {
		t.Errorf("expected 0 models, got %d", len(models))
	}
}

func TestParseOpenAIModelsInvalid(t *testing.T) {
	_, err := parseOpenAIModels([]byte("invalid json"))
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestParseOllamaModels(t *testing.T) {
	body := `{"models":[{"name":"llama3.1:8b"},{"name":"codellama:7b"},{"name":"mistral:7b"}]}`
	models, err := parseOllamaModels([]byte(body))
	if err != nil {
		t.Fatalf("parseOllamaModels error: %v", err)
	}
	if len(models) != 3 {
		t.Fatalf("expected 3 models, got %d", len(models))
	}
	if models[0] != "llama3.1:8b" {
		t.Errorf("models[0] = %q, want %q", models[0], "llama3.1:8b")
	}
	if models[1] != "codellama:7b" {
		t.Errorf("models[1] = %q, want %q", models[1], "codellama:7b")
	}
}

func TestParseOllamaModelsEmpty(t *testing.T) {
	body := `{"models":[]}`
	models, err := parseOllamaModels([]byte(body))
	if err != nil {
		t.Fatalf("parseOllamaModels error: %v", err)
	}
	if len(models) != 0 {
		t.Errorf("expected 0 models, got %d", len(models))
	}
}

func TestParseOllamaModelsInvalid(t *testing.T) {
	_, err := parseOllamaModels([]byte("not json"))
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestResolveEndpoint(t *testing.T) {
	m := NewManager()

	tests := []struct {
		name     string
		cfg      Config
		contains string
	}{
		{"openai default", Config{Provider: ProviderOpenAI}, "api.openai.com/v1/chat/completions"},
		{"openai custom", Config{Provider: ProviderOpenAI, Endpoint: "https://custom.api.com/v1"}, "custom.api.com/v1/chat/completions"},
		{"ollama default", Config{Provider: ProviderOllama}, "localhost:11434/api/chat"},
		{"ollama custom", Config{Provider: ProviderOllama, Endpoint: "http://my-ollama:11434"}, "my-ollama:11434/api/chat"},
		{"custom provider", Config{Provider: ProviderCustom, Endpoint: "https://my-api.com/v1"}, "my-api.com/v1/chat/completions"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := m.resolveEndpoint(tt.cfg)
			if !contains(got, tt.contains) {
				t.Errorf("resolveEndpoint() = %q, want to contain %q", got, tt.contains)
			}
		})
	}
}

func TestChatWithContextOnlyAdvertisesToolsWhenEnabled(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(map[bool]string{false: "disabled", true: "enabled"}[enabled], func(t *testing.T) {
			var requestBody map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if err := json.NewDecoder(r.Body).Decode(&requestBody); err != nil {
					t.Errorf("decode request: %v", err)
				}
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = w.Write([]byte("data: [DONE]\n\n"))
			}))
			defer server.Close()

			manager := NewManager()
			manager.UpdateConfig(Config{Provider: ProviderCustom, Endpoint: server.URL, Model: "test-model"})
			err := manager.Chat(ChatRequest{
				Messages:    []Message{{Role: "user", Content: "hello"}},
				EnableTools: enabled,
			}, func(ChatResponse) {})
			if err != nil {
				t.Fatalf("Chat returned error: %v", err)
			}
			_, hasTools := requestBody["tools"]
			if hasTools != enabled {
				t.Fatalf("tools present = %v, want %v (body=%#v)", hasTools, enabled, requestBody)
			}
			messages, _ := requestBody["messages"].([]any)
			if len(messages) == 0 {
				t.Fatalf("missing system message: %#v", requestBody)
			}
			systemMessage, _ := messages[0].(map[string]any)
			systemContent, _ := systemMessage["content"].(string)
			mentionsUnavailableTarget := strings.Contains(systemContent, "No connected remote target")
			if mentionsUnavailableTarget == enabled {
				t.Fatalf("unexpected system tool policy for enabled=%v: %q", enabled, systemContent)
			}
		})
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(substr) == 0 || containsSubstr(s, substr))
}

func containsSubstr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// sseStream joins lines into the wire format parseSSE expects.
func sseStream(lines ...string) string {
	return strings.Join(lines, "\n") + "\n"
}

// The tool-call index is chosen by whatever answers the request, so it cannot
// be trusted. A negative index used to subscript the slice below zero — a panic
// in a goroutine with no recover, which took the process and every SSH session
// with it — and a large one drove the growth loop until memory ran out.
func TestParseSSERejectsOutOfRangeToolCallIndex(t *testing.T) {
	for _, index := range []string{"-1", "-1000", "1e9", "1000000000", "128", "1024"} {
		var seen []ChatResponse
		stream := sseStream(
			`data: {"choices":[{"delta":{"tool_calls":[{"index":`+index+`,"id":"call_1","type":"function","function":{"name":"execute_command","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`,
			"",
			"data: [DONE]",
		)

		if err := (&Manager{}).parseSSE(strings.NewReader(stream), func(resp ChatResponse) {
			seen = append(seen, resp)
		}); err != nil {
			t.Fatalf("index %s: parseSSE returned %v", index, err)
		}
		for _, resp := range seen {
			if len(resp.ToolCalls) > 0 {
				t.Fatalf("index %s was accepted as a tool call: %#v", index, resp.ToolCalls)
			}
		}
	}
}

// A well-formed stream still accumulates the argument fragments that arrive
// across chunks, so the bounds check must not reject normal indices.
func TestParseSSEAccumulatesToolCallArgumentsAcrossChunks(t *testing.T) {
	var seen []ChatResponse
	stream := sseStream(
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"execute_command","arguments":"{\"com"}}]}}]}`,
		"",
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"mand\":\"uptime\"}"}}]},"finish_reason":"tool_calls"}]}`,
		"",
		"data: [DONE]",
	)

	if err := (&Manager{}).parseSSE(strings.NewReader(stream), func(resp ChatResponse) {
		seen = append(seen, resp)
	}); err != nil {
		t.Fatalf("parseSSE returned %v", err)
	}

	var calls []ToolCall
	for _, resp := range seen {
		if resp.Finish && len(resp.ToolCalls) > 0 {
			calls = resp.ToolCalls
		}
	}
	if len(calls) != 1 {
		t.Fatalf("got %d tool calls, want 1: %#v", len(calls), calls)
	}
	if calls[0].ID != "call_1" || calls[0].Function.Name != "execute_command" {
		t.Fatalf("tool call = %#v", calls[0])
	}
	if calls[0].Function.Arguments != `{"command":"uptime"}` {
		t.Fatalf("arguments = %q, want the two fragments joined", calls[0].Function.Arguments)
	}
}

// Two tool calls in one stream keep their own slots.
func TestParseSSEKeepsDistinctToolCallSlots(t *testing.T) {
	var seen []ChatResponse
	stream := sseStream(
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"execute_command","arguments":"{\"command\":\"ls\"}"}},{"index":1,"id":"b","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"/etc/hosts\"}"}}]},"finish_reason":"tool_calls"}]}`,
		"",
		"data: [DONE]",
	)

	if err := (&Manager{}).parseSSE(strings.NewReader(stream), func(resp ChatResponse) {
		seen = append(seen, resp)
	}); err != nil {
		t.Fatalf("parseSSE returned %v", err)
	}

	var calls []ToolCall
	for _, resp := range seen {
		if len(resp.ToolCalls) > 0 {
			calls = resp.ToolCalls
		}
	}
	if len(calls) != 2 || calls[0].ID != "a" || calls[1].ID != "b" {
		t.Fatalf("tool calls = %#v", calls)
	}
}

// A model list is a few kilobytes and the endpoint is user-configurable, so an
// oversized or endless body must be refused rather than buffered in full.
func TestReadLimited(t *testing.T) {
	if data, err := readLimited(strings.NewReader("hello"), 16); err != nil || string(data) != "hello" {
		t.Fatalf("readLimited = %q, %v", data, err)
	}
	// Exactly at the limit is allowed; one byte past it is not.
	if _, err := readLimited(strings.NewReader(strings.Repeat("x", 16)), 16); err != nil {
		t.Fatalf("a body exactly at the limit was rejected: %v", err)
	}
	if _, err := readLimited(strings.NewReader(strings.Repeat("x", 17)), 16); err == nil {
		t.Fatal("an oversized body was accepted")
	}
}
