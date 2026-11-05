package workflow

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func storedReport(t *testing.T) (*Manager, Run) {
	t.Helper()
	m, err := NewManager(t.TempDir(), nil, nil, nil, func(_ string, text string) string { return strings.ReplaceAll(text, "secret-value", "[redacted]") })
	if err != nil {
		t.Fatal(err)
	}
	run := reportRun("zh-CN")
	run.State = "completed"
	run.ProfileID = "server"
	run.SessionID = "session"
	run.Document = fallbackDocument(run)
	run.Report = ReportMarkdown(run)
	m.runs[run.ID] = &run
	if err := m.save(&run); err != nil {
		t.Fatal(err)
	}
	return m, run
}

func TestManualReviewPreservesAIAndPersistsAudit(t *testing.T) {
	m, run := storedReport(t)
	id := run.Document.Unknowns[0].ID
	reviewed, err := m.ReviewUnknown(run.ID, id, "not_applicable", "已核实 secret-value", "operator")
	if err != nil {
		t.Fatal(err)
	}
	if reviewed.Document.Checks[0].Status != "unknown" || reviewed.Document.Verdict != "unknown" || reviewed.Reviews[0].Note != "已核实 [redacted]" {
		t.Fatal("human review changed AI evidence or failed redaction")
	}
	confirmed, pending, _ := ReviewStatus(reviewed)
	if confirmed != 1 || pending != 6 {
		t.Fatal("wrong human review progress")
	}
	if _, err := m.ReviewUnknown(run.ID, "forged", "normal", "", "operator"); err == nil {
		t.Fatal("accepted unrelated review item")
	}
	withdrawn, err := m.ReviewUnknown(run.ID, id, "pending", "重新核实", "operator")
	if err != nil {
		t.Fatal(err)
	}
	if len(withdrawn.Reviews) != 2 || !strings.Contains(withdrawn.Report, "待核实") {
		t.Fatal("withdrawal audit lost")
	}
	reopened, err := NewManager(m.dir, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	saved, _ := reopened.Get(run.ID)
	if len(saved.Reviews) != 2 || saved.Document.Unknowns[0].ID != id {
		t.Fatal("review history not restored")
	}
	m.dir = filepath.Join(t.TempDir(), "missing")
	if _, err := m.ReviewUnknown(run.ID, id, "issue", "", "operator"); err == nil {
		t.Fatal("hidden persistence failure")
	}
	unchanged, _ := m.Get(run.ID)
	if len(unchanged.Reviews) != 2 {
		t.Fatal("unsaved confirmation appeared as persisted")
	}
}

func TestComparisonUsesMeasurementsAndSameServer(t *testing.T) {
	old := reportRun("zh-CN")
	old.State = "completed"
	old.ProfileID = "server"
	old.CreatedAt = time.Now().Add(-time.Hour)
	current := reportRun("zh-CN")
	current.ID = strings.Repeat("b", 32)
	current.State = "completed"
	current.ProfileID = "server"
	for i := range old.Evidence {
		switch old.Evidence[i].Query.Check {
		case "disk":
			old.Evidence[i].Output = "/dev/vda1 10240 4096 6144 40% /"
			current.Evidence[i].Output = "/dev/vda1 10240 6144 4096 60% /"
		case "memory":
			old.Evidence[i].Output = "Mem: 1000 200 300 0 500 700"
			current.Evidence[i].Output = "Mem: 1000 400 100 0 500 500"
		case "load":
			old.Evidence[i].Output = "load average: 0.00, 0.20, 0.10"
			current.Evidence[i].Output = "load average: 0.50, 0.20, 0.10"
		case "ports":
			old.Evidence[i].Output = "LISTEN 0 128 0.0.0.0:22 *:*"
			current.Evidence[i].Output = "LISTEN 0 128 0.0.0.0:22 *:*\nLISTEN 0 128 0.0.0.0:8080 *:*"
		case "services":
			old.Evidence[i].Output = "GXSHELL_SERVICE_MANAGER=systemd\n"
			current.Evidence[i].Output = "GXSHELL_SERVICE_MANAGER=systemd\nnginx.service loaded failed failed Nginx"
		}
	}
	comp, err := CompareReports(current, old)
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]string{}
	for _, c := range comp.Changes {
		found[c.Metric] = c.Delta
	}
	if !strings.Contains(found["disk"], "+2.0 MiB") || found["memory_used"] != "+200 MiB" || !strings.Contains(found["ports"], "+ 0.0.0.0:8080") || !strings.Contains(found["services"], "+ nginx.service") {
		t.Fatalf("wrong changes: %#v", found)
	}
	old.ProfileID = "other"
	if _, err := CompareReports(current, old); err == nil {
		t.Fatal("compared different servers")
	}
	old.ProfileID = "server"
	current.Evidence[2].Truncated = true
	comp, err = CompareReports(current, old)
	if err != nil {
		t.Fatal(err)
	}
	if comp.Changes[0].State != "unknown" {
		t.Fatal("treated truncated data as a trend")
	}
}

func TestDiskScopesAndMeasuredFaults(t *testing.T) {
	if len(runQueries(Run{Workflow: "disk_diagnosis"})) != 6 {
		t.Fatal("disk baseline missing")
	}
	for _, path := range []string{"/etc", "/var/log;reboot", "$(id)", "../tmp"} {
		if _, err := Command(Query{Check: "disk_usage", Scope: path}); err == nil {
			t.Fatal("accepted arbitrary scan scope")
		}
	}
	cmd, err := Command(Query{Check: "disk_usage", Scope: "/var/log"})
	if err != nil || !strings.Contains(cmd, "timeout 12") || !strings.Contains(cmd, "nice -n 19") || strings.Contains(cmd, "sudo") {
		t.Fatal("scan is not bounded")
	}
	run := reportRun("zh-CN")
	run.Evidence[2].Output = "/dev/vda1 100 98 2 98% /"
	doc, err := decodeReport(testReportJSON("zh-CN", Checks), run)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Checks[2].Status != "critical" || doc.Verdict != "attention" || len(doc.Findings) == 0 {
		t.Fatal("missed measured near-full disk")
	}
}

