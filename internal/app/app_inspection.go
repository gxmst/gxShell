package app

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"gxShell/backend/i18n"
	"gxShell/backend/logger"
	"gxShell/backend/types"
	"gxShell/backend/workflow"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// StartAiInspection authorizes one immutable read-only workflow. The renderer
// supplies only a connected session ID, never templates, commands or tool names.
func (a *App) StartAiInspection(sessionID string) (workflow.Run, error) {
	return a.startAiInspection(sessionID, "", "", 0)
}

func (a *App) StartAiServiceDiagnosis(sessionID, service string, port int) (workflow.Run, error) {
	if err := workflow.ValidateDiagnosis(service, port); err != nil {
		return workflow.Run{}, fmt.Errorf("%s", i18n.Text(a.uiLanguage(), "请填写有效的服务名和 1–65535 之间的端口。", "Enter a valid service name and a port between 1 and 65535."))
	}
	return a.startAiInspection(sessionID, "service_diagnosis", service, port)
}

func (a *App) StartAiDiskDiagnosis(sessionID string) (workflow.Run, error) {
	return a.startAiInspection(sessionID, "disk_diagnosis", "", 0)
}

func (a *App) ReviewAiInspectionUnknown(id, unknownID, outcome, note string) (workflow.Run, error) {
	if a.inspections == nil {
		return workflow.Run{}, fmt.Errorf("inspection service unavailable")
	}
	return a.inspections.ReviewUnknown(id, unknownID, outcome, note, localInspectionReviewer())
}
func (a *App) CompareAiInspections(currentID, baselineID string) (workflow.Run, error) {
	if a.inspections == nil {
		return workflow.Run{}, fmt.Errorf("inspection service unavailable")
	}
	return a.inspections.Compare(currentID, baselineID)
}
func (a *App) PrepareAiInspectionPlan(id, kind string) (workflow.Run, error) {
	if a.inspections == nil {
		return workflow.Run{}, fmt.Errorf("inspection service unavailable")
	}
	return a.inspections.PreparePlan(id, kind)
}
func (a *App) DismissAiInspectionPlan(id, planID string) (workflow.Run, error) {
	if a.inspections == nil {
		return workflow.Run{}, fmt.Errorf("inspection service unavailable")
	}
	return a.inspections.DismissPlan(id, planID)
}

