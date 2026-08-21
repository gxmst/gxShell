package app

import (
	"fmt"
	"strings"
	"time"

	"gxShell/backend/types"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	terminalAutomationEchoLimit     = 256 * 1024
	terminalAutomationEnvelopeLimit = 512
	terminalAutomationEnvelopeTTL   = 6 * time.Hour
)

type terminalAutomationEnvelope struct {
	SessionID  string
	RuntimeID  string
	Generation uint64
	CreatedAt  time.Time
}

// terminalAutomationEvent mirrors commands executed through a separate SSH
// exec channel into the visible terminal display. It is deliberately a UI
// event: it never writes the command back into the interactive remote shell.
type terminalAutomationEvent struct {
	SessionID  string `json:"sessionId"`
	RuntimeID  string `json:"runtimeId,omitempty"`
	Generation uint64 `json:"generation,omitempty"`
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
	RiskTier   string `json:"riskTier,omitempty"`
	RiskLabel  string `json:"riskLabel,omitempty"`
	Approval   string `json:"approval,omitempty"`
	// runtimePinned prevents a completion event whose session has disappeared
	// from being rebound to a newer transport generation by the best-effort
	// fallback in emitTerminalAutomation.
	runtimePinned bool
}

func (a *App) emitTerminalAutomation(event terminalAutomationEvent) {
	if event.SessionID == "" || event.ActivityID == "" {
		return
	}
	// Direct callers still get a best-effort envelope. The normal lifecycle
	// resolves and caches at begin time, because the session may be gone by the
	// time its completed/failed event is emitted.
	if event.RuntimeID == "" {
		if !event.runtimePinned {
			event.RuntimeID, event.Generation, _ = a.resolveTerminalAutomationRuntime(event.SessionID)
		}
	}
	if a.automationEventFn != nil {
		a.automationEventFn(event)
		return
	}
	if ctx := a.ctx.Get(); ctx != nil {
		runtime.EventsEmit(ctx, "terminal:automation", event)
	}
}

func (a *App) resolveTerminalAutomationRuntime(sessionID string) (string, uint64, bool) {
	if sessionID == "" {
		return "", 0, false
	}
	if a.automationRuntimeFn != nil {
		return a.automationRuntimeFn(sessionID)
	}
	if a.ssh == nil {
		return "", 0, false
	}
	info, err := a.ssh.Get(sessionID)
	if err != nil || info.RuntimeID == "" || info.Generation == 0 {
		return "", 0, false
	}
	return info.RuntimeID, info.Generation, true
}

func (a *App) rememberTerminalAutomationEnvelope(activityID string, envelope terminalAutomationEnvelope) {
	if activityID == "" {
		return
	}
	now := time.Now()
	envelope.CreatedAt = now
	a.automationMu.Lock()
	defer a.automationMu.Unlock()
	if a.automationEnvelopes == nil {
		a.automationEnvelopes = make(map[string]terminalAutomationEnvelope)
	}
	for id, item := range a.automationEnvelopes {
		if now.Sub(item.CreatedAt) > terminalAutomationEnvelopeTTL {
			delete(a.automationEnvelopes, id)
		}
	}
	for len(a.automationEnvelopes) >= terminalAutomationEnvelopeLimit {
		oldestID := ""
		var oldest time.Time
		for id, item := range a.automationEnvelopes {
			if oldestID == "" || item.CreatedAt.Before(oldest) {
				oldestID = id
				oldest = item.CreatedAt
			}
		}
		if oldestID == "" {
			break
		}
		delete(a.automationEnvelopes, oldestID)
	}
	a.automationEnvelopes[activityID] = envelope
}

func (a *App) takeTerminalAutomationEnvelope(activityID string) (terminalAutomationEnvelope, bool) {
	if activityID == "" {
		return terminalAutomationEnvelope{}, false
	}
	now := time.Now()
	a.automationMu.Lock()
	defer a.automationMu.Unlock()
	envelope, ok := a.automationEnvelopes[activityID]
	delete(a.automationEnvelopes, activityID)
	if !ok || now.Sub(envelope.CreatedAt) > terminalAutomationEnvelopeTTL {
		return terminalAutomationEnvelope{}, false
	}
	return envelope, true
}

func (a *App) beginTerminalAutomation(sessionID, source, tool, command string) string {
	return a.beginTerminalAutomationDetails(sessionID, source, tool, command, "", "", "")
}

func (a *App) beginTerminalAutomationWithRisk(sessionID, source, tool, command string, assessment riskAssessment, approval string) string {
	return a.beginTerminalAutomationDetails(sessionID, source, tool, command, assessment.Tier.String(), assessment.Tier.Label(), approval)
}

func (a *App) beginTerminalAutomationDetails(sessionID, source, tool, command, riskTier, riskLabel, approval string) string {
	activityID := types.NewID(source)
	runtimeID, generation, _ := a.resolveTerminalAutomationRuntime(sessionID)
	a.rememberTerminalAutomationEnvelope(activityID, terminalAutomationEnvelope{
		SessionID: sessionID, RuntimeID: runtimeID, Generation: generation,
	})
	a.emitTerminalAutomation(terminalAutomationEvent{
		SessionID:     sessionID,
		RuntimeID:     runtimeID,
		Generation:    generation,
		ActivityID:    activityID,
		Source:        source,
		Phase:         "started",
		Tool:          tool,
		Command:       command,
		RiskTier:      riskTier,
		RiskLabel:     riskLabel,
		Approval:      approval,
		runtimePinned: true,
	})
	return activityID
}

func (a *App) finishTerminalAutomation(sessionID, activityID, source, tool, output, errorText string, exitCode int, duration time.Duration, truncated bool) {
	output, echoTruncated := limitTerminalAutomationOutput(output)
	phase := "completed"
	if errorText != "" || exitCode != 0 {
		phase = "failed"
	}
	runtimeID := ""
	var generation uint64
	// Pin only when the begin-time envelope is still there. If it was dropped by
	// the size cap or the TTL, we know nothing about the original transport, so
	// a best-effort resolve is strictly better than emitting an event with no
	// runtime identity at all — an unfenceable event is worse than one fenced
	// against a possibly newer generation.
	pinned := false
	if envelope, ok := a.takeTerminalAutomationEnvelope(activityID); ok {
		if envelope.SessionID != "" {
			sessionID = envelope.SessionID
		}
		runtimeID = envelope.RuntimeID
		generation = envelope.Generation
		pinned = true
	}
	a.emitTerminalAutomation(terminalAutomationEvent{
		SessionID:     sessionID,
		RuntimeID:     runtimeID,
		Generation:    generation,
		ActivityID:    activityID,
		Source:        source,
		Phase:         phase,
		Tool:          tool,
		Output:        output,
		Error:         errorText,
		ExitCode:      exitCode,
		DurationMs:    duration.Milliseconds(),
		Truncated:     truncated || echoTruncated,
		runtimePinned: pinned,
	})
}

func limitTerminalAutomationOutput(output string) (string, bool) {
	if len(output) <= terminalAutomationEchoLimit {
		return output, false
	}
	trimmed := strings.ToValidUTF8(output[:terminalAutomationEchoLimit], "�")
	return trimmed + fmt.Sprintf("\n(terminal echo truncated after %d KiB)", terminalAutomationEchoLimit/1024), true
}
