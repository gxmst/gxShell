package main

import (
	"fmt"
	"strings"
	"time"

	"gxShell/backend/types"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const terminalAutomationEchoLimit = 256 * 1024

// terminalAutomationEvent mirrors commands executed through a separate SSH
// exec channel into the visible terminal display. It is deliberately a UI
// event: it never writes the command back into the interactive remote shell.
type terminalAutomationEvent struct {
	SessionID  string `json:"sessionId"`
	ActivityID string `json:"activityId"`
	Source     string `json:"source"`
	Phase      string `json:"phase"`
	Tool       string `json:"tool,omitempty"`
	Command    string `json:"command,omitempty"`
	Output     string `json:"output,omitempty"`
	Error      string `json:"error,omitempty"`
	ExitCode   int    `json:"exitCode,omitempty"`
	DurationMs int64  `json:"durationMs,omitempty"`
	Truncated  bool   `json:"truncated,omitempty"`
}

func (a *App) emitTerminalAutomation(event terminalAutomationEvent) {
	if event.SessionID == "" || event.ActivityID == "" {
		return
	}
	if a.automationEventFn != nil {
		a.automationEventFn(event)
		return
	}
	if a.ctx != nil {
		runtime.EventsEmit(a.ctx, "terminal:automation", event)
	}
}

func (a *App) beginTerminalAutomation(sessionID, source, tool, command string) string {
	activityID := types.NewID(source)
	a.emitTerminalAutomation(terminalAutomationEvent{
		SessionID:  sessionID,
		ActivityID: activityID,
		Source:     source,
		Phase:      "started",
		Tool:       tool,
		Command:    command,
	})
	return activityID
}

func (a *App) finishTerminalAutomation(sessionID, activityID, source, tool, output, errorText string, exitCode int, duration time.Duration, truncated bool) {
	output, echoTruncated := limitTerminalAutomationOutput(output)
	phase := "completed"
	if errorText != "" || exitCode != 0 {
		phase = "failed"
	}
	a.emitTerminalAutomation(terminalAutomationEvent{
		SessionID:  sessionID,
		ActivityID: activityID,
		Source:     source,
		Phase:      phase,
		Tool:       tool,
		Output:     output,
		Error:      errorText,
		ExitCode:   exitCode,
		DurationMs: duration.Milliseconds(),
		Truncated:  truncated || echoTruncated,
	})
}

func limitTerminalAutomationOutput(output string) (string, bool) {
	if len(output) <= terminalAutomationEchoLimit {
		return output, false
	}
	trimmed := strings.ToValidUTF8(output[:terminalAutomationEchoLimit], "�")
	return trimmed + fmt.Sprintf("\n(terminal echo truncated after %d KiB)", terminalAutomationEchoLimit/1024), true
}
