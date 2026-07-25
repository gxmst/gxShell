//go:build darwin

package main

// Wails owns the NSApplicationDelegate on macOS. getlantern/systray declares
// another class with the same Objective-C name, so linking both implementations
// into one application fails. The experimental macOS build therefore runs
// without a tray until gxShell adopts a Wails-compatible tray implementation.
func (a *App) setupSystemTray() {}
