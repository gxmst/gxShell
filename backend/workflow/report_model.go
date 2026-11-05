package workflow

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"gxShell/backend/ai"
)

func decodeQueryReason(call ai.ToolCall) (Query, string, error) {
	if len(call.Function.Arguments) > 4096 {
		return Query{}, "", fmt.Errorf("query arguments exceed limit")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(call.Function.Arguments), &fields); err != nil {
		return Query{}, "", err
	}
	var reason string
	if value, ok := fields["reason"]; ok {
		if err := json.Unmarshal(value, &reason); err != nil || len(reason) > 1600 {
			return Query{}, "", fmt.Errorf("invalid query reason")
		}
		delete(fields, "reason")
	}
	data, _ := json.Marshal(fields)
	call.Function.Arguments = string(data)
	query, err := decodeQuery(call)
	return query, reason, err
}

// One bounded formatting/language repair, with tools disabled. It never re-runs
// SSH queries or translates/overwrites historical reports.
func (m *Manager) repairReport(ctx context.Context, id string, cfg ai.Config, messages []ai.Message, text, instructions string, run Run) (*ReportDocument, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := m.update(id, func(r *Run) {
		r.StepReason = tr(r.Language, "正在校验报告结构与语言。", "Validating report structure and language.")
	}); err != nil {
		return nil, err
	}
	messages = append(append([]ai.Message{}, messages...), ai.Message{Role: "assistant", Content: text}, ai.Message{Role: "user", Content: tr(run.Language, "上一个结果未通过结构或语言校验。请仅返回符合规定字段的 JSON 对象，所有描述使用简体中文，检查项必须齐全且引用真实证据。不得调用工具。", "The previous answer failed structure or language validation. Return only the required JSON object, with all checks and actual evidence references. Use English prose. Do not call tools.")})
	var content strings.Builder
	var response ai.ChatResponse
	err := m.tracedChat(ctx, id, cfg, ai.ChatRequest{Messages: messages, Instructions: instructions, EnableTools: false, Tools: inspectionTools()}, func(chunk ai.ChatResponse) {
		if content.Len() < maxReport {
			content.WriteString(chunk.Content)
		}
		if chunk.Finish {
			response = chunk
		}
	})
	if err != nil {
		return nil, err
	}
	if !response.Finish || len(response.ToolCalls) > 0 {
		return nil, fmt.Errorf("invalid report repair")
	}
	if err := m.update(id, func(r *Run) { r.PromptTokens += response.PromptTk; r.CompletionTokens += response.CompleteTk }); err != nil {
		return nil, err
	}
	return decodeReport(m.clean(id, content.String(), maxReport), run)
}
