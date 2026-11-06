package app

import (
	"context"
	"strconv"
	"strings"

	"gxShell/backend/ai"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// confirmInspection asks through the in-app approval panel, the same review
// surface as AI and CLI commands. The native dialog is only the fallback for a
// renderer that has not registered yet, as everywhere else.
func (a *App) confirmInspection(title, nativeMessage string, req cliApprovalPanelRequest) bool {
	if result, ok := a.requestCliApprovalPanel(context.Background(), req); ok {
		// A boolean confirmation authorizes the entire operation. Partial or
		// invented selections must never authorize unchecked batch items.
		for _, approved := range result.mask(req.Items) {
			if !approved {
				return false
			}
		}
		return len(req.Items) > 0
	}
	ctx := a.ctx.Get()
	if ctx == nil {
		return false
	}
	a.nativeDialogMu.Lock()
	answer, err := runtime.MessageDialog(ctx, runtime.MessageDialogOptions{Type: runtime.QuestionDialog, Title: title, Message: nativeMessage, DefaultButton: "No"})
	a.nativeDialogMu.Unlock()
	return err == nil && answer == "Yes"
}

// inspectionConsentKey identifies what a read-only confirmation agreed to: the
// saved server, the workflow, where the evidence goes, and the host background
// sent with it. Changing any of them asks again. Quick-connect sessions have no
// stable identity, so they are always asked.
func (a *App) inspectionConsentKey(profileID, workflow string, cfg ai.Config) string {
	if profileID == "" || a.inspections == nil {
		return ""
	}
	return strings.Join([]string{profileID, workflow, string(cfg.Provider), cfg.Model, strings.TrimRight(cfg.Endpoint, "/"),
		strconv.FormatUint(a.inspections.DossierRevision(profileID), 10)}, "\x00")
}

func (a *App) inspectionConsented(key string) bool {
	if key == "" {
		return false
	}
	_, ok := a.inspectionConsent.Load(key)
	return ok
}

func (a *App) rememberInspectionConsent(key string) {
	if key != "" {
		a.inspectionConsent.Store(key, struct{}{})
	}
}