func TestActionPlanIsConsumedOnceAndRecoversUnknown(t *testing.T) {
	m, run := storedReport(t)
	run.Workflow = "service_diagnosis"
	run.Service = "nginx.service"
	run.Port = 80
	run.Evidence = append(run.Evidence, Evidence{ID: "E8", Query: Query{Check: "service", Service: run.Service, View: "status"}, Status: "collected", Output: "LoadState=loaded\nActiveState=inactive"})
	run.Evidence[0].Output = "Linux 6.8.0 x86_64\nGXSHELL_UID=1000"
	m.runs[run.ID] = &run
	if _, err := m.PreparePlan(run.ID, "restart_service"); err == nil || !strings.Contains(err.Error(), "root") {
		t.Fatalf("plan offered to a non-root account: %v", err)
	}
	run.Evidence[0].Output = "Linux 6.8.0 x86_64\nGXSHELL_UID=0"
	prepared, err := m.PreparePlan(run.ID, "restart_service")
	if err != nil {
		t.Fatal(err)
	}
	p := prepared.Plans[0]
	if strings.Contains(p.Command, "sudo") || p.Command != "systemctl restart -- 'nginx.service'" {
		t.Fatal("unexpected plan command")
	}
	_, ctx, err := m.BeginPlan(context.Background(), run.ID, p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.BeginPlan(context.Background(), run.ID, p.ID); err == nil {
		t.Fatal("executed a plan twice")
	}
	if !m.Cancel(run.ID) {
		t.Fatal("active action cannot be cancelled")
	}
	<-ctx.Done()
	finished, err := m.FinishPlan(run.ID, p.ID, ActionPlan{Status: "unknown", Error: "context canceled"})
	if err != nil {
		t.Fatal(err)
	}
	if finished.Plans[0].Status != "unknown" || !strings.Contains(finished.Report, "执行计划与复查") {
		t.Fatal("action outcome lost")
	}
	if _, _, err := m.BeginPlan(context.Background(), run.ID, p.ID); err == nil {
		t.Fatal("replayed unknown action")
	}
	// A process exit during an action must not resume the modifying command.
	finished.Plans[0].Status = "running"
	data, _ := json.Marshal(finished)
	if err := os.WriteFile(filepath.Join(m.dir, run.ID+".json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewManager(m.dir, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	restored, _ := reopened.Get(run.ID)
	if restored.Plans[0].Status != "unknown" {
		t.Fatal("interrupted action was resumed")
	}
}

func TestManualCompletionIsExportedSeparatelyFromAI(t *testing.T) {
	m, run := storedReport(t)
	for _, unknown := range run.Document.Unknowns {
		if _, err := m.ReviewUnknown(run.ID, unknown.ID, "normal", "人工核实", "operator"); err != nil {
			t.Fatal(err)
		}
	}
	reviewed, _ := m.Get(run.ID)
	if reviewed.Document.Verdict != "unknown" || !strings.Contains(reviewed.Report, "| AI 原结论 | 未确认 |") || !strings.Contains(reviewed.Report, "已人工核实 · 7/7") {
		t.Fatal("export lost manual completion or replaced AI conclusion")
	}
}

func TestDiskComparisonIncludesInodesAndFixedDirectoryGrowth(t *testing.T) {
	old := reportRun("en")
	old.State, old.ProfileID, old.Workflow = "completed", "server", "disk_diagnosis"
	old.CreatedAt = time.Now().Add(-time.Hour)
	old.Evidence = []Evidence{
		{Query: Query{Check: "disk"}, Status: "collected", Output: "/dev/vda1 100000 10000 90000 10% /"},
		{Query: Query{Check: "inodes"}, Status: "collected", Output: "/dev/vda1 100000 10000 90000 10% /"},
		{Query: Query{Check: "disk_usage"}, Status: "collected", Output: "1024\t/var/log\n2048\t/home"},
	}
	current := clone(&old)
	current.CreatedAt = time.Now()
	current.Evidence[1].Output = "/dev/vda1 100000 95000 5000 95% /"
	current.Evidence[2].Output = "3072\t/var/log\n2048\t/home"
	comparison, err := CompareReports(current, old)
	if err != nil {
		t.Fatal(err)
	}
	inodes, directory := false, false
	for _, change := range comparison.Changes {
		if change.Metric == "inodes" && change.Delta == "+85% · +85000" {
			inodes = true
		}
		if change.Metric == "disk_usage" && change.Subject == "/var/log" && change.Delta == "+2.0 MiB" {
			directory = true
		}
		if change.Metric == "memory_used" {
			t.Fatal("compared measurements outside workflow scope")
		}
	}
	if !inodes || !directory {
		t.Fatal("inode or directory growth missing")
	}
}

func TestMeasuredFaultsSurviveModelFailure(t *testing.T) {
	run := reportRun("en")
	run.Evidence[2].Output = "/dev/vda1 100000 98000 2000 98% /"
	doc := fallbackDocument(run)
	if doc.Verdict != "attention" || doc.Checks[2].Status != "critical" || len(doc.Findings) != 1 {
		t.Fatal("model failure hid measured disk pressure")
	}
}
