package app

import (
	"time"

	"gxShell/backend/logger"
)

// changeAudit records durable GUI mutation outcomes without making successful,
// low-frequency operations unnecessarily noisy. Success is one completion
// record. Failure or verification failure gets an additional requested record
// carrying the original start time, which preserves intent for incident review.
type changeAudit struct {
	app       *App
	startedAt time.Time
	fields    logger.LogFields
}

func (a *App) beginChangeAudit(operation, target, sessionID string, extra logger.LogFields) *changeAudit {
	fields := logger.LogFields{
		"source":    "gui",
		"operation": operation,
		"target":    target,
		"sessionID": sessionID,
	}
	for key, value := range extra {
		fields[key] = value
	}
	return &changeAudit{app: a, startedAt: time.Now(), fields: fields}
}

func (audit *changeAudit) finish(err error, verified bool, verification string) {
	if audit == nil || audit.app == nil || audit.app.log == nil {
		return
	}
	fields := cloneLogFields(audit.fields)
	fields["phase"] = "completed"
	fields["durationMs"] = time.Since(audit.startedAt).Milliseconds()
	outcome := "success"
	if err != nil {
		outcome = "failed"
		fields["error"] = err.Error()
	} else if !verified {
		outcome = "verification_failed"
	}
	fields["outcome"] = outcome
	if verification != "" {
		fields["verification"] = verification
	}
	if outcome != "success" {
		requested := cloneLogFields(audit.fields)
		requested["phase"] = "requested"
		requested["startedAt"] = audit.startedAt.UTC().Format(time.RFC3339Nano)
		audit.app.log.InfoFields("GUI change requested", requested)
		audit.app.log.ErrorFields("GUI change did not verify", fields)
		return
	}
	audit.app.log.InfoFields("GUI change completed", fields)
}

func cloneLogFields(fields logger.LogFields) logger.LogFields {
	cloned := make(logger.LogFields, len(fields))
	for key, value := range fields {
		cloned[key] = value
	}
	return cloned
}

func (a *App) auditSimpleGUIChange(operation, target, sessionID string, extra logger.LogFields, change func() error) error {
	audit := a.beginChangeAudit(operation, target, sessionID, extra)
	err := change()
	audit.finish(err, err == nil, "")
	return err
}
