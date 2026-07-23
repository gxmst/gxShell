package main

import "gxShell/backend/types"

func (a *App) GetWebsiteStatus(sessionID string) (types.WebsiteStatus, error) {
	return a.websites.Status(sessionID)
}

func (a *App) GetWebsiteConfig(sessionID, backend, mode, name string) (string, error) {
	return a.websites.Config(sessionID, backend, mode, name)
}

func (a *App) SaveWebsiteConfig(sessionID, backend, mode, name, config string) error {
	return a.websites.Save(sessionID, backend, mode, name, config)
}

func (a *App) SetWebsiteEnabled(sessionID, backend, mode, name string, enabled bool) error {
	return a.websites.SetEnabled(sessionID, backend, mode, name, enabled)
}

func (a *App) DeleteWebsite(sessionID, backend, mode, name string) error {
	return a.websites.Delete(sessionID, backend, mode, name)
}

func (a *App) TestWebsiteConfig(sessionID, backend string) (string, error) {
	return a.websites.Test(sessionID, backend)
}
