package main

import (
	"gxShell/backend/logger"
	"gxShell/backend/types"
)

func (a *App) ListCronJobs(sessionID string) ([]types.CronJob, error) {
	return a.scheduler.List(sessionID)
}

func (a *App) SaveCronJob(sessionID, id, schedule, command string, enabled bool) error {
	target := id
	if target == "" {
		target = "new-job"
	}
	return a.auditSimpleGUIChange("cron.save", target, sessionID, logger.LogFields{"enabled": enabled, "schedule": schedule}, func() error {
		return a.scheduler.Save(sessionID, id, schedule, command, enabled)
	})
}

func (a *App) DeleteCronJob(sessionID, id string) error {
	return a.auditSimpleGUIChange("cron.delete", id, sessionID, nil, func() error {
		return a.scheduler.Delete(sessionID, id)
	})
}

func (a *App) SetCronJobEnabled(sessionID, id string, enabled bool) error {
	return a.auditSimpleGUIChange("cron.set-enabled", id, sessionID, logger.LogFields{"enabled": enabled}, func() error {
		return a.scheduler.SetEnabled(sessionID, id, enabled)
	})
}

func (a *App) RunCronJob(sessionID, id string) (string, error) {
	audit := a.beginChangeAudit("cron.run", id, sessionID, nil)
	out, err := a.scheduler.Run(sessionID, id)
	audit.finish(err, err == nil, "")
	return out, err
}
