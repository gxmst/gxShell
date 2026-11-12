package ai

import "fmt"

// TruncatedResponseError preserves streamed text but never releases tool calls
// whose arguments may have been cut off by the provider's output limit.
type TruncatedResponseError struct{}

func (*TruncatedResponseError) Error() string {
	return "response truncated at the output token limit (MAX_TOKENS); streamed text was retained and tool calls were not executed"
}

// ToolArgumentsError carries rejected calls only after a fully completed
// provider stream. It never releases them through the executable-tool callback.
// Built-in workflows can use this data for a bounded report-only repair.
type ToolArgumentsError struct {
	Response ChatResponse
}

func (e *ToolArgumentsError) Error() string { return "tool arguments must be a JSON object" }

func (m *Manager) finishResponse(calls []ToolCall, prompt, completion int, onChunk func(ChatResponse)) error {
	invalid := false
	for _, call := range calls {
		if call.ID == "" || call.Function.Name == "" {
			return fmt.Errorf("incomplete tool call")
		}
		if _, err := toolInput(call.Function.Arguments); err != nil {
			invalid = true
		}
	}
	// A complete rejected response is still billed by the provider.
	m.mu.Lock()
	m.usage.PromptTokens += int64(prompt)
	m.usage.CompletionTokens += int64(completion)
	m.usage.TotalTokens += int64(prompt + completion)
	m.mu.Unlock()
	response := ChatResponse{Finish: true, ToolCalls: calls, PromptTk: prompt, CompleteTk: completion}
	if invalid {
		return &ToolArgumentsError{Response: response}
	}
	onChunk(response)
	return nil
}
