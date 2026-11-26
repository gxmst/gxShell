package main

import (
	"context"
	"embed"
	"fmt"
	"net/http"
	"os"
	"sync"

	"gxShell/internal/app"
	"gxShell/internal/desktop"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/windows/icon.png
var trayIcon []byte

func main() {
	a := app.NewApp()
	if len(os.Args) > 1 {
		app.SetStartupFilePath(a, os.Args[1])
	}
	hooks := app.NewHooks(a)
	mux := http.NewServeMux()
	mux.Handle("/__gxshell/document/", app.DocumentAssetHandler(a))
	mux.Handle("/", application.BundledAssetFileServer(assets))
	initialized := make(chan struct{})
	host := application.New(application.Options{
		Name:     "gxShell",
		Windows:  app.DisplayChangeOptions(),
		Services: []application.Service{application.NewService(a)},
		Assets:   application.AssetOptions{Handler: mux},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "gxshell-2f6c1d8a-single-instance",
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				<-initialized
				if len(data.Args) > 0 {
					hooks.SecondInstanceLaunch(data.Args[1:])
				}
			},
		},
	})
	mainWindow := host.Window.NewWithOptions(application.WebviewWindowOptions{
		Name: "main", Title: "gxShell", Width: 1180, Height: 760, MinWidth: 900, MinHeight: 620, Frameless: true,
		BackgroundColour: application.NewRGB(14, 18, 23), EnableFileDrop: true,
	})
	ctx := desktop.WithWindow(host.Context(), mainWindow)
	if err := hooks.Startup(ctx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	app.SetTrayIcon(a, trayIcon)
	app.SetupSystemTray(a)
	hooks.PrepareWindow(ctx)
	close(initialized)
	mainWindow.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		if hooks.BeforeClose(ctx) {
			e.Cancel()
		}
	})
	shutdown := sync.OnceFunc(func() { hooks.Shutdown(context.Background()) })
	host.OnShutdown(shutdown)
	defer shutdown()
	if err := host.Run(); err != nil {
		shutdown()
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
