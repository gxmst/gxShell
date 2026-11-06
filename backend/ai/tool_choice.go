package ai

import (
	"bytes"
	"io"
	"net/http"
	"strings"
)

// Only downgrade explicit parameter rejection, before any stream is consumed.
// Authentication, quota and transport failures must not be replayed.
func downgradeToolRequest(resp *http.Response, body map[string]any, provider Provider) bool {
	if resp.StatusCode != 400 && resp.StatusCode != 422 {
		return false
	}
	data, _ := readLimited(resp.Body, maxErrorBodyBytes)
	resp.Body.Close()
	resp.Body = io.NopCloser(bytes.NewReader(data))
	message := strings.ToLower(string(data))
	choiceKey := "tool_choice"
	if provider == ProviderGemini {
		choiceKey = "toolConfig"
	}
	if _, exists := body[choiceKey]; exists {
		for _, marker := range []string{"tool_choice", "toolchoice", "toolconfig", "functioncallingconfig", "allowedfunctionnames"} {
			if strings.Contains(message, marker) {
				delete(body, choiceKey)
				return true
			}
		}
	}
	if _, exists := body["tools"]; !exists {
		return false
	}
	for _, marker := range []string{"unsupported tools", "unsupported parameter: tools", "tools not supported", "tools is not supported", "does not support tools", "does not support tool", "unknown parameter: tools", "unknown field: tools", "unknown field: functiondeclarations", "function calling is not supported"} {
		if strings.Contains(message, marker) {
			delete(body, "tools")
			delete(body, choiceKey)
			switch provider {
			case ProviderGemini:
				body["generationConfig"] = map[string]any{"responseMimeType": "application/json"}
			case ProviderOllama:
				body["format"] = "json"
			case ProviderAnthropic: // The prompt still contains the full JSON contract.
			default:
				body["response_format"] = map[string]any{"type": "json_object"}
			}
			return true
		}
	}
	return false
}
