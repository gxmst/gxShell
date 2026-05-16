package ai

import "testing"

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
