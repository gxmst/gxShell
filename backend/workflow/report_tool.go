package workflow

import (
	"encoding/json"
	"fmt"
	"strings"

	"gxShell/backend/ai"
)

const WorkflowVersion = "inspection-v5"
const PromptVersion = "assessment-v4"

func rejectedReportAnswer(rejected *ai.ToolArgumentsError) string {
	raw, _ := json.Marshal(map[string]any{"toolArgumentError": rejected.Error(), "rejectedToolCalls": rejected.Response.ToolCalls})
	return string(raw)
}

// The submission tool only returns data; it has no executor or SSH capability.
func reportTool(run Run) map[string]any {
	text := map[string]any{"type": "string"}
	stringsArray := map[string]any{"type": "array", "items": text}
	object := func(properties map[string]any, required ...string) map[string]any {
		return map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}
	}
	enum := func(values ...string) map[string]any { return map[string]any{"type": "string", "enum": values} }
	array := func(item any, min, max int) map[string]any {
		return map[string]any{"type": "array", "items": item, "minItems": min, "maxItems": max}
	}
	checks := RunChecks(run)
	check := object(map[string]any{"check": enum(checks...), "status": enum("normal", "warning", "critical", "unknown"), "reading": text, "evidenceIds": stringsArray}, "check", "status", "reading", "evidenceIds")
	finding := object(map[string]any{"severity": enum("warning", "critical"), "title": text, "detail": text, "impact": text, "recommendation": text, "evidenceIds": stringsArray}, "severity", "title", "detail", "impact", "recommendation", "evidenceIds")
	unknown := object(map[string]any{"title": text, "detail": text, "evidenceIds": stringsArray}, "title", "detail", "evidenceIds")
	insight := object(map[string]any{"title": text, "opinion": text, "confidence": enum("supported", "hypothesis", "uncertain"), "evidenceIds": stringsArray, "nextCheck": text}, "title", "opinion", "confidence", "evidenceIds", "nextCheck")
	analysis := object(map[string]any{"assessment": text, "insights": array(insight, 1, 4), "nextSteps": stringsArray, "caveats": text}, "assessment", "insights", "nextSteps", "caveats")
	schema := object(map[string]any{"version": map[string]any{"type": "integer", "enum": []int{2}}, "verdict": enum("normal", "attention", "unknown"), "summary": text, "checks": array(check, len(checks), len(checks)), "findings": array(finding, 0, 16), "unknowns": array(unknown, 0, 16), "analysis": analysis}, "version", "verdict", "summary", "checks", "findings", "unknowns", "analysis")
	return map[string]any{"type": "function", "function": map[string]any{"name": "submit_report", "description": "Submit the final diagnostic report using the collected evidence. Returns report data only; does not execute commands. Cite only this host's evidence IDs. All prose must use the requested language.", "parameters": schema}}
}

func reportRequest(run Run, messages []ai.Message, instructions string) ai.ChatRequest {
	return ai.ChatRequest{Messages: messages, Instructions: instructions + "\nSubmit the report by calling submit_report exactly once. Do not call any inspection tool in this turn. If the endpoint cannot use tools, return the same report as one JSON object.", EnableTools: true, Tools: []map[string]any{reportTool(run)}, ForceTool: "submit_report"}
}

// Tool arguments are accepted only after the provider completes the stream.
// A mixed submission/query response is never allowed to execute a query.
func reportAnswer(response ai.ChatResponse, content string) (text, mode string, err error) {
	if !response.Finish {
		return "", "", fmt.Errorf("model stream did not finish")
	}
	if len(response.ToolCalls) == 0 {
		return content, "json_fallback", nil
	}
	if len(response.ToolCalls) != 1 || response.ToolCalls[0].Function.Name != "submit_report" {
		return "", "submit_report", fmt.Errorf("report submission must be one submit_report call without other tools")
	}
	text = response.ToolCalls[0].Function.Arguments
	if len(text) > maxReport {
		return "", "submit_report", fmt.Errorf("report arguments exceed limit")
	}
	if strings.TrimSpace(text) == "" {
		return "", "submit_report", fmt.Errorf("empty report submission")
	}
	return text, "submit_report", nil
}
