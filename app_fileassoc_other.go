//go:build !windows

package main

import "errors"

var errFileAssocUnsupported = errors.New("file association is only supported on Windows")

// On non-Windows platforms the right-click file-association feature is a no-op.
// The methods still exist so the Wails bindings (and the frontend) are
// identical across platforms; the settings toggle simply reports "not
// registered" and registering reports an error the UI surfaces as unsupported.

func (a *App) IsMarkdownContextMenuRegistered() bool {
	return false
}

func (a *App) RegisterMarkdownContextMenu() error {
	return errFileAssocUnsupported
}

func (a *App) UnregisterMarkdownContextMenu() error {
	return nil
}
