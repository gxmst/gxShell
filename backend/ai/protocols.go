package ai

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// All providers use the same internal messages and tool results. Native
// credentials remain in headers, including Gemini (never in a URL).
func ValidateConfig(cfg Config) error {
	switch cfg.Provider {
	case "", ProviderOpenAI, ProviderCustom, ProviderAnthropic, ProviderGemini, ProviderOllama:
	default:
		return fmt.Errorf("unsupported AI protocol %q", cfg.Provider)
	}
	if cfg.Endpoint != "" {
		u, err := url.Parse(cfg.Endpoint)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return fmt.Errorf("API address must be an HTTP(S) base URL without credentials or query parameters")
		}
	}
	return nil
}

func openAIBase(endpoint string) string {
	base := strings.TrimRight(endpoint, "/")
	for _, suffix := range []string{"/chat/completions", "/models"} {
		base = strings.TrimSuffix(base, suffix)
	}
	return base
}

func nativeBase(cfg Config) string {
	base := strings.TrimRight(cfg.Endpoint, "/")
	if base == "" {
		switch cfg.Provider {
		case ProviderAnthropic:
			return "https://api.anthropic.com/v1"
		case ProviderGemini:
			return "https://generativelanguage.googleapis.com/v1beta"
		default:
			return "http://localhost:11434"
		}
	}
	// Accept both a base URL and the common complete endpoint pasted by users.
	for _, suffix := range []string{"/api/chat", "/api/tags", "/chat/completions", "/messages", "/models"} {
		base = strings.TrimSuffix(base, suffix)
	}
	u, _ := url.Parse(base)
	if u != nil && (u.Path == "" || u.Path == "/") {
		switch cfg.Provider {
		case ProviderAnthropic:
			base += "/v1"
		case ProviderGemini:
			base += "/v1beta"
		}
	}
	return base
}

func setProviderHeaders(req *http.Request, cfg Config) {
	req.Header.Set("Content-Type", "application/json")
	switch cfg.Provider {
	case ProviderAnthropic:
		req.Header.Set("anthropic-version", "2023-06-01")
		if cfg.APIKey != "" {
			req.Header.Set("x-api-key", cfg.APIKey)
		}
	case ProviderGemini:
		if cfg.APIKey != "" {
			req.Header.Set("x-goog-api-key", cfg.APIKey)
		}
	default:
		if cfg.APIKey != "" {
			req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
		}
	}
}

func providerError(err error, cfg Config) error {
	if err != nil && cfg.APIKey != "" && strings.Contains(err.Error(), cfg.APIKey) {
		return fmt.Errorf("%s", strings.ReplaceAll(err.Error(), cfg.APIKey, "<redacted>"))
	}
	return err
}

func toolInput(text string) (map[string]any, error) {
	if text == "" {
		return map[string]any{}, nil
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(text), &input); err != nil || input == nil {
		return nil, fmt.Errorf("tool arguments must be a JSON object")
	}
	return input, nil
}

func requestTools(req ChatRequest) []map[string]any {
	if !req.EnableTools {
		return nil
	}
	if req.Tools != nil {
		return req.Tools
	}
	return getToolsDefinition()
}

