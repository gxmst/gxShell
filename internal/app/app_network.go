package app

// Network diagnostics (traceroute/ping) and SSH tunnel bindings.

import (
	"gxShell/backend/types"
)

// TraceRoute performs a traceroute to the target server.
func (a *App) TraceRoute(sessionID string) (*types.NetworkPath, error) {
	info, err := a.ssh.Get(sessionID)
	if err != nil {
		return nil, err
	}
	profile, err := a.getProfileForConnect(info.ProfileID)
	if err != nil {
		return nil, err
	}
	return a.net.TraceRoute(profile.Host)
}

// PingHost pings the target server. count is clamped to at most 20 probes so a
// renderer request cannot pin the session in a long measurement loop; a
// non-positive count falls back to the backend default.
func (a *App) PingHost(sessionID string, count int) (*types.NetworkPath, error) {
	if count > 20 {
		count = 20
	}
	client, err := a.ssh.Client(sessionID)
	if err != nil {
		return nil, err
	}
	info, err := a.ssh.Get(sessionID)
	if err != nil {
		return nil, err
	}
	profile, err := a.getProfileForConnect(info.ProfileID)
	if err != nil {
		return nil, err
	}
	return a.net.Ping(client, profile.Host, count)
}

// StartNetworkPing starts continuous ping monitoring.
func (a *App) StartNetworkPing(sessionID string, intervalSec int) error {
	client, err := a.ssh.Client(sessionID)
	if err != nil {
		return err
	}
	info, err := a.ssh.Get(sessionID)
	if err != nil {
		return err
	}
	profile, err := a.getProfileForConnect(info.ProfileID)
	if err != nil {
		return err
	}
	a.net.StartPing(sessionID, client, profile.Host, intervalSec)
	return nil
}

// StopNetworkPing stops continuous ping monitoring.
func (a *App) StopNetworkPing(sessionID string) {
	a.net.StopPing(sessionID)
}

// GetNetworkPath returns cached network path information.
func (a *App) GetNetworkPath(sessionID string) (*types.NetworkPath, error) {
	client, err := a.ssh.Client(sessionID)
	if err != nil {
		return nil, err
	}
	info, err := a.ssh.Get(sessionID)
	if err != nil {
		return nil, err
	}
	profile, err := a.getProfileForConnect(info.ProfileID)
	if err != nil {
		return nil, err
	}
	path := a.net.GetPath(profile.Host)
	if path == nil {
		return a.net.Ping(client, profile.Host, 4)
	}
	return path, nil
}

// ListTunnelStatus returns SSH tunnel status for a session.
func (a *App) ListTunnelStatus(sessionID string) []types.TunnelStatus {
	return a.tunnels.ListStatus(sessionID)
}

// RestartTunnels restarts all SSH tunnels for a session.
func (a *App) RestartTunnels(sessionID string) ([]types.TunnelStatus, error) {
	info, err := a.ssh.Get(sessionID)
	if err != nil {
		return nil, err
	}
	profile, err := a.getProfileForConnect(info.ProfileID)
	if err != nil {
		return nil, err
	}
	client, err := a.ssh.Client(sessionID)
	if err != nil {
		return nil, err
	}
	a.tunnels.StopTunnels(sessionID)
	return a.tunnels.StartTunnels(sessionID, client, profile.Tunnels), nil
}

// AddTunnelRule adds a new SSH tunnel rule and starts it.
func (a *App) AddTunnelRule(sessionID string, rule types.TunnelRule) (types.TunnelStatus, error) {
	info, err := a.ssh.Get(sessionID)
	if err != nil {
		return types.TunnelStatus{}, err
	}
	client, err := a.ssh.Client(sessionID)
	if err != nil {
		return types.TunnelStatus{}, err
	}
	if rule.ID == "" {
		rule.ID = types.NewID("tunnel")
	}
	status := a.tunnels.AddTunnel(sessionID, client, rule)
	if status.Active {
		// The profile read and the update form one read-modify-write cycle on
		// profiles.json, so both run under profilesMu (the network work above
		// stays outside the lock).
		a.profilesMu.Lock()
		profile, perr := a.getProfileForConnect(info.ProfileID)
		if perr == nil {
			profile.Tunnels = append(profile.Tunnels, rule)
			_, _ = a.updateProfileLocked(profile)
		}
		a.profilesMu.Unlock()
	}
	return status, nil
}

// RemoveTunnelRule removes an SSH tunnel rule.
func (a *App) RemoveTunnelRule(sessionID string, ruleID string) error {
	info, err := a.ssh.Get(sessionID)
	if err != nil {
		return err
	}
	a.tunnels.RemoveTunnel(sessionID, ruleID)
	a.profilesMu.Lock()
	profile, perr := a.getProfileForConnect(info.ProfileID)
	if perr == nil {
		for i, r := range profile.Tunnels {
			if r.ID == ruleID {
				profile.Tunnels = append(profile.Tunnels[:i], profile.Tunnels[i+1:]...)
				_, _ = a.updateProfileLocked(profile)
				break
			}
		}
	}
	a.profilesMu.Unlock()
	return nil
}
