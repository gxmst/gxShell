package main

import (
	"context"
	"encoding/json"
	"errors"
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

type activeAiChat struct {
	chatID    string
	cancel    context.CancelFunc
	cancelled bool
}

type activeAiChatKey struct {
	app       *App
	requestID string
}

// activeAiChats intentionally lives next to the AI entry points instead of on
// App. Keeping this short-lived registry self-contained avoids coupling App's
// lifecycle struct to renderer request bookkeeping; entries are always removed
// when their request goroutine exits.
var activeAiChats = struct {
	sync.Mutex
	items map[activeAiChatKey]*activeAiChat
}{items: make(map[activeAiChatKey]*activeAiChat)}

func registerActiveAiChat(app *App, chatID, requestID string, cancel context.CancelFunc) (*activeAiChat, bool) {
	key := activeAiChatKey{app: app, requestID: requestID}
	activeAiChats.Lock()
	defer activeAiChats.Unlock()
	if _, exists := activeAiChats.items[key]; exists {
		return nil, false
	}
	entry := &activeAiChat{chatID: chatID, cancel: cancel}
	activeAiChats.items[key] = entry
	return entry, true
}

func unregisterActiveAiChat(app *App, requestID string, entry *activeAiChat) {
	key := activeAiChatKey{app: app, requestID: requestID}
	activeAiChats.Lock()
	defer activeAiChats.Unlock()
	if activeAiChats.items[key] == entry {
		delete(activeAiChats.items, key)
	}
}

func cancelActiveAiChat(app *App, chatID, requestID string) bool {
	key := activeAiChatKey{app: app, requestID: requestID}
	activeAiChats.Lock()
	entry := activeAiChats.items[key]
	if entry == nil || entry.chatID != chatID || entry.cancelled {
		activeAiChats.Unlock()
		return false
	}
	entry.cancelled = true
	cancel := entry.cancel
	activeAiChats.Unlock()
	cancel()
	return true
}

type aiChatEvent struct {
	ChatID           string           `json:"chatId"`
	RequestID        string           `json:"requestId"`
	Content          string           `json:"content,omitempty"`
	ReasoningContent string           `json:"reasoningContent,omitempty"`
	Finish           bool             `json:"finish,omitempty"`
	Cancelled        bool             `json:"cancelled,omitempty"`
	Error            string           `json:"error,omitempty"`
	PromptTokens     int              `json:"promptTokens,omitempty"`
	CompletionTokens int              `json:"completionTokens,omitempty"`
	ToolCalls        []map[string]any `json:"toolCalls,omitempty"`
}

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
	return a.startAiChat(req, false)
}

// AiContinueChat continues an existing AI conversation with tool results.
func (a *App) AiContinueChat(req types.AiChatRequest) error {
	return a.startAiChat(req, true)
}

// CancelAiChat cancels one exact renderer request. chatID is checked as well as
// requestID so stale UI state cannot accidentally stop a different chat.
func (a *App) CancelAiChat(chatID, requestID string) bool {
	if strings.TrimSpace(chatID) == "" || strings.TrimSpace(requestID) == "" {
		return false
	}
	return cancelActiveAiChat(a, chatID, requestID)
}

func validateAiChatRequest(req types.AiChatRequest) error {
	if strings.TrimSpace(req.ChatID) == "" {
		return fmt.Errorf("chatId is required")
	}
	if strings.TrimSpace(req.RequestID) == "" {
		return fmt.Errorf("requestId is required")
	}
	if len(req.Messages) == 0 {
		return fmt.Errorf("at least one message is required")
	}
	if req.EnableTools && strings.TrimSpace(req.SessionID) == "" {
		return fmt.Errorf("sessionId is required when AI tools are enabled")
	}
	return nil
}