func (m *Manager) nativeRequest(cfg Config, req ChatRequest) (string, map[string]any, error) {
	system := req.Instructions
	if system == "" {
		system = m.buildSystemPrompt(req.Context, req.EnableTools)
	}
	base := nativeBase(cfg)
	switch cfg.Provider {
	case ProviderAnthropic:
		messages := []map[string]any{}
		appendBlocks := func(role string, blocks []any) {
			if len(messages) > 0 && messages[len(messages)-1]["role"] == role {
				last := messages[len(messages)-1]
				last["content"] = append(last["content"].([]any), blocks...)
			} else {
				messages = append(messages, map[string]any{"role": role, "content": blocks})
			}
		}
		for _, msg := range req.Messages {
			if msg.Role == "system" {
				system += "\n" + msg.Content
				continue
			}
			blocks := []any{}
			role := msg.Role
			if role == "tool" {
				role = "user"
				blocks = append(blocks, map[string]any{"type": "tool_result", "tool_use_id": msg.ToolCallID, "content": msg.Content})
			} else {
				if msg.Content != "" {
					blocks = append(blocks, map[string]any{"type": "text", "text": msg.Content})
				}
				for _, tc := range msg.ToolCalls {
					input, err := toolInput(tc.Function.Arguments)
					if err != nil {
						return "", nil, err
					}
					blocks = append(blocks, map[string]any{"type": "tool_use", "id": tc.ID, "name": tc.Function.Name, "input": input})
				}
			}
			if len(blocks) > 0 {
				appendBlocks(role, blocks)
			}
		}
		body := map[string]any{"model": cfg.Model, "system": system, "messages": messages, "max_tokens": 8192, "stream": true}
		if tools := requestTools(req); len(tools) > 0 {
			native := []any{}
			for _, t := range tools {
				fn := t["function"].(map[string]any)
				native = append(native, map[string]any{"name": fn["name"], "description": fn["description"], "input_schema": fn["parameters"]})
			}
			body["tools"] = native
			if req.ForceTool != "" {
				body["tool_choice"] = map[string]any{"type": "tool", "name": req.ForceTool}
			}
		}
		return base + "/messages", body, nil
	case ProviderGemini:
		contents := []map[string]any{}
		names := map[string]string{}
		for _, msg := range req.Messages {
			if msg.Role == "system" {
				system += "\n" + msg.Content
				continue
			}
			role := "user"
			if msg.Role == "assistant" {
				role = "model"
			}
			parts := []any{}
			if msg.Role == "tool" {
				name := names[msg.ToolCallID]
				if name == "" {
					return "", nil, fmt.Errorf("tool result has no matching Gemini function call")
				}
				response := map[string]any{"name": name, "response": map[string]any{"output": msg.Content}}
				// Locally generated IDs are not part of Gemini's wire protocol.
				if !strings.HasPrefix(msg.ToolCallID, "gemini-local-") {
					response["id"] = msg.ToolCallID
				}
				parts = append(parts, map[string]any{"functionResponse": response})
			} else {
				if msg.Content != "" {
					parts = append(parts, map[string]any{"text": msg.Content})
				}
				for _, tc := range msg.ToolCalls {
					input, err := toolInput(tc.Function.Arguments)
					if err != nil {
						return "", nil, err
					}
					names[tc.ID] = tc.Function.Name
					call := map[string]any{"name": tc.Function.Name, "args": input}
					if !strings.HasPrefix(tc.ID, "gemini-local-") {
						call["id"] = tc.ID
					}
					part := map[string]any{"functionCall": call}
					if tc.ThoughtSignature != "" {
						part["thoughtSignature"] = tc.ThoughtSignature
					}
					parts = append(parts, part)
				}
			}
			if len(parts) == 0 {
				continue
			}
			if len(contents) > 0 && contents[len(contents)-1]["role"] == role {
				last := contents[len(contents)-1]
				last["parts"] = append(last["parts"].([]any), parts...)
			} else {
				contents = append(contents, map[string]any{"role": role, "parts": parts})
			}
		}
		body := map[string]any{"contents": contents, "systemInstruction": map[string]any{"parts": []any{map[string]any{"text": system}}}}
		if tools := requestTools(req); len(tools) > 0 {
			declarations := []any{}
			for _, t := range tools {
				fn := t["function"].(map[string]any)
				declarations = append(declarations, map[string]any{"name": fn["name"], "description": fn["description"], "parametersJsonSchema": fn["parameters"]})
			}
			body["tools"] = []any{map[string]any{"functionDeclarations": declarations}}
			if req.ForceTool != "" {
				body["toolConfig"] = map[string]any{"functionCallingConfig": map[string]any{"mode": "ANY", "allowedFunctionNames": []string{req.ForceTool}}}
			}
		} else if req.JSONObject {
			body["generationConfig"] = map[string]any{"responseMimeType": "application/json"}
		}
		model := strings.TrimPrefix(cfg.Model, "models/")
		return base + "/models/" + url.PathEscape(model) + ":streamGenerateContent?alt=sse", body, nil
	default:
		messages := []map[string]any{{"role": "system", "content": system}}
		names := map[string]string{}
		for _, msg := range req.Messages {
			native := map[string]any{"role": msg.Role, "content": msg.Content}
			if msg.Role == "tool" {
				native["tool_name"] = names[msg.ToolCallID]
			}
			if msg.ReasoningContent != "" {
				native["thinking"] = msg.ReasoningContent
			}
			calls := []any{}
			for _, tc := range msg.ToolCalls {
				input, err := toolInput(tc.Function.Arguments)
				if err != nil {
					return "", nil, err
				}
				names[tc.ID] = tc.Function.Name
				calls = append(calls, map[string]any{"function": map[string]any{"name": tc.Function.Name, "arguments": input}})
			}
			if len(calls) > 0 {
				native["tool_calls"] = calls
			}
			messages = append(messages, native)
		}
		body := map[string]any{"model": cfg.Model, "messages": messages, "stream": true}
		if tools := requestTools(req); len(tools) > 0 {
			body["tools"] = tools
		} else if req.JSONObject {
			body["format"] = "json"
		}
		return base + "/api/chat", body, nil
	}
}

