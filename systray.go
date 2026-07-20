package main

import (
	_ "embed"
	"encoding/json"
	"os"
	"path/filepath"

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
	labels := loadTrayLabels()
	systray.SetIcon(trayIcon)
	systray.SetTitle("gxShell")
	systray.SetTooltip(labels.tooltip)

	// Create menu items
	mShow := systray.AddMenuItem(labels.showWindow, labels.showWindowTip)
	systray.AddSeparator()
	mNewConnection := systray.AddMenuItem(labels.newConnection, labels.newConnectionTip)
	mOpenMarkdown := systray.AddMenuItem(labels.openTextFile, labels.openTextFileTip)
	systray.AddSeparator()
	mSettings := systray.AddMenuItem(labels.settings, labels.settingsTip)
	systray.AddSeparator()
	mQuit := systray.AddMenuItem(labels.quit, labels.quitTip)

	// Handle menu clicks. This goroutine starts before wails.Run publishes the
	// app context, so every read goes through a.ctx.Get() at the moment of the
	// click; a click that lands before startup is ignored, as before.
	go func() {
		for {
			var done <-chan struct{}
			if ctx := a.ctx.Get(); ctx != nil {
				done = ctx.Done()
			}
			select {
			case <-done:
				return
			case <-mShow.ClickedCh:
				if ctx := a.ctx.Get(); ctx != nil {
					runtime.WindowShow(ctx)
					runtime.WindowUnminimise(ctx)
				}
			case <-mNewConnection.ClickedCh:
				if ctx := a.ctx.Get(); ctx != nil {
					runtime.WindowShow(ctx)
					runtime.WindowUnminimise(ctx)
					runtime.EventsEmit(ctx, "tray:new-connection")
				}
			case <-mOpenMarkdown.ClickedCh:
				if ctx := a.ctx.Get(); ctx != nil {
					runtime.WindowShow(ctx)
					runtime.WindowUnminimise(ctx)
					runtime.EventsEmit(ctx, "tray:open-markdown")
				}
			case <-mSettings.ClickedCh:
				if ctx := a.ctx.Get(); ctx != nil {
					runtime.WindowShow(ctx)
					runtime.WindowUnminimise(ctx)
					runtime.EventsEmit(ctx, "tray:settings")
				}
			case <-mQuit.ClickedCh:
				systray.Quit()
				if ctx := a.ctx.Get(); ctx != nil {
					runtime.Quit(ctx)
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

type trayLabels struct {
	tooltip          string
	showWindow       string
	showWindowTip    string
	newConnection    string
	newConnectionTip string
	openTextFile     string
	openTextFileTip  string
	settings         string
	settingsTip      string
	quit             string
	quitTip          string
}

func loadTrayLabels() trayLabels {
	lang := readTrayLanguage()
	if lang == "zh-CN" {
		return trayLabels{
			tooltip:          "gxShell - SSH 客户端",
			showWindow:       "显示窗口",
			showWindowTip:    "显示主窗口",
			newConnection:    "新建 SSH 连接",
			newConnectionTip: "创建新的 SSH 连接",
			openTextFile:     "打开文本文件",
			openTextFileTip:  "打开文本文件",
			settings:         "设置",
			settingsTip:      "打开设置",
			quit:             "退出",
			quitTip:          "退出应用",
		}
	}
	return trayLabels{
		tooltip:          "gxShell - SSH Client",
		showWindow:       "Show Window",
		showWindowTip:    "Show the main window",
		newConnection:    "New SSH Connection",
		newConnectionTip: "Create a new SSH connection",
		openTextFile:     "Open Text File",
		openTextFileTip:  "Open a text file",
		settings:         "Settings",
		settingsTip:      "Open settings",
		quit:             "Quit",
		quitTip:          "Quit the application",
	}
}

func readTrayLanguage() string {
	base, err := os.UserConfigDir()
	if err != nil {
		return "en"
	}
	data, err := os.ReadFile(filepath.Join(base, "gxShell", "settings.json"))
	if err != nil {
		return "en"
	}
	var settings struct {
		Language string `json:"language"`
	}
	if err := json.Unmarshal(data, &settings); err != nil || settings.Language == "" {
		return "en"
	}
	return settings.Language
}