func (a *App) startAiChat(req types.AiChatRequest, continuing bool) error {
	if err := validateAiChatRequest(req); err != nil {
		return err
	}

	parent := a.ctx
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, aiChatTimeout)
	entry, ok := registerActiveAiChat(a, req.ChatID, req.RequestID, cancel)
	if !ok {
		cancel()
		return fmt.Errorf("AI request %q is already active", req.RequestID)
	}

	cfg := a.ai.GetConfig()
	a.log.InfoFields("AI chat request", LogFields{
		"provider":   cfg.Provider,
		"model":      cfg.Model,
		"endpoint":   cfg.Endpoint,
		"session":    req.SessionID,
		"chat":       req.ChatID,
		"request":    req.RequestID,
		"continue":   continuing,
		"tools":      req.EnableTools,
		"msgs":       len(req.Messages),
		"contextLen": len(req.Context),
	})

	go func() {
		defer cancel()
		defer unregisterActiveAiChat(a, req.RequestID, entry)

		aiReq := toAiChatRequest(req)
		err := a.ai.ChatWithContext(ctx, aiReq, func(resp ai.ChatResponse) {
			if a.ctx == nil {
				return
			}
			event := aiChatEvent{
				ChatID:           req.ChatID,
				RequestID:        req.RequestID,
				Content:          resp.Content,
				ReasoningContent: resp.ReasoningContent,
				Finish:           resp.Finish,
				PromptTokens:     resp.PromptTk,
				CompletionTokens: resp.CompleteTk,
			}
			if len(resp.ToolCalls) > 0 {
				if req.EnableTools {
					a.registerAuthorizedAiToolCalls(req.SessionID, resp.ToolCalls)
				}
				event.ToolCalls = serializeAiToolCalls(resp.ToolCalls)
			}
			runtime.EventsEmit(a.ctx, "ai:chunk", event)
		})

		if err == nil || a.ctx == nil {
			return
		}
		cancelled := errors.Is(ctx.Err(), context.Canceled) || errors.Is(err, context.Canceled)
		if !cancelled {
			a.log.ErrorFields("AI chat error", LogFields{
				"chat":    req.ChatID,
				"request": req.RequestID,
				"error":   err.Error(),
			})
		}
		runtime.EventsEmit(a.ctx, "ai:error", aiChatEvent{
			ChatID:    req.ChatID,
			RequestID: req.RequestID,
			Finish:    true,
			Cancelled: cancelled,
			Error:     err.Error(),
		})
	}()

	return nil
}

func toAiChatRequest(req types.AiChatRequest) ai.ChatRequest {
	aiReq := ai.ChatRequest{
		Messages:    make([]ai.Message, len(req.Messages)),
		Context:     req.Context,
		EnableTools: req.EnableTools,
	}
	for i, message := range req.Messages {
		aiReq.Messages[i] = ai.Message{
			Role:             message.Role,
			Content:          message.Content,
			ReasoningContent: message.ReasoningContent,
			ToolCallID:       message.ToolCallID,
		}
		for _, toolCall := range message.ToolCalls {
			aiReq.Messages[i].ToolCalls = append(aiReq.Messages[i].ToolCalls, ai.ToolCall{
				ID:   toolCall.ID,
				Type: toolCall.Type,
				Function: ai.FunctionCall{
					Name:      toolCall.Function.Name,
					Arguments: toolCall.Function.Arguments,
				},
			})
		}
	}
	return aiReq
}

func serializeAiToolCalls(toolCalls []ai.ToolCall) []map[string]any {
	result := make([]map[string]any, len(toolCalls))
	for i, toolCall := range toolCalls {
		result[i] = map[string]any{
			"id":   toolCall.ID,
			"type": toolCall.Type,
			"function": map[string]any{
				"name":      toolCall.Function.Name,
				"arguments": toolCall.Function.Arguments,
			},
		}
	}
	return result
}

type aiToolExecutionPlan struct {
	ToolCallID   string
	ToolName     string
	Target       string
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
	targetLabel := sessionID
	if a.ssh != nil {
		if info, err := a.ssh.Get(sessionID); err == nil && strings.TrimSpace(info.Name) != "" {
			targetLabel = info.Name
		}
	}
	for i := range plans {
		plans[i].Target = targetLabel
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
	activityID := a.beginTerminalAutomation(sessionID, "ai", plan.ToolName, plan.Command)
	result, err := a.ssh.ExecuteCommandResult(sessionID, plan.Command, aiToolTimeout, aiToolOutputLimit)
	terminalOutput := result.DisplayOutput()
	var output string
	if err != nil {
		if plan.ToolName == "read_file" {
			output = "Error reading file: " + err.Error()
		} else {
			output = "Error executing command: " + err.Error()
		}
	} else if result.DisplayOutput() == "" {
		output = plan.EmptyMessage
	} else {
		output = result.DisplayOutput()
	}
	errorText := ""
	if err != nil {
		errorText = err.Error()
	} else if result.Error != "" {
		errorText = result.Error
	}
	a.finishTerminalAutomation(sessionID, activityID, "ai", plan.ToolName, terminalOutput, errorText, result.ExitCode, result.Duration, result.Truncated)
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
	targetText := "your remote server"
	if strings.TrimSpace(plans[0].Target) != "" {
		targetText = fmt.Sprintf("remote target %q", truncate(plans[0].Target, 120))
	}
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
		message = fmt.Sprintf("The AI assistant requested the following on %s:\n\n%s: %s\n\nAllow this?", targetText, action, truncate(plan.Detail, 500))
	} else {
		items := make([]string, 0, len(plans))
		for _, plan := range plans {
			prefix := "Command"
			if plan.ToolName == "read_file" {
				prefix = "Read file"
			}
			items = append(items, prefix+": "+plan.Detail)
		}
		message = fmt.Sprintf("The AI assistant requested %d actions on %s:\n\n%s\n\nAllow all of these?", len(plans), targetText, formatApprovalList(items))
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
