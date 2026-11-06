package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"
)

type Provider string

const (
	ProviderOpenAI    Provider = "openai"
	ProviderOllama    Provider = "ollama"
	ProviderCustom    Provider = "custom"
	ProviderAnthropic Provider = "anthropic"
	ProviderGemini    Provider = "gemini"
)

type Config struct {
	Provider Provider `json:"provider"`
	APIKey   string   `json:"apiKey"`
	Endpoint string   `json:"endpoint"`
	Model    string   `json:"model"`
}

type Message struct {
	Role             string     `json:"role"`
	Content          string     `json:"content"`
	ReasoningContent string     `json:"reasoning_content,omitempty"`
	ToolCalls        []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID       string     `json:"tool_call_id,omitempty"`
}

type ToolCall struct {
	ID               string       `json:"id"`
	Type             string       `json:"type"`
	Function         FunctionCall `json:"function"`
	ThoughtSignature string       `json:"thoughtSignature,omitempty"`
}

type FunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type ToolResult struct {
	ToolCallID string `json:"tool_call_id"`
	Content    string `json:"content"`
}

type ChatRequest struct {
	Messages    []Message    `json:"messages"`
	Context     string       `json:"context,omitempty"`
	Stream      bool         `json:"stream"`
	ToolResults []ToolResult `json:"tool_results,omitempty"`
	EnableTools bool         `json:"enable_tools,omitempty"`
	// Instructions and Tools are backend-owned overrides for built-in workflows.
	Instructions string           `json:"-"`
	Tools        []map[string]any `json:"-"`
	// JSONObject asks the provider to constrain a tool-less answer to one JSON
	// object where the protocol supports it. Endpoints that reject the
	// parameter are retried once without it.
	JSONObject bool `json:"-"`
}

type ChatResponse struct {
	Content          string     `json:"content"`
	ReasoningContent string     `json:"reasoningContent,omitempty"`
	Finish           bool       `json:"finish"`
	PromptTk         int        `json:"promptTokens"`
	CompleteTk       int        `json:"completionTokens"`
	ToolCalls        []ToolCall `json:"tool_calls,omitempty"`
}

type TokenUsage struct {
	PromptTokens     int64 `json:"promptTokens"`
	CompletionTokens int64 `json:"completionTokens"`
	TotalTokens      int64 `json:"totalTokens"`
}

type Manager struct {
	mu     sync.RWMutex
	config Config
	usage  TokenUsage
	client *http.Client
}

func NewManager() *Manager {
	return NewManagerWithTransport(nil)
}

// NewManagerWithTransport keeps one immutable client while the application's
// transport can update its routing policy without interrupting active streams.
func NewManagerWithTransport(transport http.RoundTripper) *Manager {
	// No client-level Timeout: streaming chat relies on a per-request context
	// (ChatWithContext) and a hard client timeout would truncate long streams.
	// Non-streaming calls (ListModels) attach their own context deadline instead.
	return &Manager{
		client: &http.Client{Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
			// Go does not strip native x-api-key / x-goog-api-key headers when
			// redirecting. Never forward credentials to a different API origin.
			origin := via[0].URL
			if !strings.EqualFold(req.URL.Scheme, origin.Scheme) || !strings.EqualFold(req.URL.Host, origin.Host) {
				return http.ErrUseLastResponse
			}
			if len(via) >= 10 {
				return fmt.Errorf("too many API redirects")
			}
			return nil
		}},
	}
}

func (m *Manager) UpdateConfig(cfg Config) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.config = cfg
}

func (m *Manager) GetConfig() Config {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.config
}

func (m *Manager) GetUsage() TokenUsage {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.usage
}

func (m *Manager) ResetUsage() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.usage = TokenUsage{}
}

// maxModelsResponseBytes bounds a model-list response, and maxErrorBodyBytes
// bounds how much of a failing response is quoted back in the error.
//
// The endpoint is user-configurable, so a large or endless body must not be
// able to exhaust memory while the user is only fetching a list. A model list
// is a few kilobytes; an error message is a few lines.
const (
	maxModelsResponseBytes = 8 << 20
	maxErrorBodyBytes      = 4 << 10
)

