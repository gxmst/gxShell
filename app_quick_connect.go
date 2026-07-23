package main

import (
	"errors"
	"strings"

	"gxShell/backend/config"
	"gxShell/backend/types"
)

// ConnectQuick opens an in-memory SSH profile. It is deliberately not written
// to profiles.json: the renderer keeps the connection details only for the
// lifetime of the tab, while the backend session works like any other SSH tab.
func (a *App) ConnectQuick(profile types.Profile, cols int, rows int) (types.SessionInfo, error) {
	profile.Host = strings.TrimSpace(profile.Host)
	profile.Username = strings.TrimSpace(profile.Username)
	if profile.Host == "" {
		return types.SessionInfo{}, errors.New("host is required")
	}
	if profile.Username == "" {
		return types.SessionInfo{}, errors.New("username is required")
	}
	normalizeProfile(&profile)
	if profile.Port < 1 || profile.Port > 65535 {
		return types.SessionInfo{}, errors.New("port must be between 1 and 65535")
	}
	if profile.AuthType == types.AuthPrivateKey && strings.TrimSpace(profile.PrivateKeyPath) == "" {
		return types.SessionInfo{}, errors.New("private key path is required")
	}
	if !strings.HasPrefix(profile.ID, "quick-") {
		profile.ID = types.NewID("quick")
	}
	profile.ProxyJumpID = ""
	profile.RememberPassword = false
	defer func() {
		profile.Password = ""
		profile.PrivateKeyPassphrase = ""
	}()

	rateKey := "quick:" + strings.ToLower(profile.Username+"@"+profile.Host)
	if err := a.rateLimiter.CheckAndRecord(rateKey); err != nil {
		return types.SessionInfo{}, err
	}
	settings, err := a.store.GetSettings()
	if err != nil {
		settings = config.DefaultSettings()
	}
	defaults := config.DefaultSettings()
	if settings.ConnectionTimeout <= 0 {
		settings.ConnectionTimeout = defaults.ConnectionTimeout
	}
	if settings.MonitorIntervalSec <= 0 {
		settings.MonitorIntervalSec = defaults.MonitorIntervalSec
	}

	info, err := a.ssh.Connect(profile, settings.ConnectionTimeout, cols, rows)
	if err != nil {
		if a.log != nil {
			a.log.Error("quick connect failed: " + err.Error())
		}
		return info, err
	}
	a.rateLimiter.Reset(rateKey)
	if settings.MonitorEnabled {
		a.monitor.Start(info.ID, settings.MonitorIntervalSec)
	}
	return info, nil
}
