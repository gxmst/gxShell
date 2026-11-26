package app

import (
	"encoding/json"
	"os"
	"path/filepath"

	"gxShell/internal/desktop"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func (a *App) setupSystemTray() *application.SystemTray {
	w := desktop.MainWindow(a.ctx.Get())
	if w == nil {
		return nil
	}
	host := application.Get()
	show := func() {
		w.Show()
		if w.IsMinimised() {
			w.UnMinimise()
		}
		w.Focus()
	}
	return a.installTray(host, show)
}

func (a *App) installTray(host *application.App, show func()) *application.SystemTray {
	labels := loadTrayLabels()
	tray := host.SystemTray.New()
	tray.SetIcon(a.trayIcon).SetTooltip(labels.tooltip)
	menu := host.NewMenu()
	add := func(label string, action func()) {
		menu.Add(label).OnClick(func(*application.Context) { show(); action() })
	}
	add(labels.showWindow, func() {})
	menu.AddSeparator()
	add(labels.newConnection, func() { host.Event.Emit("tray:new-connection") })
	add(labels.openTextFile, func() { host.Event.Emit("tray:open-markdown") })
	menu.AddSeparator()
	add(labels.settings, func() { host.Event.Emit("tray:settings") })
	menu.AddSeparator()
	add(labels.quit, a.requestFrontendClose)
	tray.SetMenu(menu)
	tray.OnClick(show)
	return tray
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