// readLimited reads a body but refuses to grow past limit. It reads one byte
// beyond the limit so an oversized response is reported as such rather than
// silently truncated into a parse error.
func readLimited(body io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("response exceeded %d bytes", limit)
	}
	return data, nil
}

// rejectedJSONMode reports whether a 400/422 response complains about the
// optional response_format constraint. Any other response is left readable.
func rejectedJSONMode(resp *http.Response) bool {
	if resp.StatusCode != http.StatusBadRequest && resp.StatusCode != http.StatusUnprocessableEntity {
		return false
	}
	data, _ := readLimited(resp.Body, maxErrorBodyBytes)
	resp.Body.Close()
	resp.Body = io.NopCloser(bytes.NewReader(data))
	text := strings.ToLower(string(data))
	for _, marker := range []string{"response_format", "json_object", "json mode", "responsemimetype", "response_mime_type", "generationconfig", "\"format\""} {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

func jsonConstraintKey(body map[string]any) string {
	for _, key := range []string{"response_format", "generationConfig", "format"} {
		if _, ok := body[key]; ok {
			return key
		}
	}
	return ""
}

func (m *Manager) ListModels(cfg Config) ([]string, error) {
	if err := ValidateConfig(cfg); err != nil {
		return nil, err
	}
	if cfg.Provider == ProviderAnthropic || cfg.Provider == ProviderGemini {
		return m.listNativeModels(cfg)
	}
	var url string
	var headers map[string]string

	switch cfg.Provider {
	case ProviderOllama:
		if cfg.Endpoint != "" {
			url = strings.TrimRight(cfg.Endpoint, "/") + "/api/tags"
		} else {
			url = "http://localhost:11434/api/tags"
		}
	default:
		if cfg.Endpoint != "" {
			url = openAIBase(cfg.Endpoint) + "/models"
		} else {
			url = "https://api.openai.com/v1/models"
		}
		if cfg.APIKey != "" {
			headers = map[string]string{"Authorization": "Bearer " + cfg.APIKey}
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := m.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := readLimited(resp.Body, maxErrorBodyBytes)
		return nil, fmt.Errorf("API error (%d): %s", resp.StatusCode, string(respBody))
	}

	body, err := readLimited(resp.Body, maxModelsResponseBytes)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if cfg.Provider == ProviderOllama {
		return parseOllamaModels(body)
	}
	return parseOpenAIModels(body)
}

func parseOpenAIModels(body []byte) ([]string, error) {
	var result struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to parse models: %w", err)
	}
	var models []string
	for _, m := range result.Data {
		models = append(models, m.ID)
	}
	return models, nil
}

func parseOllamaModels(body []byte) ([]string, error) {
	var result struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to parse models: %w", err)
	}
	var models []string
	for _, m := range result.Models {
		models = append(models, m.Name)
	}
	return models, nil
}

func getToolsDefinition() []map[string]any {
	return []map[string]any{
		{
			"type": "function",
			"function": map[string]any{
				"name":        "execute_command",
				"description": "Execute a shell command on the user's SSH-connected server. Diagnose before changing state. A non-zero exit is a remote result, not proof that gxShell blocked the command. For registered credentials, bind secret:// aliases through the secrets object; never request, print, or embed plaintext secret values.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"command": map[string]any{
							"type":        "string",
							"description": "The shell command to execute",
						},
						"shell": map[string]any{
							"type": "string", "enum": []string{"sh", "bash", "dash", "zsh", "ksh"},
							"description": "Shell used when named secrets are injected; defaults to sh",
						},
						"secrets": map[string]any{
							"type":                 "object",
							"additionalProperties": map[string]any{"type": "string", "pattern": `^secret://[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`},
							"description":          "Environment variable to registered secret reference, e.g. API_KEY=secret://anyrouter-api-key. Values remain hidden.",
						},
					},
					"required": []string{"command"},
				},
			},
		},
		{
			"type": "function",
			"function": map[string]any{
				"name":        "read_file",
				"description": "Read the content of a file on the user's remote server. Use this to inspect configuration files, logs, or scripts.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"path": map[string]any{
							"type":        "string",
							"description": "The absolute path of the file to read",
						},
					},
					"required": []string{"path"},
				},
			},
		},
	}
}