// The renderer supplies a stored plan ID; it never supplies a shell command.
// Native confirmation covers the exact action and the subsequent diagnostic.
func (a *App) ExecuteAiInspectionPlan(id, planID string) (workflow.Run, error) {
	run, err := a.GetAiInspection(id)
	if err != nil {
		return workflow.Run{}, err
	}
	ctx := a.ctx.Get()
	if ctx == nil || a.ssh == nil || a.ai == nil {
		return run, fmt.Errorf("application unavailable")
	}
	var selected *workflow.ActionPlan
	for _, p := range run.Plans {
		if p.ID == planID && p.Status == "proposed" {
			copy := p
			selected = &copy
		}
	}
	if selected == nil {
		return run, fmt.Errorf("pending plan not found")
	}
	p, err := workflow.PlanTemplate(run, selected.Kind)
	if err != nil || p.Command != selected.Command {
		return run, fmt.Errorf("action plan changed")
	}
	info, err := a.ssh.Get(run.SessionID)
	if err != nil || info.State != types.SessionConnected || info.ProfileID != run.ProfileID {
		return run, fmt.Errorf("%s", i18n.Text(a.uiLanguage(), "原 SSH 连接已失效，请先重新诊断。", "The original SSH session is unavailable; run a fresh diagnosis."))
	}
	cfg := a.ai.GetConfig()
	if cfg.Model == "" {
		return run, fmt.Errorf("configure an AI model for verification")
	}
	l := workflow.NormalizeLanguage(a.uiLanguage())
	message := fmt.Sprintf(i18n.Text(l, "主机：%s\n操作：%s\n\n命令：\n%s\n\n影响：%s\n\n执行结果将保存在报告中，随后重新诊断，并发送采集结果给模型 %s。是否执行？", "Host: %s\nAction: %s\n\nCommand:\n%s\n\nImpact: %s\n\nThe result is recorded, followed by a new diagnosis whose evidence is sent to model %s. Execute?"), run.Target, p.Title, p.Command, p.Impact, cfg.Model)
	message += i18n.Text(l, "\n\n若已保存主机档案，复查也会将用途、运行预期和背景说明发送给模型，并记录使用的档案版本。", "\n\nIf host background is saved, verification also sends its purpose, operational expectations and notes to the model and records the background version used.")
	// Changes are confirmed every time; only read-only diagnoses are remembered.
	tier := "T2"
	if selected.Kind == "vacuum_journal_7d" {
		tier = "T3"
	}
	approved := a.confirmInspection(i18n.Text(l, "确认执行计划", "Confirm action plan"), message, cliApprovalPanelRequest{
		Source: "ai", Server: run.Target, Summary: p.Title, Critical: tier == "T3",
		Items: []cliApprovalItem{{ID: "plan", Kind: "command", Text: p.Command, RiskTier: tier, RiskLabel: p.Title,
			RiskLines: []string{p.Impact, fmt.Sprintf(i18n.Text(l, "执行后用模型 %s 重新诊断。", "A fresh diagnosis follows with model %s."), cfg.Model)}}},
	})
	if !approved {
		return run, nil
	}
	current, err := a.ssh.Get(run.SessionID)
	if err != nil || current.Generation != info.Generation || current.ProfileID != info.ProfileID || current.State != types.SessionConnected {
		return run, fmt.Errorf("SSH target changed")
	}
	p, actionCtx, err := a.inspections.BeginPlan(ctx, id, planID)
	if err != nil {
		return run, err
	}
	finished := false
	defer func() {
		if !finished {
			_, _ = a.inspections.FinishPlan(id, planID, workflow.ActionPlan{Status: "unknown", Error: i18n.Text(l, "操作意外中断，请重新诊断核实远程结果。", "The operation stopped unexpectedly; run a fresh diagnosis to verify the remote result.")})
		}
	}()
	activityID := a.beginTerminalAutomation(run.SessionID, "ai", "inspection_plan", p.Command)
	script := "PATH=/usr/sbin:/usr/bin:/sbin:/bin\nexport PATH\nLC_ALL=C\nexport LC_ALL\n" + p.Command + "\n"
	result, execErr := a.ssh.ExecuteCommandResultStream(actionCtx, run.SessionID, "sh -s", &script, 20*time.Second, 8192, nil)
	out := a.redactInspection(run.ProfileID, result.DisplayOutput())
	completion := workflow.ActionPlan{Status: "unknown", Output: out, ExitCode: result.ExitCode, RemoteState: cliRemoteState(result, execErr)}
	if execErr != nil {
		completion.Error = execErr.Error()
	} else if result.Error != "" {
		completion.Error = result.Error
	} else if result.RemoteExitObserved {
		if result.ExitCode == 0 {
			completion.Status = "completed"
		} else {
			completion.Status = "failed"
			completion.Error = fmt.Sprintf("remote exit code %d", result.ExitCode)
		}
	}
	a.finishTerminalAutomation(run.SessionID, activityID, "ai", "inspection_plan", out, completion.Error, result.ExitCode, result.Duration, result.Truncated)
	updated, finishErr := a.inspections.FinishPlan(id, planID, completion)
	finished = true
	if finishErr != nil {
		return updated, finishErr
	}
	// Never retry the modifying command. Verification is a separate read-only run.
	current, err = a.ssh.Get(run.SessionID)
	if err != nil || current.State != types.SessionConnected || current.Generation != info.Generation || current.ProfileID != info.ProfileID {
		message := i18n.Text(l, "操作结果已保存，原 SSH 连接已失效，复查未启动。请重新连接并诊断。", "Action result saved; the original SSH session is unavailable, so verification did not start. Reconnect and run a fresh diagnosis.")
		saved, saveErr := a.inspections.RecordVerificationError(id, planID, message)
		if saveErr != nil {
			return updated, fmt.Errorf("%s: %w", message, saveErr)
		}
		return saved, fmt.Errorf("%s", message)
	}
	var verification workflow.Run
	if run.Workflow == "service_diagnosis" {
		verification, err = a.inspections.StartDiagnosis(ctx, run.SessionID, run.ProfileID, run.Target, l, cfg, run.Service, run.Port)
	} else {
		verification, err = a.inspections.StartDiskDiagnosis(ctx, run.SessionID, run.ProfileID, run.Target, l, cfg)
	}
	if err != nil {
		message := fmt.Sprintf("%s: %v", i18n.Text(l, "操作结果已保存，复查未启动", "Action result saved; verification could not start"), err)
		saved, saveErr := a.inspections.RecordVerificationError(id, planID, message)
		if saveErr != nil {
			return updated, fmt.Errorf("%s: %w", message, saveErr)
		}
		return saved, fmt.Errorf("%s", message)
	}
	return a.inspections.LinkVerification(id, planID, verification.ID)
}