func (m *Manager) chatNative(ctx context.Context, cfg Config, req ChatRequest, onChunk func(ChatResponse)) error {
	if cfg.Model == "" {
		return fmt.Errorf("AI model not configured")
	}
	endpoint, body, err := m.nativeRequest(cfg, req)
	if err != nil {
		return err
	}
	send := func() (*http.Response, error) {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		httpReq, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		setProviderHeaders(httpReq, cfg)
		resp, err := m.client.Do(httpReq)
		if err != nil {
			return nil, fmt.Errorf("request failed: %w", err)
		}
		return resp, nil
	}
	resp, err := send()
	if err != nil {
		return err
	}
	fallback := false
	if req.ForceTool != "" || req.AllowToolFallback {
		for attempt := 0; attempt < 2 && downgradeToolRequest(resp, body, cfg.Provider); attempt++ {
			fallback = true
			resp.Body.Close()
			if resp, err = send(); err != nil {
				return err
			}
		}
	}
	// The JSON constraint is optional; a gateway that rejects it is asked again
	// without it before anything was streamed.
	if constraint := jsonConstraintKey(body); constraint != "" && rejectedJSONMode(resp) {
		resp.Body.Close()
		delete(body, constraint)
		if resp, err = send(); err != nil {
			return err
		}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := readLimited(resp.Body, maxErrorBodyBytes)
		return providerError(fmt.Errorf("API error (%d): %s", resp.StatusCode, string(body)), cfg)
	}
	return providerError(m.parseNativeStream(cfg.Provider, resp.Body, func(chunk ChatResponse) { chunk.ToolFallback = fallback; onChunk(chunk) }), cfg)
}