type CommandExecutor func(sessionID string, command string) (string, error)

// Chat sends a chat request with default context.
func (m *Manager) Chat(req ChatRequest, onChunk func(ChatResponse)) error {
	return m.ChatWithContext(context.Background(), req, onChunk)
}

// ChatWithContext sends a chat request with cancellation support.
func (m *Manager) ChatWithContext(ctx context.Context, req ChatRequest, onChunk func(ChatResponse)) error {
	m.mu.RLock()
	cfg := m.config
	m.mu.RUnlock()
	return m.ChatWithConfig(ctx, cfg, req, onChunk)
}

// ChatWithConfig pins the provider/model for all turns of a running task.
func (m *Manager) ChatWithConfig(ctx context.Context, cfg Config, req ChatRequest, onChunk func(ChatResponse)) error {
	if err := ValidateConfig(cfg); err != nil {
		return err
	}
	if cfg.Provider == ProviderAnthropic || cfg.Provider == ProviderGemini || cfg.Provider == ProviderOllama {
		return m.chatNative(ctx, cfg, req, onChunk)
	}

	if cfg.Model == "" {
		return fmt.Errorf("AI model not configured")
	}

	endpoint := m.resolveEndpoint(cfg)
	if endpoint == "" {
		return fmt.Errorf("AI endpoint not configured")
	}

	system := m.buildSystemPrompt(req.Context, req.EnableTools)
	if req.Instructions != "" {
		system = req.Instructions
	}
	systemMsg := Message{Role: "system", Content: system}
	messages := append([]Message{systemMsg}, req.Messages...)

	apiMessages := make([]map[string]any, len(messages))
	for i, msg := range messages {
		m := map[string]any{"role": msg.Role}
		if msg.Content != "" {
			m["content"] = msg.Content
		} else if msg.Role == "assistant" && len(msg.ToolCalls) > 0 {
			m["content"] = nil
		} else if msg.Role == "tool" {
			m["content"] = "(no output)"
		} else {
			m["content"] = msg.Content
		}
		if len(msg.ToolCalls) > 0 {
			tcs := make([]map[string]any, len(msg.ToolCalls))
			for j, tc := range msg.ToolCalls {
				tcs[j] = map[string]any{
					"id":   tc.ID,
					"type": tc.Type,
					"function": map[string]any{
						"name":      tc.Function.Name,
						"arguments": tc.Function.Arguments,
					},
				}
			}
			m["tool_calls"] = tcs
		}
		if msg.ToolCallID != "" {
			m["tool_call_id"] = msg.ToolCallID
		}
		if msg.ReasoningContent != "" {
			m["reasoning_content"] = msg.ReasoningContent
		}
		apiMessages[i] = m
	}

	body := map[string]any{
		"model":    cfg.Model,
		"messages": apiMessages,
		"stream":   true,
	}
	if req.EnableTools {
		body["tools"] = getToolsDefinition()
		if req.Tools != nil {
			body["tools"] = req.Tools
		}
	}
	if cfg.Provider == ProviderOpenAI {
		body["stream_options"] = map[string]any{"include_usage": true}
	}
	if req.JSONObject && !req.EnableTools {
		body["response_format"] = map[string]any{"type": "json_object"}
	}
	send := func() (*http.Response, error) {
		bodyBytes, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal request: %w", err)
		}
		httpReq, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(bodyBytes))
		if err != nil {
			return nil, fmt.Errorf("failed to create request: %w", err)
		}
		httpReq.Header.Set("Content-Type", "application/json")
		if cfg.APIKey != "" {
			httpReq.Header.Set("Authorization", "Bearer "+cfg.APIKey)
		}
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
	if jsonConstraintKey(body) != "" && rejectedJSONMode(resp) {
		// Nothing was streamed yet, so dropping the optional constraint and
		// asking again cannot duplicate output.
		resp.Body.Close()
		delete(body, "response_format")
		if resp, err = send(); err != nil {
			return err
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// Bounded like every other error body: a failing or hostile endpoint can
		// answer with an unbounded stream, and the request window here is minutes
		// long. io.ReadAll would buffer it all before the error is even built, and
		// an OOM is not something the stream recovery can catch.
		respBody, _ := readLimited(resp.Body, maxErrorBodyBytes)
		// Summarize only the message shape (role + counts), never the content.
		// Message bodies and tool output can contain terminal data or secrets, and
		// this error is surfaced to the frontend and written to the app log.
		roleCounts := map[string]int{}
		toolCallMsgs := 0
		for _, msg := range apiMessages {
			role, _ := msg["role"].(string)
			roleCounts[role]++
			if _, ok := msg["tool_calls"].([]map[string]any); ok {
				toolCallMsgs++
			}
		}
		return providerError(fmt.Errorf("API error (%d): %s (messages=%d roles=%v toolCallMsgs=%d)",
			resp.StatusCode, string(respBody), len(apiMessages), roleCounts, toolCallMsgs), cfg)
	}

	return providerError(m.parseSSE(resp.Body, onChunk), cfg)
}

