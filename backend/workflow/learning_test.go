package workflow

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gxShell/backend/ai"
)

func TestDossierVersionSourceRedactionAndRecovery(t *testing.T) {
	m, run := storedReport(t)
	item := run.Document.Unknowns[0].ID
	if _, err := m.SaveDossier("server", DossierInput{ContainerRuntime: "none", SourceRunID: run.ID, SourceUnknownID: item}, "operator", false); err == nil {
		t.Fatal("remembered an unconfirmed item")
	}
	if _, err := m.ReviewUnknown(run.ID, item, "not_applicable", "确认", "operator"); err != nil {
		t.Fatal(err)
	}
	saved, err := m.SaveDossier("server", DossierInput{Purpose: "web secret-value", Services: []string{"nginx.service"}, Ports: []int{443}, ContainerRuntime: "none", Notes: "未部署容器", SourceRunID: run.ID, SourceUnknownID: item}, "operator", false)
	if err != nil || saved.Revision != 1 || saved.Purpose != "web [redacted]" {
		t.Fatalf("bad dossier: %+v %v", saved, err)
	}
	if _, err := m.SaveDossier("server", DossierInput{ContainerRuntime: "none"}, "operator", false); err == nil {
		t.Fatal("overwrote newer background")
	}
	if _, err := m.SaveDossier("other", DossierInput{ContainerRuntime: "none", SourceRunID: run.ID}, "operator", false); err == nil {
		t.Fatal("cross-server source accepted")
	}
	saved.Services[0] = "tampered.service"
	original, _ := m.GetDossier("server")
	if original.Services[0] != "nginx.service" {
		t.Fatal("getter leaked mutable background")
	}
	reopened, err := NewManager(m.dir, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	loaded, _ := reopened.GetDossier("server")
	if loaded.Revision != 1 || loaded.SourceUnknownID != item {
		t.Fatal("source/version lost")
	}
	cleared, err := reopened.SaveDossier("server", DossierInput{Revision: 1, ContainerRuntime: "unknown"}, "operator", true)
	if err != nil || !cleared.Deleted || cleared.Purpose != "" || len(cleared.History) != 1 {
		t.Fatal("clear lost background audit")
	}
}

func TestFollowupPinsBackgroundAndKeepsParentEvidence(t *testing.T) {
	m, source := storedReport(t)
	source.Evidence[5].Output = "LISTEN 0 128 0.0.0.0:8080 0.0.0.0:*"
	source.Evidence[6].Status, source.Evidence[6].Error = "unavailable", "docker missing"
	m.runs[source.ID] = &source
	_, err := m.SaveDossier("server", DossierInput{Purpose: "Web host", ContainerRuntime: "none"}, "operator", false)
	if err != nil {
		t.Fatal(err)
	}
	requestSeen := make(chan struct{})
	release := make(chan struct{})
	executed := 0
	m.execute = func(_ context.Context, session string, q Query) Evidence {
		if session != source.SessionID || q.Check != "ports" {
			t.Error("follow-up retargeted or queried unrelated baseline")
		}
		executed++
		return Evidence{Status: "collected", Output: "LISTEN 0 128 0.0.0.0:8080 0.0.0.0:* users:((\"nginx\",pid=42,fd=3))"}
	}
	m.chat = func(ctx context.Context, _ ai.Config, request ai.ChatRequest, emit func(ai.ChatResponse)) error {
		if !strings.Contains(request.Messages[0].Content, "Web host") || !strings.Contains(request.Messages[0].Content, "[redacted]") || strings.Contains(request.Messages[0].Content, "secret-value") {
			t.Error("background or redaction missing")
		}
		close(requestSeen)
		select {
		case <-release:
		case <-ctx.Done():
			return ctx.Err()
		}
		var input struct {
			Evidence []Evidence `json:"evidence"`
		}
		text := request.Messages[0].Content
		_ = json.Unmarshal([]byte(text[strings.Index(text, "{"):]), &input)
		doc := ReportDocument{Version: 2, Verdict: "unknown", Summary: "已核对端口归属。", Analysis: testAnalysis("zh-CN"), Checks: []ReportCheck{}, Findings: []Finding{}, Unknowns: []Uncertainty{}}
		for _, check := range Checks {
			for _, e := range currentEvidence(Run{Evidence: input.Evidence}) {
				if e.Query.Check == check {
					doc.Checks = append(doc.Checks, ReportCheck{Check: check, Status: "normal", Reading: "已核对采集结果。", EvidenceIDs: []string{e.ID}})
				}
			}
		}
		data, _ := json.Marshal(doc)
		emit(ai.ChatResponse{Content: string(data)})
		emit(ai.ChatResponse{Finish: true, PromptTk: 20, CompleteTk: 10})
		return nil
	}
	started, err := m.StartFollowup(context.Background(), source.ID, "zh-CN", ai.Config{Model: "test"}, "请确认端口 secret-value", "E6")
	if err != nil {
		t.Fatal(err)
	}
	<-requestSeen
	_, err = m.SaveDossier("server", DossierInput{Revision: 1, Purpose: "Changed purpose", ContainerRuntime: "docker"}, "operator", false)
	if err != nil {
		t.Fatal(err)
	}
	close(release)
	result := awaitRun(t, m, started.ID)
	if result.State != "completed" || result.ParentID != source.ID || result.Dossier.Revision != 1 || result.Dossier.Purpose != "Web host" {
		t.Fatalf("context not pinned: %s %s", result.State, result.Error)
	}
	if executed != 1 || len(result.Evidence) != 8 || result.Evidence[5].SourceRunID != source.ID || result.Evidence[7].SourceRunID != "" {
		t.Fatal("fresh and historical evidence mixed")
	}
	parent, _ := m.Get(source.ID)
	if len(parent.Evidence) != 7 || parent.Evidence[5].Output != source.Evidence[5].Output || len(parent.Reviews) != 0 {
		t.Fatal("parent report changed")
	}
	if result.Document.Checks[6].Status != "unknown" {
		t.Fatal("background replaced current unavailable measurement")
	}
	if len(result.Trace) != 3 || result.Trace[0].Kind != "query" || result.Trace[1].PromptTokens != 20 || !strings.Contains(result.Report, "AI 分析意见") {
		t.Fatal("trace or assessment missing")
	}
}

func TestAnalysisValidationAndLatestEvidence(t *testing.T) {
	run := reportRun("en")
	run.ReportSchemaVersion = 2
	var doc ReportDocument
	_ = json.Unmarshal([]byte(testReportJSON("en", Checks)), &doc)
	doc.Analysis = nil
	data, _ := json.Marshal(doc)
	if _, err := decodeReport(string(data), run); err == nil {
		t.Fatal("new report omitted opinions")
	}
	doc.Analysis = testAnalysis("en")
	doc.Analysis.Insights[0].EvidenceIDs = []string{"E999"}
	data, _ = json.Marshal(doc)
	if _, err := decodeReport(string(data), run); err == nil {
		t.Fatal("invented analysis citation")
	}
	doc.Analysis = testAnalysis("en")
	run.Evidence[0].Status = "unavailable"
	data, _ = json.Marshal(doc)
	if _, err := decodeReport(string(data), run); err == nil {
		t.Fatal("missing tool presented as supported interpretation")
	}
	run.Evidence[0].Status = "collected"
	run.Evidence = append(run.Evidence, Evidence{ID: "E8", Query: Query{Check: "disk"}, Status: "collected", Output: "/dev/vda1 100 20 80 20% /"})
	if _, err := decodeReport(string(data), run); err == nil {
		t.Fatal("stale disk citation accepted")
	}
	doc.Checks[2].EvidenceIDs = []string{"E8"}
	data, _ = json.Marshal(doc)
	if _, err := decodeReport(string(data), run); err != nil {
		t.Fatal(err)
	}
}

func TestEvaluationGradesRawModelWithoutSSHAndPersists(t *testing.T) {
	model := func(_ context.Context, _ ai.Config, request ai.ChatRequest, emit func(ai.ChatResponse)) error {
		if request.EnableTools || len(request.Tools) != 0 {
			t.Error("evaluation exposed execution tools")
		}
		emit(ai.ChatResponse{Content: testReportJSON("en", Checks)})
		emit(ai.ChatResponse{Finish: true, PromptTk: 12, CompleteTk: 4})
		return nil
	}
	m, err := NewManager(t.TempDir(), func(context.Context, string, Query) Evidence { t.Error("evaluation called SSH"); return Evidence{} }, model, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	started, err := m.StartEvaluation(context.Background(), ai.Config{Model: "test"}, "en", []string{"healthy_host", "disk_pressure"})
	if err != nil {
		t.Fatal(err)
	}
	var completed EvaluationRun
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		values := m.ListEvaluations()
		if values[0].State != "running" {
			completed = values[0]
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if completed.ID != started.ID || len(completed.Results) != 2 || !completed.Results[0].Passed {
		t.Fatal("healthy case did not pass")
	}
	disk := completed.Results[1]
	if disk.Passed || !disk.SchemaValid || disk.CorrectChecks != 6 || disk.Actual["disk"] != "normal" {
		t.Fatal("backend correction inflated model score")
	}
	reopened, err := NewManager(m.dir, nil, nil, nil, nil)
	if err != nil || reopened.ListEvaluations()[0].Results[1].Actual["disk"] != "normal" {
		t.Fatal("evaluation history lost")
	}
	interrupted := completed
	interrupted.State = "running"
	if err := writeLearning(filepath.Join(m.dir, "evaluations", interrupted.ID+".json"), interrupted); err != nil {
		t.Fatal(err)
	}
	reopened, err = NewManager(m.dir, nil, nil, nil, nil)
	if err != nil || reopened.ListEvaluations()[0].State != "interrupted" {
		t.Fatal("unfinished evaluation resumed")
	}
}

func TestFeedbackAndBackgroundSaveFailures(t *testing.T) {
	m, run := storedReport(t)
	if _, err := m.FeedbackReport(run.ID, "missed_issue", "", "operator"); err == nil {
		t.Fatal("empty bad case accepted")
	}
	feedback, err := m.FeedbackReport(run.ID, "false_alarm", "误报 secret-value", "operator")
	if err != nil || feedback.Feedback[0].Note != "误报 [redacted]" || !strings.Contains(feedback.Report, "诊断反馈") {
		t.Fatal("feedback lost or not redacted")
	}
	m.dir = filepath.Join(t.TempDir(), "missing")
	if _, err := m.SaveDossier("server", DossierInput{ContainerRuntime: "none"}, "operator", false); err == nil {
		t.Fatal("unsaved background claimed success")
	}
	background, _ := m.GetDossier("server")
	if background.Revision != 0 {
		t.Fatal("failed save changed current background")
	}
}
