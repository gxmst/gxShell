//go:build windows

package main

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows/registry"
)

// The context-menu entry is added under the per-user file-association tree, not
// under the .md ProgID itself. This appends a "right-click → open with gxShell"
// verb without touching which application is the default handler for .md, so it
// never hijacks an existing association. Everything lives under HKCU, so no
// administrator rights are required and uninstalling leaves only a single
// user-scoped key behind.
const (
	mdContextMenuKey  = `Software\Classes\SystemFileAssociations\.md\shell\OpenWithGxShell`
	mdContextMenuVerb = "Open with gxShell"
)

// IsMarkdownContextMenuRegistered reports whether the right-click "open with
// gxShell" entry exists and still points at the current executable. A stale
// entry left by a moved or reinstalled binary counts as not registered, so the
// settings toggle reflects whether the menu would actually work.
func (a *App) IsMarkdownContextMenuRegistered() bool {
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	key, err := registry.OpenKey(registry.CURRENT_USER, mdContextMenuKey+`\command`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer key.Close()
	command, _, err := key.GetStringValue("")
	if err != nil {
		return false
	}
	return command == mdCommandValue(exe)
}

// RegisterMarkdownContextMenu adds (or refreshes) the right-click entry pointing
// at the current executable. It is idempotent: calling it when the entry already
// exists simply rewrites the same values.
func (a *App) RegisterMarkdownContextMenu() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable: %w", err)
	}

	shellKey, _, err := registry.CreateKey(registry.CURRENT_USER, mdContextMenuKey, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("create menu key: %w", err)
	}
	defer shellKey.Close()
	// The default value is the label shown in the context menu.
	if err := shellKey.SetStringValue("", mdContextMenuVerb); err != nil {
		return fmt.Errorf("set menu label: %w", err)
	}
	// Icon makes the entry show the app icon next to the label. The raw path
	// (no escaping) is what Explorer expects.
	_ = shellKey.SetStringValue("Icon", exe)

	commandKey, _, err := registry.CreateKey(registry.CURRENT_USER, mdContextMenuKey+`\command`, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("create command key: %w", err)
	}
	defer commandKey.Close()
	if err := commandKey.SetStringValue("", mdCommandValue(exe)); err != nil {
		return fmt.Errorf("set command: %w", err)
	}
	if a.log != nil {
		a.log.Info("Registered markdown context-menu entry")
	}
	return nil
}

// UnregisterMarkdownContextMenu removes the right-click entry. It is a no-op when
// the entry does not exist, so it is safe to call unconditionally.
func (a *App) UnregisterMarkdownContextMenu() error {
	// The command subkey must be deleted before its parent; DeleteKey only
	// removes leaf keys.
	if err := registry.DeleteKey(registry.CURRENT_USER, mdContextMenuKey+`\command`); err != nil && !isRegistryNotFound(err) {
		return fmt.Errorf("delete command key: %w", err)
	}
	if err := registry.DeleteKey(registry.CURRENT_USER, mdContextMenuKey); err != nil && !isRegistryNotFound(err) {
		return fmt.Errorf("delete menu key: %w", err)
	}
	if a.log != nil {
		a.log.Info("Removed markdown context-menu entry")
	}
	return nil
}

// mdCommandValue builds the command string Explorer runs for the verb. %1 is the
// selected file path; both the exe and the placeholder are wrapped in literal
// quotes so paths with spaces are passed as one argument. We must not use %q
// here: it would escape the backslashes in a Windows path, which the shell does
// not unescape.
func mdCommandValue(exe string) string {
	return `"` + exe + `" "%1"`
}

func isRegistryNotFound(err error) bool {
	return err == registry.ErrNotExist || os.IsNotExist(err)
}