func (m *Manager) resolveEndpoint(cfg Config) string {
	if cfg.Provider == ProviderOllama {
		if cfg.Endpoint != "" {
			return strings.TrimRight(cfg.Endpoint, "/") + "/api/chat"
		}
		return "http://localhost:11434/api/chat"
	}
	if cfg.Endpoint != "" {
		return openAIBase(cfg.Endpoint) + "/chat/completions"
	}
	return "https://api.openai.com/v1/chat/completions"
}

func (m *Manager) buildSystemPrompt(context string, enableTools bool) string {
	base := `You are an AI assistant integrated into gxShell, a terminal/SSH client application. You help users diagnose and solve problems in their terminal sessions. Be concise, practical, and provide actionable advice. Format your responses in markdown.

You have tools that can execute commands and read files on the user's remote server. Use them when they materially help, but establish the target and error source before changing state. Continue through diagnosis, an authorized fix, and verification when the evidence supports doing so.

Be thorough without guessing:
1. Run diagnostic commands to investigate the problem
2. Distinguish gxShell policy blocks, transport failures, and remote program exit codes from the structured result and output
3. Based on evidence, run the smallest appropriate fix
4. Verify the fix with a separate check
5. Stop when resolved, when authorization is required, or when evidence is insufficient

For example, if the user has a "cargo/env not found" error:
- Step 1: grep to find which file references it -> get result
- Step 2: sed or other command to remove/fix the line -> get result
- Step 3: source the file or verify the fix -> get result
- Step 4: Summarize what was done

Do not invent a reason for an error. In particular, a non-zero remote exit code does not mean gxShell blocked a command. A gxShell block is explicitly labeled BLOCKED.

IMPORTANT notes about command execution:
- When several diagnostic commands are independent, request them as multiple tool calls in the same assistant response so gxShell can batch approval and run them together.
- Non-zero exit codes (shown as "(exit code: N)") do NOT necessarily mean failure. grep returns 1 for no matches, 2 for partial errors; the output is still useful.
- Always analyze the OUTPUT content, not just the exit code. If the output has useful info, proceed with the next step.
- When you find a problem and the requested scope authorizes a change, fix it and verify it.
- Use sed -i for in-place file edits. Use full paths for reliability.`
	if !enableTools {
		base = `You are an AI assistant integrated into gxShell, a terminal/SSH client application. You help users diagnose and solve problems in their terminal sessions. Be concise, practical, and provide actionable advice. Format your responses in markdown.

No connected remote target is available for tool execution. Do not claim that you ran commands or read files; provide instructions the user can run after connecting a target.`
	}
	if context != "" {
		base += "\n\nCurrent terminal output context:\n```\n" + context + "\n```"
	}
	return base
}