func (a *App) startAiInspection(sessionID, kind, service string, port int) (workflow.Run, error) {
	language := workflow.NormalizeLanguage(a.uiLanguage())
	messageError := func(zh, en string) error { return fmt.Errorf("%s", i18n.Text(language, zh, en)) }
	if a.inspections == nil || a.ssh == nil {
		return workflow.Run{}, messageError("巡检服务暂不可用。", "Inspection service unavailable.")
	}
	info, err := a.ssh.Get(sessionID)
	if err != nil || info.State != types.SessionConnected {
		return workflow.Run{}, messageError("请先连接 SSH 服务器。", "Connect an SSH server before starting inspection.")
	}
	cfg := a.ai.GetConfig()
	if cfg.Model == "" {
		return workflow.Run{}, messageError("请先配置并保存 AI 模型。", "Configure and save an AI model before starting inspection.")
	}
	ctx := a.ctx.Get()
	if ctx == nil {
		return workflow.Run{}, messageError("程序暂不可用。", "Application unavailable.")
	}
	zh := language == "zh-CN"
	title := "Start host inspection"
	message := fmt.Sprintf("Inspect %s?\n\nRead system, load, disk, memory, service, listening-port and container status. The selected AI model (%s) may request up to three rounds of predefined read-only service queries. Collected output is sent to that model and saved in local inspection history.\n\nNo configuration changes, restarts, installations or privilege escalation are available in this workflow.", info.Name, cfg.Model)
	if zh {
		title = "开始主机巡检"
		message = fmt.Sprintf("巡检 %s？\n\n读取系统、负载、磁盘、内存、服务、监听端口和容器状态。所选 AI 模型（%s）最多可进行三轮预定义的服务补查。采集内容将发送给该模型，并保存在本机巡检历史中。\n\n此工作流只提供查询，不提供配置修改、重启、安装或提权操作。", info.Name, cfg.Model)
	}
	if kind == "service_diagnosis" {
		title = i18n.Text(language, "开始服务连通性诊断", "Start service connectivity diagnosis")
		message = fmt.Sprintf(i18n.Text(language, "诊断 %s 上的 %s（TCP %d）？\n\n读取系统、服务状态、监听端口和近期日志，并从服务器本机测试 127.0.0.1:%d 的 TCP 连通性。本机连接成功不代表外网可访问。\n\n采集内容将发送给模型 %s，并保存至本机历史。最多三轮预定义补查，不提供修改或提权操作。", "Diagnose %s on %s (TCP %d)?\n\nRead system details, service status, listeners and recent logs, and test TCP connectivity to 127.0.0.1:%d from the server. Local connectivity does not prove public reachability.\n\nEvidence is sent to model %s and saved locally. At most three predefined follow-up rounds; no changes or privilege escalation."), info.Name, service, port, port, cfg.Model)
	}
	if kind == "disk_diagnosis" {
		title = i18n.Text(language, "开始磁盘空间诊断", "Start disk space diagnosis")
		message = fmt.Sprintf(i18n.Text(language, "诊断 %s 的磁盘空间？\n\n读取分区、inode、目录、系统日志和容器存储占用。目录扫描仅覆盖预定义路径，限时 12 秒并降低优先级；不清理文件、不提权。\n\n采集内容将发送给模型 %s 并保存在本机。最多三轮补查。", "Diagnose disk space on %s?\n\nRead partitions, inodes, fixed directory scopes, system journals and container storage. Directory scans stop after 12 seconds and use lower priority. No cleanup or elevation.\n\nEvidence is sent to model %s and saved locally. At most three follow-up rounds."), info.Name, cfg.Model)
	}
	message += i18n.Text(language, "\n\n若已保存主机档案，用途、运行预期和背景说明会一并发送给模型，并在报告中记录使用的档案版本。", "\n\nIf host background is saved, its purpose, operational expectations and notes are also sent to the model. The report records the background version used.")
	workflowKind := kind
	if workflowKind == "" {
		workflowKind = "host_inspection"
	}
	// Read-only workflows are confirmed once per server, model and host
	// background revision for this app run; changing any of them asks again.
	consent := a.inspectionConsentKey(info.ProfileID, workflowKind, cfg)
	if !a.inspectionConsented(consent) {
		scope := i18n.Text(language, "只读查询：系统、负载、磁盘、内存、服务、监听端口、容器", "Read-only queries: system, load, disk, memory, services, listening ports, containers")
		if kind == "service_diagnosis" {
			scope = fmt.Sprintf(i18n.Text(language, "只读查询：%s 的状态与近期日志，监听端口；本机测试 127.0.0.1:%d", "Read-only queries: %s status and recent logs, listeners; local probe of 127.0.0.1:%d"), service, port)
		} else if kind == "disk_diagnosis" {
			scope = i18n.Text(language, "只读查询：分区、inode、固定目录占用、系统日志、容器存储", "Read-only queries: partitions, inodes, fixed directory usage, journals, container storage")
		}
		// The read-only group starts collapsed, so the remembered-consent note
		// goes in the always-visible summary rather than on the item.
		summary := message + i18n.Text(language, "\n\n允许后，本次运行期间同一服务器、模型和主机档案版本的只读诊断不再询问。", "\n\nOnce allowed, read-only diagnoses with the same server, model and host background are not asked again while the app runs.")
		approved := a.confirmInspection(title, message, cliApprovalPanelRequest{Source: "ai", Server: info.Name, Summary: summary, Items: []cliApprovalItem{{
			ID: "inspection", Kind: "inspection", Text: scope, RiskTier: "T0",
		}}})
		if !approved {
			return workflow.Run{}, messageError("已取消开始巡检。", "Inspection cancelled before execution.")
		}
		a.rememberInspectionConsent(consent)
	}
	// Recheck after the confirmation dialog; never move to a replacement target.
	current, err := a.ssh.Get(sessionID)
	if err != nil || current.State != types.SessionConnected || current.ProfileID != info.ProfileID || current.Generation != info.Generation {
		return workflow.Run{}, messageError("SSH 连接已变化，请重新开始。", "SSH target changed; start a new inspection.")
	}
	if kind == "service_diagnosis" {
		return a.inspections.StartDiagnosis(ctx, sessionID, info.ProfileID, info.Name, language, cfg, service, port)
	}
	if kind == "disk_diagnosis" {
		return a.inspections.StartDiskDiagnosis(ctx, sessionID, info.ProfileID, info.Name, language, cfg)
	}
	return a.inspections.Start(ctx, sessionID, info.ProfileID, info.Name, language, cfg)
}

