package app

import (
	"fmt"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	"os"
	"strings"

	"gxShell/backend/ai"
	"gxShell/backend/i18n"
	"gxShell/backend/types"
	"gxShell/backend/workflow"
)

func (a *App) StartAiInspectionBatch(sessionIDs []string, concurrency int) (workflow.InspectionBatch, error) {
	l := workflow.NormalizeLanguage(a.uiLanguage())
	if a.inspections == nil || a.ssh == nil || a.ai == nil || a.ctx.Get() == nil {
		return workflow.InspectionBatch{}, fmt.Errorf("inspection service unavailable")
	}
	if len(sessionIDs) < 2 || len(sessionIDs) > workflow.MaxBatchTargets || concurrency < 1 || concurrency > workflow.MaxBatchConcurrency {
		return workflow.InspectionBatch{}, fmt.Errorf("%s", i18n.Text(l, "请选择 2～12 台已连接主机，并行数为 1～3。", "Select 2–12 connected hosts and concurrency 1–3."))
	}
	cfg := a.ai.GetConfig()
	if cfg.Model == "" {
		return workflow.InspectionBatch{}, fmt.Errorf("configure an AI model")
	}
	if err := ai.ValidateConfig(cfg); err != nil {
		return workflow.InspectionBatch{}, err
	}
	targets := []workflow.BatchTarget{}
	generations := map[string]uint64{}
	seen := map[string]bool{}
	items := []cliApprovalItem{}
	for _, id := range sessionIDs {
		info, err := a.ssh.Get(id)
		if err != nil || info.State != types.SessionConnected {
			return workflow.InspectionBatch{}, fmt.Errorf("%s", i18n.Text(l, "所选 SSH 连接已失效，请重新选择。", "A selected SSH connection is unavailable; select again."))
		}
		key := info.ProfileID
		if key == "" {
			key = "session:" + id
		}
		if seen[key] {
			return workflow.InspectionBatch{}, fmt.Errorf("duplicate inspection host")
		}
		seen[key] = true
		targets = append(targets, workflow.BatchTarget{SessionID: id, ProfileID: info.ProfileID, Target: info.Name, Generation: info.Generation})
		generations[id] = info.Generation
		items = append(items, cliApprovalItem{ID: id, Kind: "inspection", Text: info.Name, RiskTier: "T0"})
	}
	message := fmt.Sprintf(i18n.Text(l, "同时巡检 %d 台主机，最多 %d 台并行。每台独立采集、补查并生成报告。系统、资源、服务、端口、容器证据及主机背景会发送给 %s / %s（%s），并保存至本机。\n\n每台最多三轮预定义只读补查。允许全部主机后开始；取消任一项则整批不开始。", "Inspect %d hosts with concurrency %d. Each host collects, queries and reports independently. System, resource, service, port, container evidence and host background are sent to %s / %s (%s) and saved locally.\n\nAt most three predefined read-only query rounds per host. All hosts must be approved; unchecking any cancels the batch."), len(targets), concurrency, cfg.Provider, cfg.Model, strings.TrimRight(cfg.Endpoint, "/"))
	if !a.confirmInspection(i18n.Text(l, "确认批量巡检", "Confirm batch inspection"), message, cliApprovalPanelRequest{Source: "ai", Server: "gxShell", Summary: message, Items: items}) {
		return workflow.InspectionBatch{}, fmt.Errorf("%s", i18n.Text(l, "已取消批量巡检。", "Batch inspection cancelled."))
	}
	for _, target := range targets {
		current, err := a.ssh.Get(target.SessionID)
		if err != nil || current.State != types.SessionConnected || current.ProfileID != target.ProfileID || current.Generation != generations[target.SessionID] {
			return workflow.InspectionBatch{}, fmt.Errorf("%s", i18n.Text(l, "SSH 连接已变化，请重新开始。", "SSH target changed; start again."))
		}
	}
	return a.inspections.StartBatch(a.ctx.Get(), targets, l, cfg, concurrency)
}

func (a *App) ListAiInspectionBatches() []workflow.InspectionBatch {
	if a.inspections == nil {
		return []workflow.InspectionBatch{}
	}
	return a.inspections.ListBatches()
}

func (a *App) GetAiInspectionBatch(id string) (workflow.InspectionBatch, error) {
	if a.inspections == nil {
		return workflow.InspectionBatch{}, fmt.Errorf("inspection service unavailable")
	}
	return a.inspections.GetBatch(id)
}

func (a *App) CancelAiInspectionBatch(id string) bool {
	return a.inspections != nil && a.inspections.CancelBatch(id)
}

func (a *App) validateInspectionSession(id string, generation uint64) error {
	current, err := a.ssh.Get(id)
	if err != nil || current.State != types.SessionConnected || current.Generation != generation {
		return fmt.Errorf("SSH target changed; start a new inspection")
	}
	return nil
}

func (a *App) ExportAiInspectionBatch(id string) (string, error) {
	batch, err := a.GetAiInspectionBatch(id)
	if err != nil {
		return "", err
	}
	if batch.State == "running" {
		return "", fmt.Errorf("batch is still running")
	}
	ctx := a.ctx.Get()
	if ctx == nil {
		return "", fmt.Errorf("application unavailable")
	}
	l := workflow.NormalizeLanguage(a.uiLanguage())
	path, err := runtime.SaveFileDialog(ctx, runtime.SaveDialogOptions{Title: i18n.Text(l, "导出批量巡检汇总", "Export batch inspection summary"), DefaultFilename: "inspection-batch-" + batch.CreatedAt.Local().Format("20060102-150405") + "-" + batch.ID[:8] + ".md", Filters: []runtime.FileFilter{{DisplayName: "Markdown (*.md)", Pattern: "*.md"}}})
	if err != nil || path == "" {
		return path, err
	}
	if err := os.WriteFile(path, []byte(workflow.BatchMarkdown(batch, l)), 0600); err != nil {
		return "", err
	}
	return path, nil
}
