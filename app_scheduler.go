package main

import "gxShell/backend/types"

func (a *App) ListCronJobs(sessionID string) ([]types.CronJob, error) {
	return a.scheduler.List(sessionID)
}

func (a *App) SaveCronJob(sessionID, id, schedule, command string, enabled bool) error {
	return a.scheduler.Save(sessionID, id, schedule, command, enabled)
}

func (a *App) DeleteCronJob(sessionID, id string) error {
	return a.scheduler.Delete(sessionID, id)
}

func (a *App) SetCronJobEnabled(sessionID, id string, enabled bool) error {
	return a.scheduler.SetEnabled(sessionID, id, enabled)
}

func (a *App) RunCronJob(sessionID, id string) (string, error) {
	return a.scheduler.Run(sessionID, id)
}
