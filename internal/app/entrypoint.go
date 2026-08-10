package app

import "context"

// This file is the seam between the root Wails entry point (package main) and
// the application implementation, which lives here so the repository root stays
// readable.
//
// Everything below is a PACKAGE-LEVEL FUNCTION on purpose, and that choice is
// load-bearing rather than stylistic. main.go passes *App to wails.Run's Bind
// list, and Wails binds every exported method of a bound struct as a callable
// the webview can invoke by name. Exporting lifecycle plumbing as App methods
// so main.go could reach it would therefore also hand it to the renderer.
//
// That is not hypothetical. HandleSecondInstanceLaunch feeds its arguments to
// allowFile, which is what authorizes a path for ReadLocalFile/WriteLocalFile.
// Bound to the frontend, it lets a compromised renderer authorize any path
// whose extension is in the supported text list -- .env, .json, .conf, .yaml
// among them -- and then read it, or overwrite a .ps1/.bat/.sh/.service file.
// The allowedFileSet doc comment promises exactly the opposite.
//
// Package-level functions are not part of any bound struct, so they stay
// invisible to the webview while remaining callable from main.go.

// Hooks carries the Wails lifecycle callbacks for one App. Fields are plain
// funcs rather than methods so that handing them to options.App never widens
// the bound surface.
type Hooks struct {
	Startup              func(ctx context.Context)
	DomReady             func(ctx context.Context)
	Shutdown             func(ctx context.Context)
	SecondInstanceLaunch func(args []string)
}

// NewHooks returns the lifecycle callbacks for a. Call it once, after any
// SetTrayIcon/SetStartupFilePath, and wire the fields into options.App.
func NewHooks(a *App) Hooks {
	return Hooks{
		Startup:              a.startup,
		DomReady:             a.domReady,
		Shutdown:             a.shutdown,
		SecondInstanceLaunch: a.handleSecondInstanceLaunch,
	}
}

// SetTrayIcon supplies the tray icon bytes. The icon is embedded in main.go
// because //go:embed cannot reference a parent directory, so internal/app
// cannot reach build/windows/icon.ico on its own.
func SetTrayIcon(a *App, icon []byte) {
	a.trayIcon = append([]byte(nil), icon...)
}

// SetStartupFilePath records a document the OS passed on the command line (an
// "Open with" or double-click launch). domReady authorizes and stashes it.
//
// Never expose this to the frontend: it is an input to the allowFile decision
// in domReady, and a renderer that could set it would be choosing what the app
// treats as a genuine user file choice.
func SetStartupFilePath(a *App, path string) {
	a.startupFilePath = path
}

// SetupSystemTray starts the platform tray integration. On darwin the
// underlying implementation is a no-op; see systray_darwin.go.
func SetupSystemTray(a *App) {
	a.setupSystemTray()
}
