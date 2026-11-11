package workflow

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"gxShell/backend/ai"
)

func awaitRun(t *testing.T, manager *Manager, id string) Run {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		run, err := manager.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		if Terminal(run.State) {
			return run
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("inspection did not finish")
	return Run{}
}

func testReportJSON(language string, checks []string) string {
	doc := ReportDocument{Version: 2, Verdict: "normal", Summary: tr(language, "已根据采集证据完成巡检。", "Inspection completed using collected evidence."), Checks: []ReportCheck{}, Findings: []Finding{}, Unknowns: []Uncertainty{}, Analysis: testAnalysis(language)}
	for i, check := range checks {
		doc.Checks = append(doc.Checks, ReportCheck{Check: check, Status: "normal", Reading: tr(language, "已核对采集结果。", "Collected evidence reviewed."), EvidenceIDs: []string{fmt.Sprintf("E%d", i+1)}})
	}
	data, _ := json.Marshal(doc)
	return string(data)
}

func testAnalysis(language string) *AiAnalysis {
	return &AiAnalysis{Assessment: tr(language, "采集结果需结合运行预期判断。", "Interpret collected results against operational expectations."), Insights: []AiInsight{{Title: tr(language, "运行环境", "Operating environment"), Opinion: tr(language, "系统信息提供了运行环境依据，业务状态还需核实。", "System information establishes the environment; workload state needs verification."), Confidence: "supported", EvidenceIDs: []string{"E1"}, NextCheck: tr(language, "核对预期服务。", "Check expected services.")}}, NextSteps: []string{tr(language, "核实业务运行预期。", "Verify workload expectations.")}, Caveats: tr(language, "无法据此确认外网访问。", "This does not establish public reachability.")}
}

func TestInspectionUsesBoundedQueriesAndPreservesUnknownEvidence(t *testing.T) {
	var mu sync.Mutex
	queries := []Query{}
	turn := 0
	manager, err := NewManager(t.TempDir(), func(_ context.Context, session string, query Query) Evidence {
		if session != "session-a" {
			t.Errorf("wrong target: %s", session)
		}
		mu.Lock()
		queries = append(queries, query)
		mu.Unlock()
		if query.Check == "containers" {
			return Evidence{Status: "unavailable", Error: "permission denied", RemoteState: "exited", ExitCode: 1}
		}
		return Evidence{Status: "collected", Output: "measured evidence secret-value", RemoteState: "exited"}
	}, func(_ context.Context, cfg ai.Config, req ai.ChatRequest, output func(ai.ChatResponse)) error {
		if cfg.Model != "original-model" {
			t.Error("task model changed")
		}
		if turn == 0 {
			output(ai.ChatResponse{Finish: true, ToolCalls: []ai.ToolCall{
				{ID: "a", Function: ai.FunctionCall{Name: "inspect_service", Arguments: "{\"service\":\"nginx.service\",\"view\":\"logs\"}"}},
				{ID: "b", Function: ai.FunctionCall{Name: "execute_command", Arguments: "{\"command\":\"reboot\"}"}},
				{ID: "c", Function: ai.FunctionCall{Name: "inspect_check", Arguments: "{\"check\":\"disk\"}"}},
			}})
		} else {
			wire, _ := json.Marshal(req.Messages)
			if !strings.Contains(string(wire), "BLOCKED") || strings.Contains(string(wire), "secret-value") {
				t.Error("missing tool boundary or secret redaction")
			}
			output(ai.ChatResponse{Content: testReportJSON("en", Checks)})
			output(ai.ChatResponse{Finish: true, PromptTk: 10, CompleteTk: 5})
		}
		turn++
		return nil
	}, nil, func(_ string, text string) string { return strings.ReplaceAll(text, "secret-value", "[redacted]") })
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	started, err := manager.Start(context.Background(), "session-a", "profile-a", "Server A", "English", ai.Config{Provider: ai.ProviderOpenAI, Model: "original-model"})
	if err != nil {
		t.Fatal(err)
	}
	run := awaitRun(t, manager, started.ID)
	if run.State != "completed" || len(run.Evidence) != len(Checks)+1 || run.Rounds != 1 {
		t.Fatalf("unexpected completion: %#v", run)
	}
	if run.Evidence[6].Status != "unavailable" || run.PromptTokens != 10 {
		t.Error("unknown evidence or usage lost")
	}
	mu.Lock()
	if len(queries) != len(Checks)+1 {
		t.Error("duplicate or arbitrary query executed")
	}
	mu.Unlock()
	data, err := os.ReadFile(filepath.Join(manager.dir, run.ID+".json"))
	if err != nil || strings.Contains(string(data), "secret-value") {
		t.Fatal("report not saved safely")
	}
	reopened, err := NewManager(manager.dir, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	history, _ := reopened.Get(run.ID)
	if history.Report != run.Report || history.State != "completed" {
		t.Error("completed history changed on reload")
	}
}

func TestInspectionCancellationKeepsEvidenceAndPinsServer(t *testing.T) {
	entered := make(chan struct{})
	var manager *Manager
	manager, _ = NewManager(t.TempDir(), func(ctx context.Context, _ string, query Query) Evidence {
		if query.Check == "system" {
			return Evidence{Status: "collected", Output: "Linux"}
		}
		close(entered)
		<-ctx.Done()
		return Evidence{Status: "unavailable", Error: ctx.Err().Error(), RemoteState: "unknown"}
	}, func(context.Context, ai.Config, ai.ChatRequest, func(ai.ChatResponse)) error {
		t.Error("model called after stop")
		return nil
	}, nil, nil)
	defer manager.Close()
	run, err := manager.Start(context.Background(), "one", "same-profile", "One", "Chinese", ai.Config{Model: "test"})
	if err != nil {
		t.Fatal(err)
	}
	<-entered
	if _, err := manager.Start(context.Background(), "two", "same-profile", "Two", "Chinese", ai.Config{Model: "test"}); err == nil {
		t.Error("same server ran concurrently")
	}
	if !manager.Cancel(run.ID) {
		t.Error("cancel not acknowledged")
	}
	finished := awaitRun(t, manager, run.ID)
	if finished.State != "cancelled" || len(finished.Evidence) < 1 || !strings.Contains(finished.Report, "未确认项") {
		t.Fatalf("missing partial cancellation report: %#v", finished)
	}
}

func TestInspectionRoundBudgetAndModelFailure(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			turn := 0
			manager, _ := NewManager(t.TempDir(), func(context.Context, string, Query) Evidence { return Evidence{Status: "collected"} },
				func(_ context.Context, _ ai.Config, req ai.ChatRequest, output func(ai.ChatResponse)) error {
					if fail {
						return fmt.Errorf("model connection interrupted")
					}
					if turn < MaxRounds {
						if !req.EnableTools || req.JSONObject {
							t.Error("query rounds must keep tools and stay unconstrained")
						}
						output(ai.ChatResponse{Finish: true, ToolCalls: []ai.ToolCall{{ID: fmt.Sprint(turn), Function: ai.FunctionCall{Name: "inspect_service", Arguments: fmt.Sprintf("{\"service\":\"service%d\",\"view\":\"status\"}", turn)}}}})
					} else {
						if !onlyReportTool(req) {
							t.Error("the final turn must expose only submit_report")
						}
						output(ai.ChatResponse{Content: testReportJSON("en", Checks)})
						output(ai.ChatResponse{Finish: true})
					}
					turn++
					return nil
				}, nil, nil)
			defer manager.Close()
			run, err := manager.Start(context.Background(), "one", "profile", "Server", "English", ai.Config{Model: "test"})
			if err != nil {
				t.Fatal(err)
			}
			finished := awaitRun(t, manager, run.ID)
			if fail && (finished.State != "partial" || len(finished.Evidence) != len(Checks)) {
				t.Error("model failure discarded collected evidence")
			}
			if !fail && (turn != MaxRounds+1 || finished.Rounds != MaxRounds || finished.State != "completed") {
				t.Errorf("round budget not enforced: state=%s rounds=%d error=%s", finished.State, finished.Rounds, finished.Error)
			}
		})
	}
}

