package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
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
	aiMaxParallelTools     = 4
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
		parent := a.ctx
		if parent == nil {
			parent = context.Background()
		}
		ctx, cancel := context.WithTimeout(parent, aiChatTimeout)
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
		parent := a.ctx
		if parent == nil {
			parent = context.Background()
		}
		ctx, cancel := context.WithTimeout(parent, aiChatTimeout)
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

type aiToolExecutionPlan struct {
	ToolCallID   string
	ToolName     string
	Command      string
	Detail       string
	EmptyMessage string
}

// AiExecuteTool executes one authorized AI tool call after user confirmation.
func (a *App) AiExecuteTool(sessionID string, toolCallID string) string {
	results := a.AiExecuteTools(sessionID, []string{toolCallID})
	if output, ok := results[toolCallID]; ok {
		return output
	}
	return "BLOCKED: missing AI tool result"
}

// AiExecuteTools executes multiple authorized AI tool calls after one native
// confirmation. Independent commands are run in parallel after approval.
func (a *App) AiExecuteTools(sessionID string, toolCallIDs []string) map[string]string {
	results := map[string]string{}
	if sessionID == "" || len(toolCallIDs) == 0 {
		return results
	}

	plans := make([]aiToolExecutionPlan, 0, len(toolCallIDs))
	for _, toolCallID := range toolCallIDs {
		toolCall, err := a.claimAuthorizedAiToolCall(sessionID, toolCallID)
		if err != nil {
			a.log.ErrorFields("AI tool authorization failed", LogFields{
				"session":    sessionID,
				"toolCallID": toolCallID,
				"error":      err.Error(),
			})
			results[toolCallID] = "BLOCKED: " + err.Error()
			continue
		}
		a.log.InfoFields("AI execute authorized tool", LogFields{
			"session":    sessionID,
			"toolCallID": toolCallID,
			"tool":       toolCall.ToolName,
			"args":       truncate(toolCall.Arguments, 200),
		})
		plan, output, ok := a.prepareAiToolExecution(toolCall)
		if !ok {
			results[toolCall.ToolCallID] = output
			continue
		}
		plans = append(plans, plan)
	}

	if len(plans) == 0 {
		return results
	}
	if !a.confirmAiToolExecutionBatch(plans) {
		for _, plan := range plans {
			results[plan.ToolCallID] = "BLOCKED: user declined execution"
		}
		return results
	}

	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, aiMaxParallelTools)
	for _, plan := range plans {
		plan := plan
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			output := a.executeAiToolPlan(sessionID, plan)
			mu.Lock()
			results[plan.ToolCallID] = output
			mu.Unlock()
		}()
	}
	wg.Wait()
	return results
}

func (a *App) prepareAiToolExecution(toolCall authorizedAIToolCall) (aiToolExecutionPlan, string, bool) {
	switch toolCall.ToolName {
	case "execute_command":
		var args struct {
			Command string `json:"command"`
		}
		if err := json.Unmarshal([]byte(toolCall.Arguments), &args); err != nil {
			return aiToolExecutionPlan{}, "Error parsing command arguments: " + err.Error(), false
		}
		if reason, ok := validateAiToolCommand(args.Command); !ok {
			a.log.ErrorFields("AI tool command blocked", LogFields{"command": args.Command, "reason": reason})
			return aiToolExecutionPlan{}, "BLOCKED: " + reason, false
		}
		return aiToolExecutionPlan{
			ToolCallID:   toolCall.ToolCallID,
			ToolName:     toolCall.ToolName,
			Command:      args.Command,
			Detail:       args.Command,
			EmptyMessage: "(command produced no output)",
		}, "", true

	case "read_file":
		var args struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal([]byte(toolCall.Arguments), &args); err != nil {
			return aiToolExecutionPlan{}, "Error parsing file path arguments: " + err.Error(), false
		}
		cmd := "cat " + shellescape(args.Path)
		if reason, ok := validateAiToolCommand(cmd); !ok {
			a.log.ErrorFields("AI tool file read blocked", LogFields{"path": args.Path, "reason": reason})
			return aiToolExecutionPlan{}, "BLOCKED: " + reason, false
		}
		return aiToolExecutionPlan{
			ToolCallID:   toolCall.ToolCallID,
			ToolName:     toolCall.ToolName,
			Command:      cmd,
			Detail:       args.Path,
			EmptyMessage: "(file is empty)",
		}, "", true

	default:
		return aiToolExecutionPlan{}, "Unknown tool: " + toolCall.ToolName, false
	}
}

