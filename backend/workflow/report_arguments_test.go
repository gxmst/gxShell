package workflow

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"gxShell/backend/ai"
)

func writeReportStream(w http.ResponseWriter, calls []ai.ToolCall, turn int, complete bool) {
	tools := []map[string]any{}
	for i, call := range calls {
		tools = append(tools, map[string]any{"index": i, "id": call.ID, "type": "function", "function": call.Function})
	}
	data, _ := json.Marshal(map[string]any{
		"choices": []any{map[string]any{"delta": map[string]any{"tool_calls": tools}, "finish_reason": "tool_calls"}},
		"usage":   map[string]int{"prompt_tokens": turn * 10, "completion_tokens": turn},
	})
	_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
	if complete {
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}
}

func TestInspectionRecoversCompleteInvalidArgumentsWithReportOnlyRepair(t *testing.T) {
	for _, scenario := range []string{"repaired", "repair_invalid", "auth", "interrupted", "cancelled"} {
		t.Run(scenario, func(t *testing.T) {
			var modelCalls atomic.Int32
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				turn := int(modelCalls.Add(1))
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				query := ai.ToolCall{ID: "query", Function: ai.FunctionCall{Name: "inspect_service", Arguments: `{"service":"ssh.service","view":"status"}`}}
				if turn == 1 {
					writeReportStream(w, []ai.ToolCall{query}, turn, true)
					return
				}
				if turn == 2 && scenario == "auth" {
					w.WriteHeader(http.StatusUnauthorized)
					_, _ = fmt.Fprint(w, `{"error":"invalid key"}`)
					return
				}
				if turn > 2 {
					tools, _ := body["tools"].([]any)
					choice, _ := body["tool_choice"].(map[string]any)
					function, _ := choice["function"].(map[string]any)
					if len(tools) != 1 || function["name"] != "submit_report" {
						t.Error("repair did not restrict the model to one report tool")
					} else if tools[0].(map[string]any)["function"].(map[string]any)["name"] != "submit_report" {
						t.Error("repair exposed a host query tool")
					}
				}
				if turn == 3 && scenario == "repaired" {
					writeReportStream(w, submission(testReportJSON("en", Checks)).ToolCalls, turn, true)
					return
				}
				// One malformed call poisons the whole response: even the valid
				// query alongside it must never be executed or replayed.
				query.ID, query.Function.Arguments = "rejected-query", `{"service":"nginx.service","view":"logs","reason":"secret-value"}`
				bad := submission("null").ToolCalls[0]
				writeReportStream(w, []ai.ToolCall{bad, query}, turn, scenario != "interrupted")
			}))
			defer server.Close()
			provider := ai.NewManager()
			queries := []Query{}
			manager, err := NewManager(t.TempDir(), func(_ context.Context, session string, query Query) Evidence {
				if session != "host-session" {
					t.Error("wrong host selected")
				}
				queries = append(queries, query)
				return Evidence{Status: "collected", Output: "example", RemoteState: "exited"}
			}, func(ctx context.Context, cfg ai.Config, request ai.ChatRequest, emit func(ai.ChatResponse)) error {
				err := provider.ChatWithConfig(ctx, cfg, request, emit)
				if scenario == "cancelled" && modelCalls.Load() == 2 {
					cancel()
				}
				return err
			}, nil, func(_ string, text string) string { return strings.ReplaceAll(text, "secret-value", "[redacted]") })
			if err != nil {
				t.Fatal(err)
			}
			defer manager.Close()
			started, err := manager.Start(ctx, "host-session", "profile", "host", "en", ai.Config{Provider: ai.ProviderOpenAI, Model: "test", Endpoint: server.URL})
			if err != nil {
				t.Fatal(err)
			}
			run := awaitRun(t, manager, started.ID)
			if len(queries) != len(Checks)+1 || len(run.Evidence) != len(Checks)+1 || run.Rounds != 1 {
				t.Fatalf("rejected response executed commands or recollected evidence: %d queries, %d evidence, %d rounds", len(queries), len(run.Evidence), run.Rounds)
			}
			wantCalls, wantPrompt, wantCompletion := 3, 60, 6
			if scenario == "auth" || scenario == "interrupted" {
				wantCalls, wantPrompt, wantCompletion = 2, 10, 1
			} else if scenario == "cancelled" {
				wantCalls, wantPrompt, wantCompletion = 2, 30, 3
			}
			if int(modelCalls.Load()) != wantCalls || run.PromptTokens != wantPrompt || run.CompletionTokens != wantCompletion {
				t.Fatalf("unbounded repair or incorrect usage: calls=%d, tokens=%d/%d", modelCalls.Load(), run.PromptTokens, run.CompletionTokens)
			}
			models, failed, tracePrompt, traceCompletion := 0, 0, 0, 0
			for _, step := range run.Trace {
				if step.Kind != "model" {
					continue
				}
				models++
				tracePrompt += step.PromptTokens
				traceCompletion += step.CompletionTokens
				if step.State == "failed" {
					failed++
					if scenario == "repaired" || scenario == "repair_invalid" {
						if !strings.Contains(step.Output, "rejectedToolCalls") || strings.Contains(step.Output, "secret-value") {
							t.Fatal("failed response was not preserved and redacted in the trace")
						}
					}
				}
			}
			if models != wantCalls || failed == 0 || tracePrompt != run.PromptTokens || traceCompletion != run.CompletionTokens {
				t.Fatal("trace lost failed model calls or disagrees with run usage")
			}
			if scenario == "repaired" {
				if run.State != "completed" || run.Document.Analysis == nil || run.ReportMode != "submit_report" {
					t.Fatalf("repair did not produce AI conclusions: %s %s", run.State, run.Error)
				}
			} else {
				wantState := "partial"
				if scenario == "cancelled" {
					wantState = "cancelled"
				}
				if run.State != wantState || run.Error == "" || run.Document.Analysis != nil {
					t.Fatalf("failed/cancelled response became a complete report: %s %s", run.State, run.Error)
				}
				if scenario == "repair_invalid" && !strings.Contains(run.UnverifiedAnswer, "toolArgumentError") {
					t.Fatal("unrecoverable report lost the original rejected response")
				}
			}
		})
	}
}

