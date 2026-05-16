package ai

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
)

type Provider string

const (
	ProviderOpenAI Provider = "openai"
	ProviderOllama Provider = "ollama"
	ProviderCustom Provider = "custom"
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
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function FunctionCall `json:"function"`
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
	return &Manager{
		client: &http.Client{},
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

func (m *Manager) ListModels(cfg Config) ([]string, error) {
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
			url = strings.TrimRight(cfg.Endpoint, "/") + "/models"
		} else {
			url = "https://api.openai.com/v1/models"
		}
		if cfg.APIKey != "" {
			headers = map[string]string{"Authorization": "Bearer " + cfg.APIKey}
		}
	}

	req, err := http.NewRequest("GET", url, nil)
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
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error (%d): %s", resp.StatusCode, string(respBody))
	}

	body, err := io.ReadAll(resp.Body)
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
				"description": "Execute a shell command on the user's remote terminal and return the output. Use this to diagnose issues, check system state, or fix problems. Commands run on the user's SSH-connected server.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"command": map[string]any{
							"type":        "string",
							"description": "The shell command to execute",
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

func (m *Manager) Chat(req ChatRequest, onChunk func(ChatResponse)) error {
	m.mu.RLock()
	cfg := m.config
	m.mu.RUnlock()

	if cfg.Model == "" {
		return fmt.Errorf("AI model not configured")
	}

	endpoint := m.resolveEndpoint(cfg)
	if endpoint == "" {
		return fmt.Errorf("AI endpoint not configured")
	}

	systemMsg := Message{Role: "system", Content: m.buildSystemPrompt(req.Context)}
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
		"tools":    getToolsDefinition(),
	}
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("failed to marshal request: %w", err)
	}

	httpReq, err := http.NewRequest("POST", endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if cfg.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	}

	resp, err := m.client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		msgSummary := ""
		for i, msg := range apiMessages {
			role, _ := msg["role"].(string)
			tcId, _ := msg["tool_call_id"].(string)
			content, _ := msg["content"].(string)
			if len(content) > 80 {
				content = content[:80] + "..."
			}
			hasTC := ""
			if tcs, ok := msg["tool_calls"].([]map[string]any); ok {
				hasTC = fmt.Sprintf(" tool_calls=%d", len(tcs))
			}
			tcIdStr := ""
			if tcId != "" {
				tcIdStr = fmt.Sprintf(" tool_call_id=%s", tcId)
			}
			msgSummary += fmt.Sprintf("\n  [%d] role=%s content=%q%s%s", i, role, content, hasTC, tcIdStr)
		}
		return fmt.Errorf("API error (%d): %s\nMessages:%s", resp.StatusCode, string(respBody), msgSummary)
	}

	if cfg.Provider == ProviderOllama {
		return m.parseOllamaStream(resp.Body, onChunk)
	}
	return m.parseSSE(resp.Body, onChunk)
}

func (m *Manager) resolveEndpoint(cfg Config) string {
	if cfg.Provider == ProviderOllama {
		if cfg.Endpoint != "" {
			return strings.TrimRight(cfg.Endpoint, "/") + "/api/chat"
		}
		return "http://localhost:11434/api/chat"
	}
	if cfg.Endpoint != "" {
		return strings.TrimRight(cfg.Endpoint, "/") + "/chat/completions"
	}
	return "https://api.openai.com/v1/chat/completions"
}

func (m *Manager) buildSystemPrompt(context string) string {
	base := `You are an AI assistant integrated into gxShell, a terminal/SSH client application. You help users diagnose and solve problems in their terminal sessions. Be concise, practical, and provide actionable advice. Format your responses in markdown.

You have access to tools that let you execute commands and read files on the user's remote server. You MUST use them proactively and CONTINUOUSLY until the problem is fully resolved. Do NOT stop after a single step — chain multiple tool calls together to complete the entire workflow.

CRITICAL: Be autonomous and thorough. When you start diagnosing or fixing an issue, keep going until it's done:
1. Run diagnostic commands to investigate the problem
2. Based on the results, run the fix commands immediately
3. Verify the fix worked by running check commands
4. Only stop when the issue is confirmed resolved or you need user input

For example, if the user has a "cargo/env not found" error:
- Step 1: grep to find which file references it → get result
- Step 2: sed or other command to remove/fix the line → get result
- Step 3: source the file or verify the fix → get result
- Step 4: Summarize what was done

Do ALL steps in one response by making multiple tool calls. Never stop after just diagnosing — always proceed to fix and verify.

IMPORTANT notes about command execution:
- Non-zero exit codes (shown as "(exit code: N)") do NOT necessarily mean failure. grep returns 1 for no matches, 2 for partial errors — the output is still useful.
- Always analyze the OUTPUT content, not just the exit code. If the output has useful info, proceed with the next step.
- When you find a problem, fix it directly (sed, rm, mv, etc.). Don't just report it and wait.
- Use sed -i for in-place file edits. Use full paths for reliability.`
	if context != "" {
		base += "\n\nCurrent terminal output context:\n```\n" + context + "\n```"
	}
	return base
}

