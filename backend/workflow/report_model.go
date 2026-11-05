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

// acceptReport validates the model's report. Item-level problems get one
// repair turn that names each problem; the answer with fewer problems is kept,
// with bad items already replaced by evidence-derived values. The task fails
// only when no answer is readable.
func (m *Manager) acceptReport(ctx context.Context, id string, cfg ai.Config, messages []ai.Message, text, instructions string) (*ReportDocument, error) {
	run, _ := m.Get(id)
	doc, issues, err := normalizeReport(text, run)
	if err := m.recordValidation(id, tr(run.Language, "校验报告结构、语言、观点和证据引用。", "Validate report structure, language, assessment and evidence references."), text, issues, err); err != nil {
		return nil, err
	}
	if err == nil && len(issues) == 0 {
		return doc, nil
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	problems := issues
	if err != nil {
		problems = []string{err.Error()}
	}
	repaired, repairErr := m.repairReport(ctx, id, cfg, messages, text, instructions, problems)
	if repairErr == nil {
		current, _ := m.Get(id)
		second, secondIssues, secondErr := normalizeReport(repaired, current)
		if traceErr := m.recordValidation(id, tr(run.Language, "校验修正后的报告。", "Validate the repaired report."), repaired, secondIssues, secondErr); traceErr != nil {
			return nil, traceErr
		}
		if secondErr == nil && (doc == nil || len(secondIssues) <= len(issues)) {
			return second, nil
		}
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if doc != nil {
		return doc, nil
	}
	return nil, fmt.Errorf("%s", tr(run.Language, "模型未返回可读取的结构化报告，已保留证据。", "The model did not return a readable structured report; evidence was preserved."))
}

// recordValidation keeps the model's raw answer whenever it was not accepted
// as-is, so a corrected or rejected report can still be inspected.
func (m *Manager) recordValidation(id, reason, text string, issues []string, err error) error {
	state, message, output := "completed", "", ""
	if err != nil {
		state, message, output = "failed", err.Error(), text
	} else if len(issues) > 0 {
		state, message, output = "corrected", strings.Join(issues, "\n"), text
	}
	traceID, traceErr := m.beginTrace(id, "report_validation", reason, nil)
	if traceErr != nil {
		return traceErr
	}
	if traceErr := m.endTrace(id, traceID, state, message, nil, 0, 0); traceErr != nil {
		return traceErr
	}
	if output == "" {
		return nil
	}
	output = m.clean(id, output, maxTraceOutput)
	return m.update(id, func(r *Run) {
		for i := range r.Trace {
			if r.Trace[i].ID == traceID {
				r.Trace[i].Output = output
			}
		}
	})
}

// One bounded repair with tools disabled. It never re-runs SSH queries or
// translates/overwrites historical reports.
func (m *Manager) repairReport(ctx context.Context, id string, cfg ai.Config, messages []ai.Message, text, instructions string, problems []string) (string, error) {
	if err := m.update(id, func(r *Run) {
		r.StepReason = tr(r.Language, "正在修正报告中的问题。", "Correcting problems in the report.")
	}); err != nil {
		return "", err
	}
	run, _ := m.Get(id)
	if len(problems) > 12 {
		problems = problems[:12]
	}
	prompt := tr(run.Language, "上一个结果有以下问题，请逐条修正后返回完整的 JSON 对象。所有描述使用简体中文，只引用真实存在的证据编号，不得调用工具：\n- ", "The previous answer has these problems. Fix each one and return the complete JSON object with English prose, citing only existing evidence IDs. Do not call tools:\n- ") + strings.Join(problems, "\n- ")
	messages = append(append([]ai.Message{}, messages...), ai.Message{Role: "assistant", Content: text}, ai.Message{Role: "user", Content: prompt})
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
		return "", err
	}
	if !response.Finish || len(response.ToolCalls) > 0 {
		return "", fmt.Errorf("invalid report repair")
	}
	if err := m.update(id, func(r *Run) { r.PromptTokens += response.PromptTk; r.CompletionTokens += response.CompleteTk }); err != nil {
		return "", err
	}
	return m.clean(id, content.String(), maxReport), nil
}
