package workflow

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
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

// acceptReport validates the model's report. Problems get one repair turn
// that names each problem and shows the skeleton to fill; the answer with
// fewer problems is kept, with bad items already replaced by evidence-derived
// values. When neither answer uses the schema, the task fails and the model's
// text is kept as an unverified answer.
func (m *Manager) acceptReport(ctx context.Context, id string, cfg ai.Config, messages []ai.Message, text, instructions string) (*ReportDocument, error) {
	run, _ := m.Get(id)
	originalMode := run.ReportMode
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
		if err := m.update(id, func(r *Run) { r.ReportMode = originalMode }); err != nil {
			return nil, err
		}
		return doc, nil
	}
	// Neither answer fits the schema. The model's own analysis may still be
	// useful, so keep it for display, labelled as unverified. Prose reads
	// better than an invented JSON shape, so prefer whichever answer is prose.
	answer := text
	var probe map[string]any
	if repairErr == nil && strings.TrimSpace(repaired) != "" && json.Unmarshal([]byte(extractReportJSON(text)), &probe) == nil && json.Unmarshal([]byte(extractReportJSON(repaired)), &probe) != nil {
		answer = repaired
	}
	answer = m.clean(id, answer, maxUnverifiedAnswer)
	if err := m.update(id, func(r *Run) { r.UnverifiedAnswer = answer }); err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("%s", tr(run.Language, "模型没有按要求的格式返回报告，下方显示的是它的原文，结论没有经过程序核对；证据已保留。", "The model did not return the required report format. Its original answer is shown below without program checks; evidence was preserved."))
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

// reportSkeleton is the exact object the model must fill in, with this run's
// check identifiers and their latest evidence IDs already in place. Models
// that drift into Markdown or invent field names follow a concrete skeleton
// far more reliably than a schema description.
func reportSkeleton(run Run) string {
	type check struct {
		Check       string   `json:"check"`
		Status      string   `json:"status"`
		Reading     string   `json:"reading"`
		EvidenceIDs []string `json:"evidenceIds"`
	}
	checks := []check{}
	for _, c := range fallbackDocument(run).Checks {
		checks = append(checks, check{Check: c.Check, EvidenceIDs: c.EvidenceIDs})
	}
	version := 1
	if run.ReportSchemaVersion >= 2 {
		version = 2
	}
	data, _ := json.MarshalIndent(map[string]any{
		"version": version, "verdict": "", "summary": "", "checks": checks,
		"findings": []any{map[string]any{"severity": "", "title": "", "detail": "", "impact": "", "recommendation": "", "evidenceIds": []string{}}},
		"unknowns": []any{map[string]any{"title": "", "detail": "", "evidenceIds": []string{}}},
		"analysis": map[string]any{"assessment": "", "insights": []any{map[string]any{"title": "", "opinion": "", "confidence": "", "evidenceIds": []string{}, "nextCheck": ""}}, "nextSteps": []string{""}, "caveats": ""},
	}, "", "  ")
	return string(data)
}

// reportReminder closes the evidence message so the format requirement is the
// last thing the model reads, not only a system-prompt paragraph that a long
// tool loop pushes out of focus.
func reportReminder(run Run) string {
	names, _ := json.Marshal(RunChecks(run))
	return tr(run.Language,
		"\n\n完成补查后仅调用 submit_report 提交报告。若接口不支持工具，最终回答必须是且只能是一个 JSON 对象（以 { 开头、以 } 结尾），严格使用系统说明里的字段名，checks 中每个检查项 "+string(names)+" 各一条。不要写 Markdown 标题、表格或 JSON 之外的文字。",
		"\n\nWhen queries are complete, call only submit_report. If tools are unavailable, your final answer must be exactly one JSON object (starting with { and ending with }) using the field names from the system instructions, with one checks item for each of "+string(names)+". No Markdown headings, tables or text outside the JSON.")
}

var reportKeys = map[string]bool{"version": true, "verdict": true, "summary": true, "checks": true, "findings": true, "unknowns": true, "analysis": true}

// shapeProblem names what kind of mistake the answer made, so the repair turn
// says "you wrote Markdown" or "these field names are not allowed" instead of
// echoing a parser error.
func shapeProblem(run Run, text string) string {
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(extractReportJSON(text)), &fields) != nil {
		return tr(run.Language, "上一个回答不是 JSON，而是 Markdown 或普通文字。", "The previous answer was Markdown or prose, not JSON.")
	}
	unknown := []string{}
	for key := range fields {
		if !reportKeys[key] {
			unknown = append(unknown, key)
		}
	}
	if len(unknown) == 0 {
		return ""
	}
	sort.Strings(unknown)
	return tr(run.Language, "上一个回答自己编了字段名，这些字段不允许使用：", "The previous answer invented field names that are not allowed: ") + strings.Join(unknown, ", ")
}

// One bounded repair with only the data submission tool. It never re-runs SSH queries or
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
	if shape := shapeProblem(run, text); shape != "" {
		problems = append([]string{shape}, problems...)
	}
	prompt := tr(run.Language,
		"上一个回答有以下问题：\n- "+strings.Join(problems, "\n- ")+"\n\n分析内容不用重写，请把你已经得出的结论原样填进下面这个 JSON 结构。字段名一个都不能改，不能增加别的字段。空字符串都要用简体中文填写；status 只能是 normal、warning、critical、unknown；verdict 只能是 normal、attention、unknown；confidence 只能是 supported、hypothesis、uncertain；severity 只能是 warning、critical。没有问题或未确认项时，findings、unknowns 写成 []。只引用已有的证据编号。\n\n",
		"The previous answer has these problems:\n- "+strings.Join(problems, "\n- ")+"\n\nKeep your analysis; put the conclusions you already reached into exactly this JSON structure. Do not rename or add fields. Fill every empty string in English; status is normal, warning, critical or unknown; verdict is normal, attention or unknown; confidence is supported, hypothesis or uncertain; severity is warning or critical. Use [] for findings or unknowns when there are none. Cite only existing evidence IDs.\n\n") + reportSkeleton(run)
	prompt += tr(run.Language, "\n请仅调用 submit_report 提交上面的对象，不得执行补查。如果接口不支持工具，直接返回这个 JSON 对象。", "\nCall only submit_report with the object above. Do not query the host. If tools are unavailable, return that JSON object.")
	messages = append(append([]ai.Message{}, messages...), ai.Message{Role: "assistant", Content: text}, ai.Message{Role: "user", Content: prompt})
	var content strings.Builder
	var response ai.ChatResponse
	err := m.tracedChat(ctx, id, cfg, reportRequest(run, messages, instructions), func(chunk ai.ChatResponse) {
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
	answer, mode, answerErr := reportAnswer(response, content.String())
	if err := m.update(id, func(r *Run) {
		if answerErr == nil {
			r.ReportMode = mode
		}
	}); err != nil {
		return "", err
	}
	if answerErr != nil {
		return "", answerErr
	}
	return m.clean(id, answer, maxReport), nil
}