func (a *App) ExportAiInspection(id string) (string, error) {
	run, err := a.GetAiInspection(id)
	if err != nil {
		return "", err
	}
	language := workflow.NormalizeLanguage(a.uiLanguage())
	if !workflow.Terminal(run.State) || run.Report == "" {
		return "", fmt.Errorf("%s", i18n.Text(language, "报告尚未生成。", "The report is not ready."))
	}
	ctx := a.ctx.Get()
	if ctx == nil {
		return "", fmt.Errorf("%s", i18n.Text(language, "程序暂不可用。", "Application unavailable."))
	}
	a.nativeDialogMu.Lock()
	path, err := runtime.SaveFileDialog(ctx, runtime.SaveDialogOptions{Title: i18n.Text(language, "导出巡检报告", "Export inspection report"), DefaultFilename: workflow.ExportFilename(run), Filters: []runtime.FileFilter{{DisplayName: "Markdown (*.md)", Pattern: "*.md"}}})
	a.nativeDialogMu.Unlock()
	if err != nil || path == "" {
		return "", err
	}
	if err := writeInspectionExport(path, run); err != nil {
		return "", fmt.Errorf("%s: %w", i18n.Text(language, "报告导出失败", "Report export failed"), err)
	}
	return path, nil
}

func writeInspectionExport(path string, run workflow.Run) error {
	return os.WriteFile(path, []byte(workflow.ReportMarkdown(run)), 0600)
}

