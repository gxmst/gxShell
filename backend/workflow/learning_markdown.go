package workflow

import (
	"fmt"
	"strings"
)

func markdownEvidenceRefs(ids []string) string {
	links := make([]string, 0, len(ids))
	for _, id := range ids {
		links = append(links, fmt.Sprintf("[%s](#%s)", id, strings.ToLower(id)))
	}
	return strings.Join(links, ", ")
}

func containerExpectationLabel(language, value string) string {
	switch value {
	case "none":
		return tr(language, "不使用容器", "No containers expected")
	case "docker":
		return "Docker"
	case "podman":
		return "Podman"
	case "other":
		return tr(language, "其他运行时", "Other runtime")
	default:
		return tr(language, "尚未确认", "Not confirmed")
	}
}

func traceStateLabel(language, value string) string {
	switch value {
	case "running":
		return tr(language, "进行中", "Running")
	case "completed":
		return tr(language, "已完成", "Completed")
	case "collected":
		return tr(language, "已采集", "Collected")
	case "unavailable":
		return tr(language, "无法获取", "Unavailable")
	case "failed":
		return tr(language, "失败", "Failed")
	case "interrupted":
		return tr(language, "已中断", "Interrupted")
	case "blocked":
		return tr(language, "已拦截", "Blocked")
	case "reused":
		return tr(language, "复用已有证据", "Reused evidence")
	default:
		return tr(language, "未确认", "Unknown")
	}
}

func insightLabel(language, value string) string {
	switch value {
	case "supported":
		return tr(language, "有证据支持", "Evidence supported")
	case "hypothesis":
		return tr(language, "可能原因", "Hypothesis")
	default:
		return tr(language, "仍需核实", "Uncertain")
	}
}
func writeAnalysisMarkdown(out *strings.Builder, run Run) {
	l := run.Language
	if run.ParentID != "" {
		fmt.Fprintf(out, "## %s\n\n%s: %s\n\n%s\n\n", tr(l, "报告追问", "Report follow-up"), tr(l, "原报告", "Original report"), markdownText(run.ParentID), markdownText(run.Question))
	}
	if run.Document != nil && run.Document.Analysis != nil {
		a := run.Document.Analysis
		fmt.Fprintf(out, "## %s\n\n%s\n\n", tr(l, "AI 分析意见", "AI assessment"), markdownText(a.Assessment))
		for _, insight := range a.Insights {
			fmt.Fprintf(out, "### %s · %s\n\n%s\n\n%s: %s\n\n%s: %s\n\n", markdownText(insight.Title), insightLabel(l, insight.Confidence), markdownText(insight.Opinion), tr(l, "证据", "Evidence"), markdownEvidenceRefs(insight.EvidenceIDs), tr(l, "建议核实", "Suggested check"), markdownText(insight.NextCheck))
		}
		for _, step := range a.NextSteps {
			fmt.Fprintf(out, "- %s\n", markdownText(step))
		}
		if a.Caveats != "" {
			fmt.Fprintf(out, "\n%s: %s\n\n", tr(l, "判断边界", "Limitations"), markdownText(a.Caveats))
		}
	}
	if run.Dossier != nil {
		d := run.Dossier
		fmt.Fprintf(out, "## %s\n\n%s · v%d · %s\n\n%s\n\n%s\n\n", tr(l, "本次使用的主机背景", "Host background used"), markdownText(d.Reviewer), d.Revision, d.UpdatedAt.Local().Format("2006-01-02 15:04:05"), markdownText(d.Purpose), markdownText(d.Notes))
		fmt.Fprintf(out, "%s: %s\n\n%s: %s\n\n%s: %v\n\n%s: %s\n\n", tr(l, "运行环境", "Environment"), markdownText(d.Environment), tr(l, "预期服务", "Expected services"), markdownText(strings.Join(d.Services, ", ")), tr(l, "预期端口", "Expected ports"), d.Ports, tr(l, "容器预期", "Container expectation"), containerExpectationLabel(l, d.ContainerRuntime))
	}
}
func writeLearningMarkdown(out *strings.Builder, run Run) {
	l := run.Language
	if len(run.Trace) > 0 {
		fmt.Fprintf(out, "## %s\n\n", tr(l, "诊断过程记录", "Diagnostic trace"))
		for _, step := range run.Trace {
			fmt.Fprintf(out, "- %s · %s · %d ms · %s\n", markdownText(step.ID), traceStateLabel(l, step.State), step.DurationMs, markdownText(step.Reason))
			if len(step.EvidenceIDs) > 0 {
				fmt.Fprintf(out, "  - %s: %s\n", tr(l, "证据", "Evidence"), markdownEvidenceRefs(step.EvidenceIDs))
			}
			if step.PromptTokens+step.CompletionTokens > 0 {
				fmt.Fprintf(out, "  - %s: %d\n", tr(l, "Token 用量", "Token usage"), step.PromptTokens+step.CompletionTokens)
			}
			if step.Error != "" {
				fmt.Fprintf(out, "  - %s\n", markdownText(step.Error))
			}
		}
	}
	if len(run.Feedback) > 0 {
		fmt.Fprintf(out, "\n## %s\n\n", tr(l, "诊断反馈", "Diagnostic feedback"))
		for _, feedback := range run.Feedback {
			fmt.Fprintf(out, "- %s · %s · %s · %s\n", feedback.At.Local().Format("2006-01-02 15:04:05"), markdownText(feedback.Reviewer), feedbackOutcomeLabel(l, feedback.Outcome), markdownText(feedback.Note))
		}
	}
}
func feedbackOutcomeLabel(language, outcome string) string {
	switch outcome {
	case "correct":
		return tr(language, "判断正确", "Correct")
	case "false_alarm":
		return tr(language, "存在误报", "False alarm")
	default:
		return tr(language, "存在漏报", "Missed issue")
	}
}
