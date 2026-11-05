package workflow

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gxShell/backend/ai"
)

func reportRun(language string) Run {
	run := Run{ID: strings.Repeat("a", 32), Workflow: "host_inspection", Target: "Test host", Language: language, CreatedAt: time.Now(), Evidence: []Evidence{}}
	for i, check := range Checks {
		run.Evidence = append(run.Evidence, Evidence{ID: fmt.Sprintf("E%d", i+1), Query: Query{Check: check}, Status: "collected", Output: "example"})
	}
	return run
}

func TestReportValidatesLanguageReferencesAndUnknownChecks(t *testing.T) {
	run := reportRun("zh-CN")
	if _, err := decodeReport(testReportJSON("en", Checks), run); err == nil {
		t.Fatal("accepted English report for Chinese interface")
	}
	var doc ReportDocument
	_ = json.Unmarshal([]byte(testReportJSON("zh-CN", Checks)), &doc)
	doc.Checks[0].EvidenceIDs = []string{"E999"}
	data, _ := json.Marshal(doc)
	if _, err := decodeReport(string(data), run); err == nil {
		t.Fatal("accepted invented evidence")
	}
	doc.Checks[0].EvidenceIDs = []string{"E1"}
	run.Evidence[6].Status = "unavailable"
	run.Evidence[6].Error = "remote exit code 127"
	run.Evidence[4].Output = "GXSHELL_SERVICE_MANAGER=systemd\n"
	doc.Checks[4].Status = "unknown"
	run.Evidence[2].Truncated = true
	data, _ = json.Marshal(doc)
	result, err := decodeReport(string(data), run)
	if err != nil {
		t.Fatal(err)
	}
	if result.Checks[4].Status != "normal" || result.Checks[6].Status != "unknown" || result.Checks[2].Status != "unknown" || result.Verdict != "unknown" || len(result.Unknowns) < 2 {
		t.Fatal("lost deterministic service interpretation or unknown coverage")
	}
	run.Document = result
	md := ReportMarkdown(run)
	if !strings.Contains(md, "远程退出码 127") || !strings.Contains(md, "[E7](#e7)") || !strings.Contains(md, "## 检查总览") {
		t.Fatal("export lost localized structure or evidence links")
	}
	doc.Findings = nil
	data, _ = json.Marshal(doc)
	if _, err := decodeReport(string(data), run); err == nil {
		t.Fatal("accepted null arrays that break rendering")
	}
}

func TestReportMarkdownEscapesRemoteDataAndSafeFilename(t *testing.T) {
	run := reportRun("en")
	run.Target = "../bad:host|name"
	run.Document = fallbackDocument(run)
	run.Document.Summary = "<script>alert(1)</script> | fake table"
	run.Evidence[0].Output = "# forged heading\n```\nmalicious prose"
	md := ReportMarkdown(run)
	if strings.Contains(md, "\n# forged heading") || strings.Contains(md, "<script>") || !strings.Contains(md, "\n    # forged heading") {
		t.Fatal("remote data escaped the evidence block")
	}
	name := ExportFilename(run)
	if strings.ContainsAny(name, "/\\:|") || !strings.HasSuffix(name, ".md") {
		t.Fatalf("unsafe filename: %s", name)
	}
}

