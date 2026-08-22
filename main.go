package main

import (
	"embed"
	"fmt"
	"os"

	"gxShell/internal/app"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/windows/icon.ico
var trayIcon []byte

func main() {
	// Create an instance of the app structure
	a := app.NewApp()
	app.SetTrayIcon(a, trayIcon)

	// Check command line arguments
	if len(os.Args) > 1 {
		app.SetStartupFilePath(a, os.Args[1])
	}

	// Initialize system tray
	app.SetupSystemTray(a)

	// Lifecycle callbacks come from a package-level seam rather than exported
	// App methods: Wails binds every exported method of a bound struct, so
	// exporting these would also expose them to the webview. See
	// internal/app/entrypoint.go.
	hooks := app.NewHooks(a)

	// Create application with options
	err := wails.Run(&options.App{
		Title:     "gxShell",
		Width:     1180,
		Height:    760,
		MinWidth:  900,
		MinHeight: 620,
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: app.DocumentAssetHandler(a),
		},
		// BackgroundColour must match the default theme's --bg (#0e1217). The
		// native window background shows during startup and when resize reveals
		// untracked regions; a colour that belongs to no theme flashes as a
		// foreign band. SetWindowBackgroundColour keeps it in sync once the
		// frontend is up and the active theme is known.
		BackgroundColour: &options.RGBA{R: 14, G: 18, B: 23, A: 1},
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop: true,
		},
		OnStartup:     hooks.Startup,
		OnDomReady:    hooks.DomReady,
		OnBeforeClose: hooks.BeforeClose,
		OnShutdown:    hooks.Shutdown,
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "gxshell-2f6c1d8a-single-instance",
			OnSecondInstanceLaunch: func(data options.SecondInstanceData) {
				hooks.SecondInstanceLaunch(data.Args)
			},
		},
		// Frameless: the app draws its own top bar (AppTopBar) so one strip
		// spans the window instead of a native caption plus two app-level
		// chrome bands. Drag regions and window buttons live in the frontend;
		// see internal/app/app_window.go for the bound controls.
		Frameless: true,
		Bind: []interface{}{
			a,
		},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			DisableWindowIcon:    false,
		},
	})

	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err.Error())
		os.Exit(1)
	}
}