func TestInspectionRestoresInterruptedRunsWithoutExecution(t *testing.T) {
	dir := t.TempDir()
	id := strings.Repeat("a", 32)
	data, _ := json.Marshal(Run{ID: id, Workflow: "host_inspection", State: "analyzing", Evidence: []Evidence{{ID: "E1", Query: Query{Check: "system"}, Status: "collected"}}, Language: "English"})
	if err := os.WriteFile(filepath.Join(dir, id+".json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(dir, func(context.Context, string, Query) Evidence {
		t.Error("resumed remote execution automatically")
		return Evidence{}
	}, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	run, _ := manager.Get(id)
	if run.State != "interrupted" || len(run.Evidence) != 1 || run.Report == "" {
		t.Fatalf("restore lost evidence: %#v", run)
	}
}

func TestInspectionQueryRejectsShellInjection(t *testing.T) {
	for _, name := range []string{"nginx;reboot", "$(id)", "../etc/passwd", "-x", "a\nb", "nginx'"} {
		if _, err := Command(Query{Check: "service", Service: name, View: "logs"}); err == nil {
			t.Errorf("accepted unsafe name %q", name)
		}
	}
	for _, call := range []ai.ToolCall{
		{Function: ai.FunctionCall{Name: "inspect_service", Arguments: "{\"service\":\"nginx\",\"view\":\"restart\"}"}},
		{Function: ai.FunctionCall{Name: "inspect_check", Arguments: "{\"check\":\"disk\",\"command\":\"reboot\"}"}},
		{Function: ai.FunctionCall{Name: "inspect_check", Arguments: "{\"check\":\"disk\"} garbage"}},
	} {
		if _, err := decodeQuery(call); err == nil {
			t.Errorf("accepted unsafe query: %#v", call)
		}
	}
}

func TestInspectionReportsFinalPersistenceFailure(t *testing.T) {
	var emitted []Run
	manager, err := NewManager(t.TempDir(), nil, nil, func(run Run) { emitted = append(emitted, run) }, nil)
	if err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("a", 32)
	manager.runs[id] = &Run{ID: id, State: "analyzing", Report: "AI report", Evidence: []Evidence{{ID: "E1", Output: "Linux"}}, Language: "Chinese"}
	// An unavailable directory models a failed final disk write on every OS.
	manager.dir = filepath.Join(t.TempDir(), "missing")
	manager.finish(id, "completed", "")
	run, _ := manager.Get(id)
	if run.State != "partial" || !strings.Contains(run.Error, "巡检历史保存失败") || !strings.Contains(run.Report, "AI report") || len(run.Evidence) != 1 {
		t.Fatalf("persistence failure was hidden or report lost: %#v", run)
	}
	if len(emitted) != 1 || emitted[0].State == "completed" {
		t.Fatal("emitted a successful completion before saving history")
	}
}

func TestInspectionCompletionCallbackCanStartNextInspection(t *testing.T) {
	manager, err := NewManager(t.TempDir(), func(ctx context.Context, _ string, _ Query) Evidence {
		<-ctx.Done()
		return Evidence{Status: "unavailable", Error: ctx.Err().Error()}
	}, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	id := strings.Repeat("a", 32)
	manager.runs[id] = &Run{ID: id, ProfileID: "server", SessionID: "session", State: "analyzing", Language: "en", Report: "finished report"}
	manager.active[id] = func() {}
	var next Run
	var startErr error
	manager.emit = func(run Run) {
		if run.ID == id && Terminal(run.State) {
			next, startErr = manager.Start(context.Background(), "session", "server", "fixture", "en", ai.Config{Provider: ai.ProviderOpenAI, Model: "fixture"})
		}
	}
	manager.finish(id, "completed", "")
	if startErr != nil || next.ID == "" {
		t.Fatalf("completion still held the server slot: %v", startErr)
	}
	manager.Cancel(next.ID)
	awaitRun(t, manager, next.ID)
}

func TestInspectionDeadlinePreservesEvidence(t *testing.T) {
	manager, err := NewManager(t.TempDir(), func(ctx context.Context, _ string, query Query) Evidence {
		if query.Check == "system" {
			return Evidence{Status: "collected", Output: "Linux"}
		}
		<-ctx.Done()
		return Evidence{Status: "unavailable", Error: ctx.Err().Error()}
	}, func(context.Context, ai.Config, ai.ChatRequest, func(ai.ChatResponse)) error {
		t.Error("model called after deadline")
		return nil
	}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	manager.timeout = 25 * time.Millisecond
	started, err := manager.Start(context.Background(), "session", "profile", "Server", "English", ai.Config{Model: "test"})
	if err != nil {
		t.Fatal(err)
	}
	run := awaitRun(t, manager, started.ID)
	if run.State != "partial" || !strings.Contains(run.Error, "deadline exceeded") || len(run.Evidence) < 1 || run.Report == "" {
		t.Fatalf("deadline lost partial result: %#v", run)
	}
}