func TestEvaluationDoesNotScoreRepairedArgumentsAsFirstAnswer(t *testing.T) {
	for _, multiRound := range []bool{false, true} {
		t.Run(fmt.Sprintf("multiRound=%v", multiRound), func(t *testing.T) {
			calls := 0
			manager, err := NewManager(t.TempDir(), func(context.Context, string, Query) Evidence {
				t.Error("evaluation executed a real host query")
				return Evidence{}
			}, func(_ context.Context, _ ai.Config, request ai.ChatRequest, emit func(ai.ChatResponse)) error {
				calls++
				if multiRound && calls <= 2 {
					view := "status"
					if calls == 2 {
						view = "logs"
					}
					emit(ai.ChatResponse{Finish: true, PromptTk: 12, CompleteTk: 4, ToolCalls: []ai.ToolCall{{ID: view, Function: ai.FunctionCall{Name: "inspect_service", Arguments: `{"service":"ssh.service","view":"` + view + `"}`}}}})
					return nil
				}
				if !multiRound || calls == 3 {
					return &ai.ToolArgumentsError{Response: submission("null")}
				}
				if !onlyReportTool(request) {
					t.Error("evaluation repair exposed query tools")
				}
				emit(submission(testReportJSON("en", Checks)))
				return nil
			}, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer manager.Close()
			caseID, wantCalls := "healthy_host", 1
			if multiRound {
				caseID, wantCalls = "multi_round_healthy", 4
			}
			result := manager.evaluateCase(context.Background(), ai.Config{Model: "test"}, "en", caseID)
			if calls != wantCalls || result.WorkflowCompleted != multiRound || result.Passed || result.SchemaValid || result.AnalysisPresent || result.CorrectChecks != 0 {
				t.Fatalf("repair inflated first-answer scoring: %+v, calls=%d", result, calls)
			}
			if !strings.Contains(result.RawReport, "toolArgumentError") || result.PromptTokens != wantCalls*12 || result.CompletionTokens != wantCalls*4 {
				t.Fatalf("first rejected response/usage lost: %+v", result)
			}
			if len(manager.List()) != 0 || len(manager.Stats()) != 0 {
				t.Fatal("evaluation polluted real-host history")
			}
		})
	}
}
