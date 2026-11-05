package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gxShell/backend/workflow"
)

func TestInspectionExportUsesStoredStructuredReport(t *testing.T) {
	path := filepath.Join(t.TempDir(), "inspection.md")
	run := workflow.Run{ID: strings.Repeat("a", 32), Target: "英国", Language: "zh-CN", CreatedAt: time.Now(), State: "completed",
		Document: &workflow.ReportDocument{Version: 1, Verdict: "unknown", Summary: "容器状态未确认。", Checks: []workflow.ReportCheck{}, Findings: []workflow.Finding{}, Unknowns: []workflow.Uncertainty{}},
		Evidence: []workflow.Evidence{{ID: "E7", Query: workflow.Query{Check: "containers"}, Status: "unavailable", Error: "远程退出码 127", Output: "docker: not found"}}}
	if err := writeInspectionExport(path, run); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(data), "# 主机巡检报告") || !strings.Contains(string(data), "### E7") || !strings.Contains(string(data), "    docker: not found") {
		t.Fatal("export lost report or evidence")
	}
	legacy := workflow.Run{Report: "# Historical report"}
	if err := writeInspectionExport(path, legacy); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(path)
	if string(data) != legacy.Report {
		t.Fatal("legacy report was rewritten")
	}
}
