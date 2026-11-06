package workflow

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"gxShell/backend/ai"
)

// The answers below are shortened copies of what deepseek-v4.1-flash returned
// on real hosts: a Markdown report first, then JSON with invented field names.
const markdownAnswer = "## 诊断报告\n\n**未发现性能或可用性故障。** microsocks 监听在 `0.0.0.0:8080`，对公网开放。\n\n| 项目 | 证据 | 判读 |\n|---|---|---|\n| 磁盘 | E3 | 健康 |"
const inventedJSON = `{"报告类型":"主机健康诊断","总体结论":"未发现性能或可用性故障","逐项判读":[{"项目":"磁盘","结论":"正常"}]}`
const summaryOnlyJSON = `{"schemaVersion":"1.0","summary":"根分区使用率约 22%，均处于正常区间。","keyMetrics":[{"指标":"根分区使用率","实测值":"22%"}]}`

func formatRun(t *testing.T, answers ...string) (Run, []ai.ChatRequest) {
	t.Helper()
	var requests []ai.ChatRequest
	manager, _ := NewManager(t.TempDir(), func(_ context.Context, _ string, q Query) Evidence {
		return Evidence{Status: "collected", Output: "example"}
	}, func(_ context.Context, _ ai.Config, req ai.ChatRequest, output func(ai.ChatResponse)) error {
		requests = append(requests, req)
		if len(requests) > len(answers) {
			return fmt.Errorf("unexpected model turn %d", len(requests))
		}
		output(ai.ChatResponse{Content: answers[len(requests)-1]})
		output(ai.ChatResponse{Finish: true})
		return nil
	}, nil, nil)
	defer manager.Close()
	run, err := manager.Start(context.Background(), "one", "profile", "Server", "zh-CN", ai.Config{Model: "test"})
	if err != nil {
		t.Fatal(err)
	}
	return awaitRun(t, manager, run.ID), requests
}

func TestMarkdownReportGetsSkeletonRepairInJSONMode(t *testing.T) {
	run, requests := formatRun(t, markdownAnswer, testReportJSON("zh-CN", Checks))
	if run.State != "completed" || run.UnverifiedAnswer != "" {
		t.Fatalf("repaired report not accepted: %s %s", run.State, run.Error)
	}
	if !strings.Contains(requests[0].Messages[0].Content, "最终回答必须是且只能是一个 JSON 对象") {
		t.Fatal("evidence message does not end with the format reminder")
	}
	repair := requests[1]
	prompt := repair.Messages[len(repair.Messages)-1].Content
	if repair.EnableTools || !repair.JSONObject {
		t.Fatal("repair must disable tools and ask for JSON output")
	}
	for _, want := range []string{"不是 JSON，而是 Markdown", `"check": "disk"`, `"E3"`, `"analysis"`} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("repair prompt lacks %q:\n%s", want, prompt)
		}
	}
}

func TestUnusableAnswersFailAndKeepTheProseForDisplay(t *testing.T) {
	run, requests := formatRun(t, markdownAnswer, inventedJSON)
	if run.State == "completed" || run.UnverifiedAnswer != markdownAnswer {
		t.Fatalf("expected a failed run that keeps the Markdown answer, got %s %q", run.State, run.UnverifiedAnswer)
	}
	if !strings.Contains(run.Error, "原文") || !strings.Contains(run.Report, "AI 原文（未通过格式校验）") || !strings.Contains(run.Report, "microsocks") {
		t.Fatalf("unverified answer missing from report: %s", run.Error)
	}
	if len(requests) != 2 {
		t.Fatalf("expected exactly one repair, got %d model turns", len(requests))
	}
	if outcome := reportOutcome(&run); outcome != "failed" {
		t.Fatalf("stats outcome %q, want failed", outcome)
	}
	for _, c := range run.Document.Checks {
		if c.Check == "disk" && c.Status != "unknown" {
			t.Fatal("prose was treated as a verified result")
		}
	}
}

func TestSummaryOnlyJSONIsNotAnAcceptedReport(t *testing.T) {
	run := reportRun("zh-CN")
	if _, _, err := normalizeReport(summaryOnlyJSON, run); err == nil || !strings.Contains(err.Error(), "required schema") {
		t.Fatalf("a report without any known check was accepted: %v", err)
	}
	if problem := shapeProblem(run, summaryOnlyJSON); !strings.Contains(problem, "keyMetrics") || !strings.Contains(problem, "schemaVersion") || strings.Contains(problem, "summary") {
		t.Fatalf("invented fields not named: %q", problem)
	}
	finished, _ := formatRun(t, summaryOnlyJSON, inventedJSON)
	if outcome := reportOutcome(&finished); outcome != "failed" {
		t.Fatalf("summary-only answer counted as %q", outcome)
	}
	// Both answers are JSON, so the first is kept for display.
	if finished.UnverifiedAnswer != summaryOnlyJSON {
		t.Fatalf("kept %q", finished.UnverifiedAnswer)
	}
}

func TestFailedUnitCountIsReadExplicitly(t *testing.T) {
	cases := map[string]bool{
		"GXSHELL_SERVICE_MANAGER=systemd\nGXSHELL_FAILED_UNITS=0\n":                                   true,
		"GXSHELL_SERVICE_MANAGER=systemd\n":                                                           true,
		"GXSHELL_SERVICE_MANAGER=systemd\nGXSHELL_FAILED_UNITS=1\nnginx.service loaded failed failed": false,
		"GXSHELL_SERVICE_MANAGER=openrc\nGXSHELL_FAILED_UNITS=0\n":                                    false,
	}
	for output, want := range cases {
		if got := noFailedUnits(Evidence{Query: Query{Check: "services"}, Output: output}); got != want {
			t.Errorf("%q: got %v", output, got)
		}
	}
}