func TestInspectionRepairsWrongLanguageWithoutMoreQueries(t *testing.T) {
	calls, queries := 0, 0
	manager, err := NewManager(t.TempDir(), func(context.Context, string, Query) Evidence {
		queries++
		return Evidence{Status: "collected", Output: "example"}
	},
		func(_ context.Context, _ ai.Config, req ai.ChatRequest, onChunk func(ai.ChatResponse)) error {
			if !strings.Contains(req.Instructions, "简体中文") {
				t.Error("interface language missing from model instruction")
			}
			if calls == 0 {
				onChunk(ai.ChatResponse{Content: testReportJSON("en", Checks)})
			} else {
				if req.EnableTools {
					t.Error("repair can execute tools")
				}
				onChunk(ai.ChatResponse{Content: testReportJSON("zh-CN", Checks)})
			}
			calls++
			onChunk(ai.ChatResponse{Finish: true, PromptTk: 3, CompleteTk: 2})
			return nil
		}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	started, err := manager.Start(context.Background(), "session", "profile", "主机", "Chinese", ai.Config{Model: "test"})
	if err != nil {
		t.Fatal(err)
	}
	run := awaitRun(t, manager, started.ID)
	if run.State != "completed" || run.Document == nil || calls != 2 || queries != 7 || run.PromptTokens != 6 || strings.Contains(run.Report, "Inspection completed") {
		t.Fatal("bounded language repair failed")
	}
	saved, err := os.ReadFile(filepath.Join(manager.dir, run.ID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var disk Run
	if json.Unmarshal(saved, &disk) != nil || disk.Document == nil || disk.Report != run.Report {
		t.Fatal("structured report was not persisted")
	}
}

func TestServiceDiagnosisPinsInputsAndBoundedLocalProbe(t *testing.T) {
	for _, port := range []int{0, -1, 65536} {
		if ValidateDiagnosis("nginx.service", port) == nil {
			t.Fatal("accepted invalid port")
		}
	}
	if ValidateDiagnosis("nginx;reboot", 80) == nil {
		t.Fatal("accepted injected service")
	}
	run := Run{Workflow: "service_diagnosis", Service: "nginx.service", Port: 8080, Language: "en"}
	queries := runQueries(run)
	if len(queries) != 6 || queries[5].Port != 8080 || queries[3].Service != "nginx.service" {
		t.Fatal("diagnosis inputs not pinned")
	}
	command, err := Command(queries[5])
	if err != nil || !strings.Contains(command, "127.0.0.1 8080") || !strings.Contains(command, "timeout 4") {
		t.Fatalf("unexpected local probe: %s %v", command, err)
	}
	call := ai.ToolCall{Function: ai.FunctionCall{Name: "inspect_service", Arguments: `{"service":"nginx.service","view":"logs","reason":"核实服务错误"}`}}
	query, reason, err := decodeQueryReason(call)
	if err != nil || reason != "核实服务错误" || query.Service != "nginx.service" {
		t.Fatal("query reason lost")
	}
}

func TestServiceDiagnosisCompletesWithStoredEvidence(t *testing.T) {
	queries := []Query{}
	manager, err := NewManager(t.TempDir(), func(_ context.Context, _ string, q Query) Evidence {
		queries = append(queries, q)
		return Evidence{Status: "collected", Output: "example"}
	},
		func(_ context.Context, _ ai.Config, req ai.ChatRequest, onChunk func(ai.ChatResponse)) error {
			if !strings.Contains(req.Instructions, "nginx.service") || !strings.Contains(req.Instructions, "8080") || !strings.Contains(req.Instructions, "127.0.0.1") {
				t.Error("diagnosis scope missing from model input")
			}
			doc := ReportDocument{Version: 2, Analysis: testAnalysis("en"), Verdict: "unknown", Summary: "Local evidence collected; external access is unconfirmed.", Checks: []ReportCheck{}, Findings: []Finding{}, Unknowns: []Uncertainty{{Title: "External access", Detail: "The local TCP probe does not establish public reachability.", EvidenceIDs: []string{"E6"}}}}
			for _, check := range RunChecks(Run{Workflow: "service_diagnosis"}) {
				for i, q := range queries {
					if q.Check == check {
						doc.Checks = append(doc.Checks, ReportCheck{Check: check, Status: "normal", Reading: "Collected evidence reviewed.", EvidenceIDs: []string{fmt.Sprintf("E%d", i+1)}})
						break
					}
				}
			}
			data, _ := json.Marshal(doc)
			onChunk(ai.ChatResponse{Content: string(data)})
			onChunk(ai.ChatResponse{Finish: true})
			return nil
		}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	started, err := manager.StartDiagnosis(context.Background(), "ssh", "profile", "Server", "en", ai.Config{Model: "test"}, "nginx.service", 8080)
	if err != nil {
		t.Fatal(err)
	}
	run := awaitRun(t, manager, started.ID)
	if run.State != "completed" || run.Workflow != "service_diagnosis" || run.Service != "nginx.service" || run.Port != 8080 || len(run.Evidence) != 6 || run.Document == nil || !strings.Contains(run.Report, "Service connectivity diagnosis") {
		t.Fatalf("unexpected diagnosis: %s %s", run.State, run.Error)
	}
	reopened, err := NewManager(manager.dir, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	saved, _ := reopened.Get(run.ID)
	if saved.Workflow != run.Workflow || saved.Document == nil {
		t.Fatal("diagnosis history not restored")
	}
}

func TestMeasurementsComeFromEvidence(t *testing.T) {
	for _, test := range []struct{ check, output, want string }{
		{"disk", "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 100 90 10 90% /\ntmpfs 100 0 100 0% /run", "/ · 90%"},
		{"load", "up 9 hours, load average: 0.00, 0.12, 0.25", "0.00 / 0.12 / 0.25"},
		{"memory", "Mem: 937 280 17 1 640 657", "已用 280 / 937 MiB · 可用 657 MiB"},
	} {
		e := Evidence{Query: Query{Check: test.check}, Status: "collected", Output: test.output}
		if got := observedValues(e, "zh-CN"); got != test.want {
			t.Fatalf("wrong source values: %q", got)
		}
		e.Truncated = true
		if observedValues(e, "zh-CN") != "" {
			t.Fatal("displayed incomplete output as a full measurement")
		}
	}
}

func TestStructuredHistoryFitsBoundedEvidence(t *testing.T) {
	run := reportRun("en")
	for len(run.Evidence) < 16 {
		run.Evidence = append(run.Evidence, Evidence{ID: fmt.Sprintf("E%d", len(run.Evidence)+1), Query: Query{Check: "service"}, Status: "collected"})
	}
	for i := range run.Evidence {
		run.Evidence[i].Output = strings.Repeat("\x00", maxOutput)
	}
	run.Document = fallbackDocument(run)
	run.Report = ReportMarkdown(run)
	manager, err := NewManager(t.TempDir(), nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.save(&run); err != nil {
		t.Fatalf("bounded structured report exceeded history capacity: %v", err)
	}
}
