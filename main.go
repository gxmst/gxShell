package main

import (
	"embed"
	"fmt"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// Create an instance of the app structure
	app := NewApp()

	// Check command line arguments
	if len(os.Args) > 1 {
		app.startupFilePath = os.Args[1]
	}

	// Initialize system tray
	app.setupSystemTray()

	// Create application with options
	err := wails.Run(&options.App{
		Title:     "gxShell",
		Width:     1180,
		Height:    760,
		MinWidth:  900,
		MinHeight: 620,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop: true,
		},
		OnStartup:  app.startup,
		OnDomReady: app.domReady,
		OnShutdown: app.shutdown,
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "gxshell-2f6c1d8a-single-instance",
			OnSecondInstanceLaunch: func(data options.SecondInstanceData) {
				app.handleSecondInstanceLaunch(data.Args)
			},
		},
		Bind: []interface{}{
			app,
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