func (m *Manager) parseOllamaStream(body io.Reader, onChunk func(ChatResponse)) error {
	scanner := bufio.NewScanner(body)
	var promptTk, completeTk int

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		var chunk map[string]any
		if err := json.Unmarshal([]byte(line), &chunk); err != nil {
			continue
		}

		if done, ok := chunk["done"].(bool); ok && done {
			break
		}

		if msg, ok := chunk["message"].(map[string]any); ok {
			if content, ok := msg["content"].(string); ok && content != "" {
				onChunk(ChatResponse{Content: content, Finish: false})
			}
		}

		if evalCount, ok := chunk["eval_count"].(float64); ok {
			completeTk = int(evalCount)
		}
		if promptEvalCount, ok := chunk["prompt_eval_count"].(float64); ok {
			promptTk = int(promptEvalCount)
		}
	}

	onChunk(ChatResponse{
		Content:    "",
		Finish:     true,
		PromptTk:   promptTk,
		CompleteTk: completeTk,
	})

	m.mu.Lock()
	m.usage.PromptTokens += int64(promptTk)
	m.usage.CompletionTokens += int64(completeTk)
	m.usage.TotalTokens += int64(promptTk + completeTk)
	m.mu.Unlock()

	return nil
}

func (m *Manager) parseSSE(body io.Reader, onChunk func(ChatResponse)) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	var contentBuf strings.Builder
	var reasoningBuf strings.Builder
	var promptTk, completeTk int
	var toolCalls []ToolCall
	var hasToolCalls bool

	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		if data == "[DONE]" {
			break
		}

		var chunk map[string]any
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}

		if usage, ok := chunk["usage"].(map[string]any); ok {
			if pt, ok := usage["prompt_tokens"].(float64); ok {
				promptTk = int(pt)
			}
			if ct, ok := usage["completion_tokens"].(float64); ok {
				completeTk = int(ct)
			}
		}

		choices, ok := chunk["choices"].([]any)
		if !ok || len(choices) == 0 {
			continue
		}
		choice, ok := choices[0].(map[string]any)
		if !ok {
			continue
		}

		finishReason, _ := choice["finish_reason"].(string)

		delta, ok := choice["delta"].(map[string]any)
		if !ok {
			continue
		}

		if c, ok := delta["content"].(string); ok && c != "" {
			contentBuf.WriteString(c)
			onChunk(ChatResponse{Content: c, Finish: false})
		}

		if rc, ok := delta["reasoning_content"].(string); ok && rc != "" {
			reasoningBuf.WriteString(rc)
			onChunk(ChatResponse{ReasoningContent: rc, Finish: false})
		}

		if tcList, ok := delta["tool_calls"].([]any); ok {
			hasToolCalls = true
			for _, tcRaw := range tcList {
				tcMap, ok := tcRaw.(map[string]any)
				if !ok {
					continue
				}
				idx := 0
				if idxFloat, ok := tcMap["index"].(float64); ok {
					idx = int(idxFloat)
				}
				for len(toolCalls) <= idx {
					toolCalls = append(toolCalls, ToolCall{})
				}
				if id, ok := tcMap["id"].(string); ok && id != "" {
					toolCalls[idx].ID = id
				}
				if typ, ok := tcMap["type"].(string); ok && typ != "" {
					toolCalls[idx].Type = typ
				}
				if fn, ok := tcMap["function"].(map[string]any); ok {
					if name, ok := fn["name"].(string); ok && name != "" {
						toolCalls[idx].Function.Name = name
					}
					if args, ok := fn["arguments"].(string); ok {
						toolCalls[idx].Function.Arguments += args
					}
				}
			}
		}

		if finishReason == "tool_calls" {
			if hasToolCalls && len(toolCalls) > 0 {
				onChunk(ChatResponse{
					Finish:     true,
					PromptTk:   promptTk,
					CompleteTk: completeTk,
					ToolCalls:  toolCalls,
				})
			}
		}
	}

	if !hasToolCalls {
		onChunk(ChatResponse{
			Content:    "",
			Finish:     true,
			PromptTk:   promptTk,
			CompleteTk: completeTk,
		})
	}

	m.mu.Lock()
	m.usage.PromptTokens += int64(promptTk)
	m.usage.CompletionTokens += int64(completeTk)
	m.usage.TotalTokens += int64(promptTk + completeTk)
	m.mu.Unlock()

	return nil
}
