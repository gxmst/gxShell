package main

import (
	_ "embed"
	"github.com/getlantern/systray"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed build/windows/icon.ico
var trayIcon []byte

// setupSystemTray initializes the system tray
func (a *App) setupSystemTray() {
	go systray.Run(a.onTrayReady, a.onTrayExit)
}

// onTrayReady is called when the system tray is ready
func (a *App) onTrayReady() {
	systray.SetIcon(trayIcon)
	systray.SetTitle("gxShell")
	systray.SetTooltip("gxShell - SSH Client")

	// Create menu items
	mShow := systray.AddMenuItem("Show Window", "Show the main window")
	systray.AddSeparator()
	mNewConnection := systray.AddMenuItem("New SSH Connection", "Create a new SSH connection")
	mOpenMarkdown := systray.AddMenuItem("Open Markdown", "Open a markdown file")
	systray.AddSeparator()
	mSettings := systray.AddMenuItem("Settings", "Open settings")
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("Quit", "Quit the application")

	// Handle menu clicks
	go func() {
		for {
			select {
			case <-mShow.ClickedCh:
				if a.ctx != nil {
					runtime.WindowShow(a.ctx)
					runtime.WindowUnminimise(a.ctx)
				}
			case <-mNewConnection.ClickedCh:
				if a.ctx != nil {
					runtime.WindowShow(a.ctx)
					runtime.WindowUnminimise(a.ctx)
					runtime.EventsEmit(a.ctx, "tray:new-connection")
				}
			case <-mOpenMarkdown.ClickedCh:
				if a.ctx != nil {
					runtime.WindowShow(a.ctx)
					runtime.WindowUnminimise(a.ctx)
					runtime.EventsEmit(a.ctx, "tray:open-markdown")
				}
			case <-mSettings.ClickedCh:
				if a.ctx != nil {
					runtime.WindowShow(a.ctx)
					runtime.WindowUnminimise(a.ctx)
					runtime.EventsEmit(a.ctx, "tray:settings")
				}
			case <-mQuit.ClickedCh:
				systray.Quit()
				if a.ctx != nil {
					runtime.Quit(a.ctx)
				}
				return
			}
		}
	}()
}

// onTrayExit is called when the system tray is exiting
func (a *App) onTrayExit() {
	// Cleanup
}
