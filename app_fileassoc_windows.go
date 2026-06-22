//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// The context-menu entries are added under the per-user file-association tree,
// not under each extension's ProgID itself. This appends a "right-click → open
// with gxShell" verb without touching default handlers, so it never hijacks an
// existing association. Everything lives under HKCU, so no administrator rights
// are required.
const (
	textContextMenuVerb    = "Open with gxShell"
	textContextMenuVerbKey = `shell\OpenWithGxShell`
	anyFileContextMenuKey  = `Software\Classes\*\shell\OpenWithGxShell`
)

// IsTextContextMenuRegistered reports whether the right-click "open with
// gxShell" entries exist and still point at the current executable. A stale
// entry left by a moved or reinstalled binary counts as not registered, so the
// settings toggle reflects whether the menu would actually work.
func (a *App) IsTextContextMenuRegistered() bool {
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	for _, ext := range supportedTextFileExtensionList() {
		if !registryCommandMatches(textContextMenuKey(ext)+`\command`, mdCommandValue(exe)) {
			return false
		}
	}
	return registryCommandMatches(anyFileContextMenuKey+`\command`, mdCommandValue(exe))
}

// RegisterTextContextMenu adds (or refreshes) the right-click entries pointing
// at the current executable. It is idempotent: calling it when the entries
// already exist simply rewrites the same values.
func (a *App) RegisterTextContextMenu() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable: %w", err)
	}

	for _, ext := range supportedTextFileExtensionList() {
		if err := writeContextMenuVerb(textContextMenuKey(ext), exe, ""); err != nil {
			return fmt.Errorf("register %s menu: %w", ext, err)
		}
	}
	// This generic entry uses AppliesTo so classic Explorer menus can still show
	// gxShell for supported text files whose association is unusual.
	if err := writeContextMenuVerb(anyFileContextMenuKey, exe, textFileAppliesToExpression()); err != nil {
		return fmt.Errorf("register generic text-file menu: %w", err)
	}
	if err := writeOpenWithApplicationRegistration(exe); err != nil {
		return fmt.Errorf("register Open With application: %w", err)
	}
	if a.log != nil {
		a.log.Info("Registered text-file context-menu entries")
	}
	return nil
}

// UnregisterTextContextMenu removes the right-click entries. It is a no-op when
// an entry does not exist, so it is safe to call unconditionally.
func (a *App) UnregisterTextContextMenu() error {
	for _, ext := range supportedTextFileExtensionList() {
		if err := deleteContextMenuVerb(textContextMenuKey(ext)); err != nil {
			return fmt.Errorf("delete %s menu: %w", ext, err)
		}
	}
	if err := deleteContextMenuVerb(anyFileContextMenuKey); err != nil {
		return fmt.Errorf("delete generic text-file menu: %w", err)
	}
	if err := deleteOpenWithApplicationRegistration(); err != nil {
		return fmt.Errorf("delete Open With application registration: %w", err)
	}
	if a.log != nil {
		a.log.Info("Removed text-file context-menu entries")
	}
	return nil
}

// Markdown-named methods are kept for older frontend builds.
func (a *App) IsMarkdownContextMenuRegistered() bool { return a.IsTextContextMenuRegistered() }
func (a *App) RegisterMarkdownContextMenu() error    { return a.RegisterTextContextMenu() }
func (a *App) UnregisterMarkdownContextMenu() error  { return a.UnregisterTextContextMenu() }

// mdCommandValue builds the command string Explorer runs for the verb. %1 is the
// selected file path; both the exe and the placeholder are wrapped in literal
// quotes so paths with spaces are passed as one argument. We must not use %q
// here: it would escape the backslashes in a Windows path, which the shell does
// not unescape.
func mdCommandValue(exe string) string {
	return `"` + exe + `" "%1"`
}

func textContextMenuKey(ext string) string {
	return `Software\Classes\SystemFileAssociations\` + ext + `\` + textContextMenuVerbKey
}

func registryCommandMatches(keyPath string, want string) bool {
	key, err := registry.OpenKey(registry.CURRENT_USER, keyPath, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer key.Close()
	command, _, err := key.GetStringValue("")
	return err == nil && command == want
}

func writeContextMenuVerb(keyPath string, exe string, appliesTo string) error {
	shellKey, _, err := registry.CreateKey(registry.CURRENT_USER, keyPath, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("create menu key: %w", err)
	}
	defer shellKey.Close()
	if err := shellKey.SetStringValue("", textContextMenuVerb); err != nil {
		return fmt.Errorf("set menu label: %w", err)
	}
	if err := shellKey.SetStringValue("MUIVerb", textContextMenuVerb); err != nil {
		return fmt.Errorf("set menu verb: %w", err)
	}
	_ = shellKey.SetStringValue("Icon", exe)
	if appliesTo != "" {
		_ = shellKey.SetStringValue("AppliesTo", appliesTo)
	}

	commandKey, _, err := registry.CreateKey(registry.CURRENT_USER, keyPath+`\command`, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("create command key: %w", err)
	}
	defer commandKey.Close()
	if err := commandKey.SetStringValue("", mdCommandValue(exe)); err != nil {
		return fmt.Errorf("set command: %w", err)
	}
	return nil
}

func deleteContextMenuVerb(keyPath string) error {
	if err := registry.DeleteKey(registry.CURRENT_USER, keyPath+`\command`); err != nil && !isRegistryNotFound(err) {
		return fmt.Errorf("delete command key: %w", err)
	}
	if err := registry.DeleteKey(registry.CURRENT_USER, keyPath); err != nil && !isRegistryNotFound(err) {
		return fmt.Errorf("delete menu key: %w", err)
	}
	return nil
}

func writeOpenWithApplicationRegistration(exe string) error {
	appName := filepath.Base(exe)
	appKeyPath := `Software\Classes\Applications\` + appName
	defaultIconKey, _, err := registry.CreateKey(registry.CURRENT_USER, appKeyPath+`\DefaultIcon`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	_ = defaultIconKey.SetStringValue("", exe)
	defaultIconKey.Close()

	supportedTypesKey, _, err := registry.CreateKey(registry.CURRENT_USER, appKeyPath+`\SupportedTypes`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	for _, ext := range supportedTextFileExtensionList() {
		_ = supportedTypesKey.SetStringValue(ext, "")
	}
	supportedTypesKey.Close()

	openKeyPath := appKeyPath + `\shell\open`
	if err := writeContextMenuVerb(openKeyPath, exe, ""); err != nil {
		return err
	}
	return nil
}

func deleteOpenWithApplicationRegistration() error {
	exe, err := os.Executable()
	if err != nil {
		return nil
	}
	appKeyPath := `Software\Classes\Applications\` + filepath.Base(exe)
	if err := deleteContextMenuVerb(appKeyPath + `\shell\open`); err != nil {
		return err
	}
	for _, keyPath := range []string{
		appKeyPath + `\SupportedTypes`,
		appKeyPath + `\DefaultIcon`,
		appKeyPath + `\shell`,
		appKeyPath,
	} {
		if err := registry.DeleteKey(registry.CURRENT_USER, keyPath); err != nil && !isRegistryNotFound(err) {
			return err
		}
	}
	return nil
}

func textFileAppliesToExpression() string {
	parts := make([]string, 0, len(supportedTextFileExtensionList()))
	for _, ext := range supportedTextFileExtensionList() {
		parts = append(parts, `System.FileExtension:="`+ext+`"`)
	}
	return strings.Join(parts, " OR ")
}

func isRegistryNotFound(err error) bool {
	return err == registry.ErrNotExist || os.IsNotExist(err)
}
