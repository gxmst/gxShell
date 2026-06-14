package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"gxShell/backend/ai"
	"gxShell/backend/logger"
	"gxShell/backend/types"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// LogFields is an alias for structured logging.
type LogFields = logger.LogFields

const (
	aiToolTimeout          = 20 * time.Second
	aiToolOutputLimit      = 128 * 1024
	aiToolAuthorizationTTL = 15 * time.Minute
	aiChatTimeout          = 5 * time.Minute
)

// SaveAiConfig saves AI provider configuration and API key.
func (a *App) SaveAiConfig(provider, apiKey, endpoint, model string) error {
	// Detect masked API key and preserve existing key
	if strings.Contains(apiKey, "****") {
		existing := a.ai.GetConfig()
		apiKey = existing.APIKey
	}

	a.log.InfoFields("SaveAiConfig", LogFields{
		"provider":  provider,
		"model":     model,
		"endpoint":  endpoint,
		"apiKeyLen": len(apiKey),
	})

	a.ai.UpdateConfig(ai.Config{
		Provider: ai.Provider(provider),
		APIKey:   apiKey,
		Endpoint: endpoint,
		Model:    model,
	})

	settings, err := a.store.GetSettings()
	if err != nil {
		a.log.ErrorFields("SaveAiConfig: failed to read settings", LogFields{"error": err.Error()})
		return err
	}

	// Store API key in secure storage
	if apiKey == "" {
		a.secrets.Delete(aiConfigSecretID)
	} else if err := a.secrets.SavePassword(aiConfigSecretID, apiKey); err != nil {
		a.log.ErrorFields("SaveAiConfig: failed to save API key", LogFields{"error": err.Error()})
		return err
	}

	// Save non-sensitive config to settings
	settings.Ai = types.AiConfig{
		Provider: provider,
		Endpoint: endpoint,
		Model:    model,
	}
	if err := a.store.SaveSettings(settings); err != nil {
		a.log.ErrorFields("SaveAiConfig: failed to save settings", LogFields{"error": err.Error()})
		return err
	}

	a.log.Info("SaveAiConfig: saved to file successfully")
	return nil
}

// GetAiConfig returns AI configuration with masked API key.
func (a *App) GetAiConfig() types.AiConfig {
	cfg := a.ai.GetConfig()
	maskedKey := ""
	if cfg.APIKey != "" {
		if len(cfg.APIKey) > 8 {
			maskedKey = cfg.APIKey[:4] + "****" + cfg.APIKey[len(cfg.APIKey)-4:]
		} else {
			maskedKey = "****"
		}
	}
	return types.AiConfig{
		Provider: string(cfg.Provider),
		APIKey:   maskedKey,
		Endpoint: cfg.Endpoint,
		Model:    cfg.Model,
	}
}

// AiChat starts a new AI conversation with context timeout.
func (a *App) AiChat(req types.AiChatRequest) error {
	cfg := a.ai.GetConfig()
	a.log.InfoFields("AI chat request", LogFields{
		"provider":   cfg.Provider,
		"model":      cfg.Model,
		"endpoint":   cfg.Endpoint,
		"session":    req.SessionID,
		"msgs":       len(req.Messages),
		"contextLen": len(req.Context),
	})

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), aiChatTimeout)
		defer cancel()

		aiReq := ai.ChatRequest{
			Messages: make([]ai.Message, len(req.Messages)),
			Context:  req.Context,
		}
		for i, m := range req.Messages {
			aiReq.Messages[i] = ai.Message{Role: m.Role, Content: m.Content}
		}

		if len(aiReq.Messages) > 0 {
			lastMsg := aiReq.Messages[len(aiReq.Messages)-1]
			a.log.InfoFields("AI chat last msg", LogFields{
				"role":       lastMsg.Role,
				"contentLen": len(lastMsg.Content),
			})
		}

		err := a.ai.ChatWithContext(ctx, aiReq, func(resp ai.ChatResponse) {
			if a.ctx != nil {
				event := map[string]any{
					"content":          resp.Content,
					"finish":           resp.Finish,
					"promptTokens":     resp.PromptTk,
					"completionTokens": resp.CompleteTk,
				}
				if resp.ReasoningContent != "" {
					event["reasoningContent"] = resp.ReasoningContent
				}
				if len(resp.ToolCalls) > 0 {
					a.registerAuthorizedAiToolCalls(req.SessionID, resp.ToolCalls)
					tcData := make([]map[string]any, len(resp.ToolCalls))
					for i, tc := range resp.ToolCalls {
						tcData[i] = map[string]any{
							"id":   tc.ID,
							"type": tc.Type,
							"function": map[string]any{
								"name":      tc.Function.Name,
								"arguments": tc.Function.Arguments,
							},
						}
					}
					event["toolCalls"] = tcData
				}
				runtime.EventsEmit(a.ctx, "ai:chunk", event)
			}
		})

		if err != nil && a.ctx != nil {
			a.log.ErrorFields("AI chat error", LogFields{"error": err.Error()})
			runtime.EventsEmit(a.ctx, "ai:error", map[string]any{"error": err.Error()})
		}
	}()

	return nil
}

