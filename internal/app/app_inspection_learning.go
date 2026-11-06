package app

import (
	"fmt"
	"os"
	"os/user"
	"strings"

	"gxShell/backend/ai"
	"gxShell/backend/i18n"
	"gxShell/backend/types"
	"gxShell/backend/workflow"
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
	if a.inspections == nil {
		return workflow.EvaluationCases(a.uiLanguage())
	}
	return a.inspections.AllEvaluationCases(a.uiLanguage())
}
func (a *App) SaveAiInspectionCase(runID, title string, expected map[string]string) (workflow.SavedCase, error) {
	if a.inspections == nil {
		return workflow.SavedCase{}, fmt.Errorf("inspection service unavailable")
	}
	return a.inspections.SaveCase(runID, title, expected, localInspectionReviewer())
}
func (a *App) DeleteAiInspectionCase(id string) error {
	if a.inspections == nil {
		return fmt.Errorf("inspection service unavailable")
	}
	return a.inspections.DeleteCase(id)
}
func (a *App) ListAiInspectionEvaluations() []workflow.EvaluationRun {
	if a.inspections == nil {
		return []workflow.EvaluationRun{}
	}
	return a.inspections.ListEvaluations()
}
func (a *App) GetAiInspectionStats() []workflow.ModelStats {
	if a.inspections == nil {
		return []workflow.ModelStats{}
	}
	return a.inspections.Stats()
}
func (a *App) StartAiInspectionEvaluation(caseIDs []string) (workflow.EvaluationRun, error) {
	if a.inspections == nil || a.ai == nil || a.ctx.Get() == nil {
		return workflow.EvaluationRun{}, fmt.Errorf("inspection service unavailable")
	}
	cfg := a.ai.GetConfig()
	if !a.confirmSavedCaseEvaluation(caseIDs, cfg) {
		return workflow.EvaluationRun{}, fmt.Errorf("%s", i18n.Text(workflow.NormalizeLanguage(a.uiLanguage()), "已取消评测。", "Evaluation cancelled."))
	}
	return a.inspections.StartEvaluation(a.ctx.Get(), cfg, a.uiLanguage(), caseIDs)
}

// Saved cases hold redacted evidence from real servers, and the current model
// may differ from the one the user originally allowed, so sending them is
// confirmed every time. Fixed fixtures are simulated and need no prompt.
func (a *App) confirmSavedCaseEvaluation(caseIDs []string, cfg ai.Config) bool {
	l := workflow.NormalizeLanguage(a.uiLanguage())
	items := []cliApprovalItem{}
	for _, c := range a.inspections.AllEvaluationCases(l) {
		for _, id := range caseIDs {
			if c.Saved && c.ID == id {
				items = append(items, cliApprovalItem{ID: c.ID, Kind: "inspection", Text: c.Title + " · " + c.Target, RiskTier: "T0"})
			}
		}
	}
	if len(items) == 0 {
		return true
	}
	message := fmt.Sprintf(i18n.Text(l, "评测会把以下保存用例中已脱敏的真实服务器证据发送给 %s / %s（%s）。不连接服务器，不执行命令。", "Evaluation sends the redacted real-server evidence in these saved cases to %s / %s (%s). No server is contacted and no command runs."),
		cfg.Provider, cfg.Model, strings.TrimRight(cfg.Endpoint, "/"))
	for _, item := range items {
		message += "\n- " + item.Text
	}
	message += i18n.Text(l, "\n\n这批保存用例须全部允许；取消任一项则不开始评测。可返回评测界面重新选择用例。", "\n\nAll saved cases in this batch must be approved; unchecking any cancels the evaluation. Return to the evaluation screen to change the selected cases.")
	return a.confirmInspection(i18n.Text(l, "确认评测保存的用例", "Confirm saved-case evaluation"), message, cliApprovalPanelRequest{Source: "ai", Server: "gxShell", Summary: message, Items: items})
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
	// A follow-up sends the same class of data as the read-only diagnosis it
	// continues, so it shares that diagnosis's remembered confirmation.
	consent := a.inspectionConsentKey(source.ProfileID, source.Workflow, cfg)
	if !a.inspectionConsented(consent) {
		approved := a.confirmInspection(i18n.Text(language, "继续分析报告", "Continue report analysis"), message, cliApprovalPanelRequest{
			Source: "ai", Server: source.Target, Summary: message,
			Items: []cliApprovalItem{{ID: "followup", Kind: "inspection", Text: a.redactInspection(source.ProfileID, question), RiskTier: "T0"}},
		})
		if !approved {
			return workflow.Run{}, fmt.Errorf("%s", i18n.Text(language, "已取消追问。", "Follow-up cancelled."))
		}
		a.rememberInspectionConsent(consent)
	}
	current, err := a.ssh.Get(source.SessionID)
	if err != nil || current.State != types.SessionConnected || current.ProfileID != info.ProfileID || current.Generation != info.Generation {
		return workflow.Run{}, fmt.Errorf("SSH target changed")
	}
	return a.inspections.StartFollowup(a.ctx.Get(), id, language, cfg, question, focusEvidenceID)
}