func (a *App) ListAiInspections() []workflow.Run {
	if a.inspections == nil {
		return []workflow.Run{}
	}
	return a.inspections.List()
}

func (a *App) GetAiInspection(id string) (workflow.Run, error) {
	if a.inspections == nil {
		return workflow.Run{}, fmt.Errorf("inspection service unavailable")
	}
	return a.inspections.Get(id)
}

func (a *App) CancelAiInspection(id string) bool {
	return a.inspections != nil && a.inspections.Cancel(id)
}

func (a *App) redactInspection(profileID, text string) string {
	text = a.protectCredentialTexts(text)[0]
	values := map[string]string{}
	if a.secrets != nil {
		if named, err := a.secrets.NamedValues(profileID); err == nil {
			for name, value := range named {
				values[name] = value
			}
		}
		if password, err := a.secrets.GetPassword(profileID); err == nil && password != "" {
			values["sshPassword"] = password
		}
		if passphrase, err := a.secrets.GetPassphrase(profileID); err == nil && passphrase != "" {
			values["keyPassphrase"] = passphrase
		}
	}
	if a.ai != nil {
		if key := a.ai.GetConfig().APIKey; key != "" {
			values["aiKey"] = key
		}
	}
	secrets := make([]string, 0, len(values))
	for _, value := range values {
		secrets = append(secrets, value)
	}
	return logger.RedactKnownSecrets(text, secrets)
}

func (a *App) executeInspectionQuery(parent context.Context, sessionID string, query workflow.Query) workflow.Evidence {
	evidence := workflow.Evidence{Status: "unavailable", RemoteState: "not_started"}
	command, err := workflow.Command(query)
	if err != nil {
		evidence.Error = err.Error()
		return evidence
	}
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		evidence.Error = err.Error()
		return evidence
	}
	// Send only backend-owned scripts through stdin; model strings are limited
	// to service identifiers validated by workflow.Command.
	script := "PATH=/usr/sbin:/usr/bin:/sbin:/bin\nexport PATH\nLC_ALL=C\nexport LC_ALL\n" + command + "\n"
	activityID := a.beginTerminalAutomation(sessionID, "ai", "host_inspection", command)
	info, _ := a.ssh.Get(sessionID)
	result, execErr := a.ssh.ExecuteCommandResultStream(ctx, sessionID, "sh -s", &script, 20*time.Second, 8192, nil)
	output := a.redactInspection(info.ProfileID, result.DisplayOutput())
	evidence.Output = output
	evidence.ExitCode = result.ExitCode
	evidence.Truncated = result.Truncated
	evidence.RemoteState = cliRemoteState(result, execErr)
	if query.Check == "connectivity" && execErr == nil && (result.ExitCode == 0 || result.ExitCode == 1) && strings.Contains(output, "GXSHELL_TCP=") {
		evidence.Status = "collected"
	} else if execErr != nil {
		evidence.Error = execErr.Error()
	} else if result.Error != "" {
		evidence.Error = result.Error
	} else if result.ExitCode != 0 {
		evidence.Error = fmt.Sprintf("remote exit code %d", result.ExitCode)
	} else {
		evidence.Status = "collected"
		if strings.TrimSpace(output) == "" {
			evidence.Output = "(no output)"
		}
	}
	a.finishTerminalAutomation(sessionID, activityID, "ai", "host_inspection", output, evidence.Error, result.ExitCode, result.Duration, result.Truncated)
	return evidence
}