// AiContinueChat continues an existing AI conversation with tool results.
func (a *App) AiContinueChat(req types.AiChatRequest) error {
	a.log.InfoFields("AI continue chat", LogFields{
		"session": req.SessionID,
		"msgs":    len(req.Messages),
	})

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), aiChatTimeout)
		defer cancel()

		aiReq := ai.ChatRequest{
			Messages: make([]ai.Message, len(req.Messages)),
			Context:  req.Context,
		}
		for i, m := range req.Messages {
			aiReq.Messages[i] = ai.Message{
				Role:             m.Role,
				Content:          m.Content,
				ReasoningContent: m.ReasoningContent,
				ToolCallID:       m.ToolCallID,
			}
			for _, tc := range m.ToolCalls {
				aiReq.Messages[i].ToolCalls = append(aiReq.Messages[i].ToolCalls, ai.ToolCall{
					ID:   tc.ID,
					Type: tc.Type,
					Function: ai.FunctionCall{
						Name:      tc.Function.Name,
						Arguments: tc.Function.Arguments,
					},
				})
			}
		}

		err := a.ai.ChatWithContext(ctx, aiReq, func(resp ai.ChatResponse) {
			if a.ctx != nil {
				event := map[string]any{
					"content":          resp.Content,
					"finish":           resp.Finish,
					"promptTokens":     resp.PromptTk,
					"completionTokens": resp.CompleteTk,
				}
				if resp.ReasoningContent != "" {
					event["reasoningContent"] = resp.ReasoningContent
				}
				if len(resp.ToolCalls) > 0 {
					a.registerAuthorizedAiToolCalls(req.SessionID, resp.ToolCalls)
					tcData := make([]map[string]any, len(resp.ToolCalls))
					for i, tc := range resp.ToolCalls {
						tcData[i] = map[string]any{
							"id":   tc.ID,
							"type": tc.Type,
							"function": map[string]any{
								"name":      tc.Function.Name,
								"arguments": tc.Function.Arguments,
							},
						}
					}
					event["toolCalls"] = tcData
				}
				runtime.EventsEmit(a.ctx, "ai:chunk", event)
			}
		})

		if err != nil && a.ctx != nil {
			a.log.ErrorFields("AI continue chat error", LogFields{"error": err.Error()})
			runtime.EventsEmit(a.ctx, "ai:error", map[string]any{"error": err.Error()})
		}
	}()

	return nil
}