// parseNativeStream releases tools only after a complete provider finish event.
// A dropped stream or truncated JSON can never authorize partial tool arguments.
func (m *Manager) parseNativeStream(provider Provider, body io.Reader, onChunk func(ChatResponse)) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	calls := []ToolCall{}
	slots := map[int]int{}
	partial := map[int]string{}
	prompt, completion := 0, 0
	done := false
	stop := ""
	// Gemini and Ollama may omit call IDs. Local IDs must stay unique across
	// rounds: the renderer and the approval registry both key results by ID.
	var nonce [4]byte
	_, _ = rand.Read(nonce[:])
	localID := func(prefix string) string {
		return prefix + hex.EncodeToString(nonce[:]) + "-" + strconv.Itoa(len(calls))
	}
	for scanner.Scan() {
		line := scanner.Text()
		if provider != ProviderOllama {
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			line = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		}
		if strings.TrimSpace(line) == "" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			return fmt.Errorf("invalid streaming JSON: %w", err)
		}
		if apiErr, ok := event["error"]; ok {
			return fmt.Errorf("provider stream error: %v", apiErr)
		}
		switch provider {
		case ProviderAnthropic:
			typ, _ := event["type"].(string)
			idx := intNumber(event["index"])
			switch typ {
			case "error":
				return fmt.Errorf("Anthropic stream error")
			case "message_start":
				msg, _ := event["message"].(map[string]any)
				usage, _ := msg["usage"].(map[string]any)
				prompt = intNumber(usage["input_tokens"]) + intNumber(usage["cache_read_input_tokens"]) + intNumber(usage["cache_creation_input_tokens"])
			case "content_block_start":
				block, _ := event["content_block"].(map[string]any)
				if block["type"] == "tool_use" {
					if idx < 0 || idx >= maxStreamToolCalls || len(calls) >= maxStreamToolCalls {
						return fmt.Errorf("too many tool calls")
					}
					id, _ := block["id"].(string)
					name, _ := block["name"].(string)
					input, _ := json.Marshal(block["input"])
					slots[idx] = len(calls)
					calls = append(calls, ToolCall{ID: id, Type: "function", Function: FunctionCall{Name: name, Arguments: string(input)}})
				}
			case "content_block_delta":
				delta, _ := event["delta"].(map[string]any)
				if text, _ := delta["text"].(string); text != "" {
					onChunk(ChatResponse{Content: text})
				}
				if text, _ := delta["thinking"].(string); text != "" {
					onChunk(ChatResponse{ReasoningContent: text})
				}
				if fragment, _ := delta["partial_json"].(string); fragment != "" {
					slot, exists := slots[idx]
					if !exists {
						return fmt.Errorf("tool delta without matching block")
					}
					partial[slot] += fragment
					if len(partial[slot]) > 256*1024 {
						return fmt.Errorf("tool arguments exceed limit")
					}
				}
			case "message_delta":
				delta, _ := event["delta"].(map[string]any)
				stop, _ = delta["stop_reason"].(string)
				usage, _ := event["usage"].(map[string]any)
				completion = intNumber(usage["output_tokens"])
			case "message_stop":
				done = true
			}
		case ProviderGemini:
			usage, _ := event["usageMetadata"].(map[string]any)
			if usage != nil {
				prompt = intNumber(usage["promptTokenCount"])
				completion = intNumber(usage["candidatesTokenCount"]) + intNumber(usage["thoughtsTokenCount"])
			}
			if feedback, ok := event["promptFeedback"].(map[string]any); ok && feedback["blockReason"] != nil {
				return fmt.Errorf("Gemini blocked the request: %v", feedback["blockReason"])
			}
			candidates, _ := event["candidates"].([]any)
			if len(candidates) == 0 {
				continue
			}
			candidate, _ := candidates[0].(map[string]any)
			content, _ := candidate["content"].(map[string]any)
			parts, _ := content["parts"].([]any)
			for _, raw := range parts {
				part, _ := raw.(map[string]any)
				if text, _ := part["text"].(string); text != "" {
					if part["thought"] == true {
						onChunk(ChatResponse{ReasoningContent: text})
					} else {
						onChunk(ChatResponse{Content: text})
					}
				}
				if fn, ok := part["functionCall"].(map[string]any); ok {
					if len(calls) >= maxStreamToolCalls {
						return fmt.Errorf("too many tool calls")
					}
					id, _ := fn["id"].(string)
					if id == "" {
						id = localID("gemini-local-")
					}
					name, _ := fn["name"].(string)
					signature, _ := part["thoughtSignature"].(string)
					args := fn["args"]
					if args == nil {
						args = map[string]any{}
					}
					input, _ := json.Marshal(args)
					calls = append(calls, ToolCall{ID: id, Type: "function", Function: FunctionCall{Name: name, Arguments: string(input)}, ThoughtSignature: signature})
				}
			}
			if reason, _ := candidate["finishReason"].(string); reason != "" {
				stop = reason
				done = true
			}
		default:
			if usage := intNumber(event["prompt_eval_count"]); usage != 0 {
				prompt = usage
			}
			if usage := intNumber(event["eval_count"]); usage != 0 {
				completion = usage
			}
			msg, _ := event["message"].(map[string]any)
			if text, _ := msg["content"].(string); text != "" {
				onChunk(ChatResponse{Content: text})
			}
			if text, _ := msg["thinking"].(string); text != "" {
				onChunk(ChatResponse{ReasoningContent: text})
			}
			tools, _ := msg["tool_calls"].([]any)
			for _, raw := range tools {
				if len(calls) >= maxStreamToolCalls {
					return fmt.Errorf("too many tool calls")
				}
				tool, _ := raw.(map[string]any)
				fn, _ := tool["function"].(map[string]any)
				name, _ := fn["name"].(string)
				id, _ := tool["id"].(string)
				if id == "" {
					id = localID("ollama-local-")
				}
				args := fn["arguments"]
				if args == nil {
					args = map[string]any{}
				}
				input, _ := json.Marshal(args)
				calls = append(calls, ToolCall{ID: id, Type: "function", Function: FunctionCall{Name: name, Arguments: string(input)}})
			}
			if event["done"] == true {
				done = true
				stop, _ = event["done_reason"].(string)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("stream interrupted: %w", err)
	}
	if !done {
		return fmt.Errorf("stream ended before completion")
	}
	if (provider == ProviderAnthropic && stop != "end_turn" && stop != "tool_use" && stop != "stop_sequence") ||
		(provider == ProviderGemini && stop != "STOP") || (provider == ProviderOllama && stop != "" && stop != "stop") {
		return fmt.Errorf("response did not complete (%s)", stop)
	}
	if provider == ProviderAnthropic && len(calls) > 0 && stop != "tool_use" {
		return fmt.Errorf("tool blocks without tool_use completion")
	}
	for i := range calls {
		if text := partial[i]; text != "" {
			calls[i].Function.Arguments = text
		}
		if calls[i].ID == "" || calls[i].Function.Name == "" {
			return fmt.Errorf("incomplete tool call")
		}
	}
	return m.finishResponse(calls, prompt, completion, onChunk)
}