func validateAiToolCommand(command string) (string, bool) {
	if block, blocked := checkCommandPreflightBlock(command); blocked {
		return block.Message(), false
	}
	return "", true
}

func (a *App) executeAiToolPlan(sessionID string, plan aiToolExecutionPlan) string {
	result, err := a.ssh.ExecuteCommand(sessionID, plan.Command, aiToolTimeout, aiToolOutputLimit)
	var output string
	if err != nil {
		if plan.ToolName == "read_file" {
			output = "Error reading file: " + err.Error()
		} else {
			output = "Error executing command: " + err.Error()
		}
	} else if result == "" {
		output = plan.EmptyMessage
	} else {
		output = result
	}
	a.log.InfoFields("AI tool result", LogFields{
		"tool":      plan.ToolName,
		"outputLen": len(output),
	})
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

// registerAuthorizedAiToolCalls records the tool calls the model requested this
// turn as backend-authorized, delegating to the trust ledger. See aiToolRegistry.
func (a *App) registerAuthorizedAiToolCalls(sessionID string, toolCalls []ai.ToolCall) {
	a.aiTools.register(sessionID, toolCalls)
}

// claimAuthorizedAiToolCall consumes a one-time authorization for execution.
func (a *App) claimAuthorizedAiToolCall(sessionID string, toolCallID string) (authorizedAIToolCall, error) {
	return a.aiTools.claim(sessionID, toolCallID)
}

// discardAuthorizedAiToolCalls removes all authorized tool calls for a session.
func (a *App) discardAuthorizedAiToolCalls(sessionID string) {
	a.aiTools.discard(sessionID)
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
	return a.confirmAiToolExecutionBatch([]aiToolExecutionPlan{{
		ToolName: toolName,
		Detail:   detail,
	}})
}

func (a *App) confirmAiToolExecutionBatch(plans []aiToolExecutionPlan) bool {
	if a.ctx == nil {
		return false
	}
	if len(plans) == 0 {
		return false
	}
	title := "AI wants to run tools"
	message := ""
	if len(plans) == 1 {
		plan := plans[0]
		var action string
		switch plan.ToolName {
		case "execute_command":
			title = "AI wants to run a command"
			action = "Command"
		case "read_file":
			title = "AI wants to read a file"
			action = "Path"
		default:
			return false
		}
		message = fmt.Sprintf("The AI assistant requested the following on your remote server:\n\n%s: %s\n\nAllow this?", action, truncate(plan.Detail, 500))
	} else {
		items := make([]string, 0, len(plans))
		for _, plan := range plans {
			prefix := "Command"
			if plan.ToolName == "read_file" {
				prefix = "Read file"
			}
			items = append(items, prefix+": "+plan.Detail)
		}
		message = fmt.Sprintf("The AI assistant requested %d actions on your remote server:\n\n%s\n\nAllow all of these?", len(plans), formatApprovalList(items))
	}
	a.nativeDialogMu.Lock()
	defer a.nativeDialogMu.Unlock()
	buttons := []string{"Allow all", "Deny"}
	if len(plans) == 1 {
		buttons = []string{"Allow", "Deny"}
	}
	res, err := runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
		Type:          runtime.QuestionDialog,
		Title:         title,
		Message:       message,
		Buttons:       buttons,
		DefaultButton: "Deny",
		CancelButton:  "Deny",
	})
	if err != nil {
		a.log.ErrorFields("AI tool confirm dialog failed", LogFields{"error": err.Error()})
		return false
	}
	return res == "Allow all" || res == "Allow" || res == "Yes"
}