// AiExecuteTool executes an authorized AI tool call after user confirmation.
func (a *App) AiExecuteTool(sessionID string, toolCallID string) string {
	toolCall, err := a.claimAuthorizedAiToolCall(sessionID, toolCallID)
	if err != nil {
		a.log.ErrorFields("AI tool authorization failed", LogFields{
			"session":    sessionID,
			"toolCallID": toolCallID,
			"error":      err.Error(),
		})
		return "BLOCKED: " + err.Error()
	}

	toolName := toolCall.ToolName
	arguments := toolCall.Arguments
	a.log.InfoFields("AI execute authorized tool", LogFields{
		"session":    sessionID,
		"toolCallID": toolCallID,
		"tool":       toolName,
		"args":       truncate(arguments, 200),
	})

	var output string
	switch toolName {
	case "execute_command":
		var args struct {
			Command string `json:"command"`
		}
		if err := json.Unmarshal([]byte(arguments), &args); err != nil {
			output = "Error parsing command arguments: " + err.Error()
			break
		}
		// Shared safety policy: dangerous-command and sensitive-path blocklists,
		// then an explicit native confirmation a compromised renderer cannot
		// forge. AI tools keep confirmation for every allowed command.
		if reason, ok := guardCommand(args.Command, false, func() bool {
			return a.confirmAiToolExecution(toolName, args.Command)
		}); !ok {
			output = "BLOCKED: " + reason
			a.log.ErrorFields("AI tool command blocked", LogFields{"command": args.Command, "reason": reason})
			break
		}
		result, err := a.ssh.ExecuteCommand(sessionID, args.Command, aiToolTimeout, aiToolOutputLimit)
		if err != nil {
			output = "Error executing command: " + err.Error()
		} else {
			if result == "" {
				output = "(command produced no output)"
			} else {
				output = result
			}
		}
		a.log.InfoFields("AI tool result", LogFields{
			"tool":      toolName,
			"outputLen": len(output),
		})

	case "read_file":
		var args struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal([]byte(arguments), &args); err != nil {
			output = "Error parsing file path arguments: " + err.Error()
			break
		}
		cmd := "cat " + shellescape(args.Path)
		// Same shared policy as execute_command. The sensitive-path blocklist
		// (checked inside guardCommand against the full command) still blocks
		// reads of /etc/shadow, SSH keys, etc.; AI file reads still require a
		// native confirmation after passing those guards.
		if reason, ok := guardCommand(cmd, false, func() bool {
			return a.confirmAiToolExecution(toolName, args.Path)
		}); !ok {
			output = "BLOCKED: " + reason
			a.log.ErrorFields("AI tool file read blocked", LogFields{"path": args.Path, "reason": reason})
			break
		}
		result, err := a.ssh.ExecuteCommand(sessionID, cmd, aiToolTimeout, aiToolOutputLimit)
		if err != nil {
			output = "Error reading file: " + err.Error()
		} else {
			if result == "" {
				output = "(file is empty)"
			} else {
				output = result
			}
		}
		a.log.InfoFields("AI tool result", LogFields{
			"tool":      toolName,
			"path":      args.Path,
			"outputLen": len(output),
		})

	default:
		output = "Unknown tool: " + toolName
	}

	return output
}

// GetAiUsage returns cumulative token usage statistics.
func (a *App) GetAiUsage() types.AiTokenUsage {
	u := a.ai.GetUsage()
	return types.AiTokenUsage{
		PromptTokens:     u.PromptTokens,
		CompletionTokens: u.CompletionTokens,
		TotalTokens:      u.TotalTokens,
	}
}

// ResetAiUsage resets the token usage counters.
func (a *App) ResetAiUsage() {
	a.ai.ResetUsage()
}

// ListAiModels fetches available models from the AI provider.
func (a *App) ListAiModels(provider, apiKey, endpoint string) ([]string, error) {
	if strings.Contains(apiKey, "****") {
		apiKey = a.ai.GetConfig().APIKey
	}
	return a.ai.ListModels(ai.Config{
		Provider: ai.Provider(provider),
		APIKey:   apiKey,
		Endpoint: endpoint,
	})
}