// maxStreamToolCalls bounds how many tool calls one streamed response may
// declare.
//
// The index arrives in the response body, so it is not trustworthy: the
// provider — or anything that can answer in its place — chooses it. A negative
// index would be used to subscript the slice below zero, and a large one would
// drive the growth loop until the process runs out of memory. Neither is
// recoverable from inside the stream, so the value is rejected instead.
const maxStreamToolCalls = 128

func (m *Manager) parseSSE(body io.Reader, onChunk func(ChatResponse)) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	var prompt, completion int
	slots := map[int]*ToolCall{}
	complete := false
	// done records the [DONE] terminator itself, which finish_reason alone
	// does not prove: a cut-off stream can still carry a finish_reason.
	done := false
	reason := ""
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			complete = true
			done = true
			break
		}
		if data == "" {
			continue
		}
		var chunk map[string]any
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return fmt.Errorf("invalid streaming JSON: %w", err)
		}
		if apiErr, ok := chunk["error"]; ok {
			return fmt.Errorf("provider stream error: %v", apiErr)
		}
		if usage, ok := chunk["usage"].(map[string]any); ok {
			prompt = intNumber(usage["prompt_tokens"])
			completion = intNumber(usage["completion_tokens"])
		}
		choices, _ := chunk["choices"].([]any)
		if len(choices) == 0 {
			continue
		}
		choice, _ := choices[0].(map[string]any)
		if value, _ := choice["finish_reason"].(string); value != "" {
			reason = value
			complete = true
		}
		delta, _ := choice["delta"].(map[string]any)
		if value, _ := delta["content"].(string); value != "" {
			onChunk(ChatResponse{Content: value})
		}
		if value, _ := delta["reasoning_content"].(string); value != "" {
			onChunk(ChatResponse{ReasoningContent: value})
		}
		list, _ := delta["tool_calls"].([]any)
		for _, raw := range list {
			item, _ := raw.(map[string]any)
			index := 0
			if n, ok := item["index"].(float64); ok {
				if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n >= maxStreamToolCalls || n != math.Trunc(n) {
					continue
				}
				index = int(n)
			}
			call := slots[index]
			if call == nil {
				call = &ToolCall{Type: "function"}
				slots[index] = call
			}
			if id, _ := item["id"].(string); id != "" {
				call.ID = id
			}
			fn, _ := item["function"].(map[string]any)
			if name, _ := fn["name"].(string); name != "" {
				call.Function.Name = name
			}
			if args, _ := fn["arguments"].(string); args != "" {
				call.Function.Arguments += args
			}
			if len(call.Function.Arguments) > 256*1024 {
				return fmt.Errorf("tool arguments exceed limit")
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("stream interrupted: %w", err)
	}
	if !complete {
		return fmt.Errorf("stream ended before completion")
	}
	if reason != "" && reason != "stop" && reason != "tool_calls" {
		return fmt.Errorf("response did not complete (%s)", reason)
	}
	calls := []ToolCall{}
	// Gemini's OpenAI endpoint, LiteLLM and other relays end tool turns with
	// "stop". Accept that only after [DONE]; every call is still checked for an
	// ID, a name and complete JSON below.
	if len(slots) > 0 && reason != "tool_calls" && !(done && (reason == "stop" || reason == "")) {
		return fmt.Errorf("tool calls without tool completion")
	}
	for index := 0; index < maxStreamToolCalls; index++ {
		call := slots[index]
		if call == nil {
			continue
		}
		if call.ID == "" || call.Function.Name == "" {
			return fmt.Errorf("incomplete tool call")
		}
		if _, err := toolInput(call.Function.Arguments); err != nil {
			return err
		}
		calls = append(calls, *call)
	}
	m.mu.Lock()
	m.usage.PromptTokens += int64(prompt)
	m.usage.CompletionTokens += int64(completion)
	m.usage.TotalTokens += int64(prompt + completion)
	m.mu.Unlock()
	onChunk(ChatResponse{Finish: true, ToolCalls: calls, PromptTk: prompt, CompleteTk: completion})
	return nil
}
