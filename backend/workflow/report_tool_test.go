package workflow

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"gxShell/backend/ai"
)

func onlyReportTool(req ai.ChatRequest) bool {
	return req.EnableTools && req.ForceTool == "submit_report" && len(req.Tools) == 1 && req.Tools[0]["function"].(map[string]any)["name"] == "submit_report"
}

func submission(text string) ai.ChatResponse {
	return ai.ChatResponse{Finish: true, PromptTk: 12, CompleteTk: 4, ToolCalls: []ai.ToolCall{{ID: "report", Type: "function", Function: ai.FunctionCall{Name: "submit_report", Arguments: text}}}}
}

func TestSubmissionIsDataOnlyAndRepairsOnce(t *testing.T) {
	for _, scenario := range []string{"early", "wrong_language", "mixed", "oversized", "incomplete"} {
		t.Run(scenario, func(t *testing.T) {
			queries, calls := 0, 0
			m, err := NewManager(t.TempDir(), func(context.Context, string, Query) Evidence {
				queries++
				return Evidence{Status: "collected", Output: "example"}
			}, func(_ context.Context, _ ai.Config, req ai.ChatRequest, emit func(ai.ChatResponse)) error {
				calls++
				if calls > 1 && !onlyReportTool(req) {
					t.Error("repair exposes query tools")
				}
				answer := submission(testReportJSON("zh-CN", Checks))
				if calls == 1 {
					switch scenario {
					case "wrong_language":
						answer = submission(testReportJSON("en", Checks))
					case "mixed":
						answer.ToolCalls = append(answer.ToolCalls, ai.ToolCall{ID: "query", Function: ai.FunctionCall{Name: "inspect_service", Arguments: `{"service":"evil.service","view":"status"}`}})
					case "oversized":
						answer.ToolCalls[0].Function.Arguments = strings.Repeat("x", maxReport+1)
					case "incomplete":
						answer.Finish = false
					}
				}
				emit(answer)
				return nil
			}, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			started, err := m.Start(context.Background(), "session", "profile", "host", "zh-CN", ai.Config{Model: "test"})
			if err != nil {
				t.Fatal(err)
			}
			run := awaitRun(t, m, started.ID)
			if queries != len(Checks) {
				t.Fatalf("submission executed extra host queries: %d", queries)
			}
			if scenario == "incomplete" {
				if run.State == "completed" || calls != 1 {
					t.Fatalf("incomplete submission accepted/retried: %+v", run)
				}
				return
			}
			if run.State != "completed" || run.ReportMode != "submit_report" || run.WorkflowVersion != WorkflowVersion {
				t.Fatalf("submission failed: %s %s %s", run.State, run.ReportMode, run.Error)
			}
			wantCalls := 2
			if scenario == "early" {
				wantCalls = 1
			}
			if calls != wantCalls {
				t.Fatalf("model calls %d, want %d", calls, wantCalls)
			}
		})
	}
}

func TestMultiRoundEvaluationUsesWorkflowWithoutRealHostHistory(t *testing.T) {
	for _, missed := range []bool{false, true} {
		modelCalls := 0
		m, err := NewManager(t.TempDir(), func(context.Context, string, Query) Evidence {
			t.Error("evaluation called real SSH executor")
			return Evidence{}
		}, func(_ context.Context, _ ai.Config, req ai.ChatRequest, emit func(ai.ChatResponse)) error {
			modelCalls++
			if modelCalls <= 2 {
				view := "status"
				if modelCalls == 2 {
					view = "logs"
				}
				emit(ai.ChatResponse{Finish: true, ToolCalls: []ai.ToolCall{{ID: view, Function: ai.FunctionCall{Name: "inspect_service", Arguments: `{"service":"ssh.service","view":"` + view + `"}`}}}})
				return nil
			}
			doc := testReportJSON("en", Checks)
			if !missed {
				var report ReportDocument
				_ = json.Unmarshal([]byte(doc), &report)
				report.Checks[2].Status, report.Verdict = "critical", "attention"
				encoded, _ := json.Marshal(report)
				doc = string(encoded)
			}
			emit(submission(doc))
			return nil
		}, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		result := m.evaluateCase(context.Background(), ai.Config{Model: "test"}, "en", "multi_round_disk")
		if result.ToolRounds != 2 || !result.WorkflowCompleted || result.ReportMode != "submit_report" {
			t.Fatalf("workflow not exercised: %+v", result)
		}
		if result.Passed == missed || (missed && result.Actual["disk"] != "normal") {
			t.Fatalf("raw scoring inflated or correct case failed: %+v", result)
		}
		if len(m.Stats()) != 0 || len(m.List()) != 0 {
			t.Fatal("evaluation polluted real-host statistics")
		}
		m.Close()
	}
}

func TestStatsSeparatesVersionsEndpointsLanguagesAndBatches(t *testing.T) {
	m, _ := NewManager(t.TempDir(), nil, nil, nil, nil)
	defer m.Close()
	base := Run{Provider: "openai", Model: "test", State: "completed", WorkflowVersion: WorkflowVersion, PromptVersion: PromptVersion, EndpointID: "a", ReportMode: "submit_report", Language: "en", Workflow: "host_inspection"}
	variants := []Run{base, base, base, base, base, base, base}
	variants[0].WorkflowVersion = ""
	variants[1].PromptVersion = "old"
	variants[2].EndpointID = "b"
	variants[3].ReportMode = "json_fallback"
	variants[4].Language = "zh-CN"
	variants[5].BatchID = "batch"
	for i := range variants {
		m.runs[string(rune('a'+i))] = &variants[i]
	}
	if len(m.Stats()) != len(variants) {
		t.Fatalf("different experiments merged: %+v", m.Stats())
	}
}