func (a *App) registerAuthorizedAiToolCalls(sessionID string, toolCalls []ai.ToolCall) {
	if sessionID == "" || len(toolCalls) == 0 {
		return
	}
	now := time.Now()
	a.aiToolMu.Lock()
	defer a.aiToolMu.Unlock()
	if a.aiTools == nil {
		a.aiTools = map[string]authorizedAIToolCall{}
	}
	a.pruneExpiredAuthorizedAiToolCallsLocked(now)
	for _, tc := range toolCalls {
		if tc.ID == "" || !isAllowedAiTool(tc.Function.Name) {
			continue
		}
		key := aiToolAuthorizationKey(sessionID, tc.ID)
		if _, exists := a.aiTools[key]; exists {
			a.log.ErrorFields("AI tool ID collision detected", LogFields{
				"session":    sessionID,
				"toolCallID": tc.ID,
				"toolName":   tc.Function.Name,
			})
			continue
		}
		a.aiTools[key] = authorizedAIToolCall{
			SessionID:  sessionID,
			ToolCallID: tc.ID,
			ToolName:   tc.Function.Name,
			Arguments:  tc.Function.Arguments,
			ExpiresAt:  now.Add(aiToolAuthorizationTTL),
		}
	}
}

func (a *App) claimAuthorizedAiToolCall(sessionID string, toolCallID string) (authorizedAIToolCall, error) {
	if sessionID == "" || toolCallID == "" {
		return authorizedAIToolCall{}, errors.New("missing AI tool authorization")
	}
	now := time.Now()
	a.aiToolMu.Lock()
	defer a.aiToolMu.Unlock()
	if a.aiTools == nil {
		a.aiTools = map[string]authorizedAIToolCall{}
	}
	a.pruneExpiredAuthorizedAiToolCallsLocked(now)
	key := aiToolAuthorizationKey(sessionID, toolCallID)
	toolCall, ok := a.aiTools[key]
	if !ok {
		return authorizedAIToolCall{}, errors.New("AI tool call was not authorized by the backend")
	}
	delete(a.aiTools, key)
	if now.After(toolCall.ExpiresAt) {
		return authorizedAIToolCall{}, errors.New("AI tool authorization expired")
	}
	return toolCall, nil
}

// discardAuthorizedAiToolCalls removes all authorized tool calls for a session.
func (a *App) discardAuthorizedAiToolCalls(sessionID string) {
	if sessionID == "" {
		return
	}
	a.aiToolMu.Lock()
	defer a.aiToolMu.Unlock()
	for key, toolCall := range a.aiTools {
		if toolCall.SessionID == sessionID {
			delete(a.aiTools, key)
		}
	}
}

// pruneExpiredAuthorizedAiToolCallsLocked removes expired authorizations (must hold lock).
func (a *App) pruneExpiredAuthorizedAiToolCallsLocked(now time.Time) {
	for key, toolCall := range a.aiTools {
		if now.After(toolCall.ExpiresAt) {
			delete(a.aiTools, key)
		}
	}
}

// aiToolAuthorizationKey creates a unique key for tool call authorization.
func aiToolAuthorizationKey(sessionID string, toolCallID string) string {
	return sessionID + "\x00" + toolCallID
}

// isAllowedAiTool checks if a tool name is allowed for AI execution.
func isAllowedAiTool(toolName string) bool {
	return toolName == "execute_command" || toolName == "read_file"
}

// confirmAiToolExecution shows a native OS confirmation dialog before an AI
// tool runs against the SSH session. This is the trust boundary: a compromised
// renderer can invoke AiExecuteTool, but it cannot forge the user's click on
// this native dialog, so the model can never run a command without a real human
// approving the exact action.
func (a *App) confirmAiToolExecution(toolName, detail string) bool {
	if a.ctx == nil {
		return false
	}
	var title, action string
	switch toolName {
	case "execute_command":
		title = "AI wants to run a command"
		action = "Command"
	case "read_file":
		title = "AI wants to read a file"
		action = "Path"
	default:
		return false
	}
	res, err := runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
		Type:          runtime.QuestionDialog,
		Title:         title,
		Message:       fmt.Sprintf("The AI assistant requested the following on your remote server:\n\n%s: %s\n\nAllow this?", action, truncate(detail, 500)),
		Buttons:       []string{"Allow", "Deny"},
		DefaultButton: "Deny",
		CancelButton:  "Deny",
	})
	if err != nil {
		a.log.ErrorFields("AI tool confirm dialog failed", LogFields{"error": err.Error()})
		return false
	}
	return res == "Allow" || res == "Yes"
}
