package main

import (
	"errors"
	"sync"
	"time"

	"gxShell/backend/ai"
)

// aiToolRegistry holds the backend-authorized AI tool calls awaiting execution.
//
// It is the trust ledger for the AI assistant: when the model asks to run a
// tool, the backend records the exact (session, toolCallID, name, arguments)
// here with a short TTL. AiExecuteTool later claims the entry — a one-time,
// session-scoped, expiring lookup — so a compromised renderer cannot run a tool
// the backend never authorized, replay a call, or steal another session's call.
//
// It is extracted from App as a small, self-contained subsystem so this
// authorization boundary can be reasoned about and tested in isolation. A
// logCollision callback lets the owner record ID collisions without coupling
// the registry to the logger.
type aiToolRegistry struct {
	mu           sync.Mutex
	calls        map[string]authorizedAIToolCall
	ttl          time.Duration
	logCollision func(sessionID, toolCallID, toolName string)
}

func newAiToolRegistry(ttl time.Duration, logCollision func(sessionID, toolCallID, toolName string)) *aiToolRegistry {
	return &aiToolRegistry{
		calls:        map[string]authorizedAIToolCall{},
		ttl:          ttl,
		logCollision: logCollision,
	}
}

// register records the allowed tool calls from one model turn, each with a
// fresh TTL. Unknown tool names and blank IDs are skipped; a duplicate ID for a
// session is reported via logCollision and left untouched.
func (r *aiToolRegistry) register(sessionID string, toolCalls []ai.ToolCall) {
	if sessionID == "" || len(toolCalls) == 0 {
		return
	}
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pruneLocked(now)
	for _, tc := range toolCalls {
		if tc.ID == "" || !isAllowedAiTool(tc.Function.Name) {
			continue
		}
		key := aiToolAuthorizationKey(sessionID, tc.ID)
		if _, exists := r.calls[key]; exists {
			if r.logCollision != nil {
				r.logCollision(sessionID, tc.ID, tc.Function.Name)
			}
			continue
		}
		r.calls[key] = authorizedAIToolCall{
			SessionID:  sessionID,
			ToolCallID: tc.ID,
			ToolName:   tc.Function.Name,
			Arguments:  tc.Function.Arguments,
			ExpiresAt:  now.Add(r.ttl),
		}
	}
}

// claim consumes and returns the authorization for (sessionID, toolCallID). It
// is one-time: the entry is always deleted, so a second claim (or a replay)
// fails. An expired entry is deleted and reported as expired.
func (r *aiToolRegistry) claim(sessionID string, toolCallID string) (authorizedAIToolCall, error) {
	if sessionID == "" || toolCallID == "" {
		return authorizedAIToolCall{}, errors.New("missing AI tool authorization")
	}
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pruneLocked(now)
	key := aiToolAuthorizationKey(sessionID, toolCallID)
	toolCall, ok := r.calls[key]
	if !ok {
		return authorizedAIToolCall{}, errors.New("AI tool call was not authorized by the backend")
	}
	delete(r.calls, key)
	if now.After(toolCall.ExpiresAt) {
		return authorizedAIToolCall{}, errors.New("AI tool authorization expired")
	}
	return toolCall, nil
}

// discard drops every pending authorization for a session (e.g. when its chat
// is cleared), so stale approvals cannot be executed later.
func (r *aiToolRegistry) discard(sessionID string) {
	if sessionID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for key, toolCall := range r.calls {
		if toolCall.SessionID == sessionID {
			delete(r.calls, key)
		}
	}
}

// pruneLocked removes expired authorizations. The caller must hold r.mu.
func (r *aiToolRegistry) pruneLocked(now time.Time) {
	for key, toolCall := range r.calls {
		if now.After(toolCall.ExpiresAt) {
			delete(r.calls, key)
		}
	}
}
