package main

import (
	"gxShell/backend/logger"
	"gxShell/backend/types"
)

// ListServices returns systemd services on the remote host with their
// enablement state merged in.
func (a *App) ListServices(sessionID string) ([]types.ServiceInfo, error) {
	return a.services.ListServices(sessionID)
}

// ServiceAction runs a systemctl action (start|stop|restart|enable|disable)
// on a unit. Stopping/disabling SSH- or network-critical units requires force.
func (a *App) ServiceAction(sessionID string, unit string, action string, force bool) (types.ServiceActionResult, error) {
	audit := a.beginChangeAudit("service."+action, unit, sessionID, logger.LogFields{"force": force})
	result, err := a.services.ServiceActionVerified(sessionID, unit, action, force)
	audit.finish(err, err == nil && result.Verified, result.Verification)
	return result, err
}

// ServiceLogs retrieves recent journal entries for a unit.
func (a *App) ServiceLogs(sessionID string, unit string, lines int) (string, error) {
	return a.services.ServiceLogs(sessionID, unit, lines)
}

// StreamServiceLogs follows a unit's journal in real-time via service:log events.
func (a *App) StreamServiceLogs(sessionID string, unit string, streamID string, lines int) error {
	return a.services.StreamServiceLogs(sessionID, unit, streamID, lines)
}

// StopServiceLogs stops exactly one journal-follow operation.
func (a *App) StopServiceLogs(streamID string) {
	a.services.StopServiceLogs(streamID)
}
