package app

// terminalEventEnvelope returns the common fields used by every event tied to
// a terminal transport. sessionId remains the routing key; runtimeId and
// generation let the renderer reject late events after a reconnect.
func (a *App) terminalEventEnvelope(sessionID string) map[string]any {
	fields := map[string]any{"sessionId": sessionID}
	if sessionID == "" || a.ssh == nil {
		return fields
	}
	if info, err := a.ssh.Get(sessionID); err == nil {
		fields["runtimeId"] = info.RuntimeID
		fields["generation"] = info.Generation
		fields["state"] = info.State
	}
	return fields
}
