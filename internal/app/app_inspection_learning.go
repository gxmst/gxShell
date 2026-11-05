package app

import (
	"fmt"
	"os"
	"os/user"
	"strings"

	"gxShell/backend/i18n"
	"gxShell/backend/types"
	"gxShell/backend/workflow"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func localInspectionReviewer() string {
	if account, err := user.Current(); err == nil && account.Username != "" {
		return account.Username
	}
	if reviewer := os.Getenv("USERNAME"); reviewer != "" {
		return reviewer
	}
	return "local user"
}
func (a *App) GetAiHostDossier(profileID string) (workflow.HostDossier, error) {
	if a.inspections == nil || a.store == nil {
		return workflow.HostDossier{}, fmt.Errorf("inspection service unavailable")
	}
	if _, err := a.GetProfile(profileID); err != nil {
		return workflow.HostDossier{}, err
	}
	return a.inspections.GetDossier(profileID)
}
func (a *App) SaveAiHostDossier(profileID string, input workflow.DossierInput) (workflow.HostDossier, error) {
	if _, err := a.GetAiHostDossier(profileID); err != nil {
		return workflow.HostDossier{}, err
	}
	return a.inspections.SaveDossier(profileID, input, localInspectionReviewer(), false)
}
func (a *App) DeleteAiHostDossier(profileID string, revision uint64) (workflow.HostDossier, error) {
	if _, err := a.GetAiHostDossier(profileID); err != nil {
		return workflow.HostDossier{}, err
	}
	return a.inspections.SaveDossier(profileID, workflow.DossierInput{Revision: revision, ContainerRuntime: "unknown"}, localInspectionReviewer(), true)
}
func (a *App) FeedbackAiInspection(id, outcome, note string) (workflow.Run, error) {
	if a.inspections == nil {
		return workflow.Run{}, fmt.Errorf("inspection service unavailable")
	}
	return a.inspections.FeedbackReport(id, outcome, note, localInspectionReviewer())
}
func (a *App) ListAiInspectionEvaluationCases() []workflow.EvaluationCase {
	return workflow.EvaluationCases(a.uiLanguage())
}
func (a *App) ListAiInspectionEvaluations() []workflow.EvaluationRun {
	if a.inspections == nil {
		return []workflow.EvaluationRun{}
	}
	return a.inspections.ListEvaluations()
}
func (a *App) StartAiInspectionEvaluation(caseIDs []string) (workflow.EvaluationRun, error) {
	if a.inspections == nil || a.ai == nil || a.ctx.Get() == nil {
		return workflow.EvaluationRun{}, fmt.Errorf("inspection service unavailable")
	}
	return a.inspections.StartEvaluation(a.ctx.Get(), a.ai.GetConfig(), a.uiLanguage(), caseIDs)
}
func (a *App) CancelAiInspectionEvaluation(id string) bool {
	return a.inspections != nil && a.inspections.CancelEvaluation(id)
}
func (a *App) StartAiInspectionFollowup(id, question, focusEvidenceID string) (workflow.Run, error) {
	source, err := a.GetAiInspection(id)
	if err != nil {
		return workflow.Run{}, err
	}
	language := workflow.NormalizeLanguage(a.uiLanguage())
	if !workflow.Terminal(source.State) || strings.TrimSpace(question) == "" || len(question) > 2000 {
		return workflow.Run{}, fmt.Errorf("%s", i18n.Text(language, "请在已完成报告上输入有效的追问。", "Enter a valid follow-up on a finished report."))
	}
	if a.ssh == nil || a.ai == nil || a.ctx.Get() == nil {
		return workflow.Run{}, fmt.Errorf("application unavailable")
	}
	info, err := a.ssh.Get(source.SessionID)
	if err != nil || info.State != types.SessionConnected || info.ProfileID != source.ProfileID {
		return workflow.Run{}, fmt.Errorf("%s", i18n.Text(language, "原 SSH 连接已失效，请重新连接并生成报告。", "The original SSH session is unavailable; reconnect and generate a fresh report."))
	}
	cfg := a.ai.GetConfig()
	if cfg.Model == "" {
		return workflow.Run{}, fmt.Errorf("configure an AI model")
	}
	message := fmt.Sprintf(i18n.Text(language, "主机：%s\n\n将原报告证据、您的追问及主机背景发送给模型 %s。模型最多可进行三轮预定义的只读补查；历史证据会标注采集时间，原报告保留。\n\n追问：%s\n\n是否继续？", "Host: %s\n\nSend the original evidence, your question and host background to model %s. It may request up to three rounds of predefined read-only queries. Historical evidence retains its timestamp and the original report is preserved.\n\nQuestion: %s\n\nContinue?"), source.Target, cfg.Model, a.redactInspection(source.ProfileID, question))
	a.nativeDialogMu.Lock()
	answer, err := runtime.MessageDialog(a.ctx.Get(), runtime.MessageDialogOptions{Type: runtime.QuestionDialog, Title: i18n.Text(language, "继续分析报告", "Continue report analysis"), Message: message, DefaultButton: "No"})
	a.nativeDialogMu.Unlock()
	if err != nil {
		return workflow.Run{}, err
	}
	if answer != "Yes" {
		return workflow.Run{}, fmt.Errorf("%s", i18n.Text(language, "已取消追问。", "Follow-up cancelled."))
	}
	current, err := a.ssh.Get(source.SessionID)
	if err != nil || current.State != types.SessionConnected || current.ProfileID != info.ProfileID || current.Generation != info.Generation {
		return workflow.Run{}, fmt.Errorf("SSH target changed")
	}
	return a.inspections.StartFollowup(a.ctx.Get(), id, language, cfg, question, focusEvidenceID)
}