func intNumber(v any) int {
	if n, ok := v.(float64); ok {
		return int(n)
	}
	return 0
}

func (m *Manager) listNativeModels(cfg Config) ([]string, error) {
	if err := ValidateConfig(cfg); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	endpoint := nativeBase(cfg) + "/models"
	result := []string{}
	for page := 0; page < 10; page++ {
		req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
		if err != nil {
			return nil, err
		}
		setProviderHeaders(req, cfg)
		resp, err := m.client.Do(req)
		if err != nil {
			return nil, err
		}
		body, err := readLimited(resp.Body, maxModelsResponseBytes)
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("model API error (%d)", resp.StatusCode)
		}
		var data struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
			HasMore bool   `json:"has_more"`
			LastID  string `json:"last_id"`
			Models  []struct {
				Name    string   `json:"name"`
				Methods []string `json:"supportedGenerationMethods"`
			} `json:"models"`
			NextPageToken string `json:"nextPageToken"`
		}
		if err := json.Unmarshal(body, &data); err != nil {
			return nil, err
		}
		if cfg.Provider == ProviderAnthropic {
			for _, model := range data.Data {
				result = append(result, model.ID)
			}
			if !data.HasMore || data.LastID == "" {
				return result, nil
			}
			endpoint = nativeBase(cfg) + "/models?after_id=" + url.QueryEscape(data.LastID)
		} else {
			for _, model := range data.Models {
				for _, method := range model.Methods {
					if method == "generateContent" {
						result = append(result, strings.TrimPrefix(model.Name, "models/"))
						break
					}
				}
			}
			if data.NextPageToken == "" {
				return result, nil
			}
			endpoint = nativeBase(cfg) + "/models?pageToken=" + url.QueryEscape(data.NextPageToken)
		}
	}
	return nil, fmt.Errorf("model list exceeded pagination limit")
}
