//go:build windows

package app

import (
	"strings"
	"testing"

	"golang.org/x/sys/windows/registry"
)

// TestMarkdownContextMenuRoundTrip registers the right-click entries, verifies they
// is detected, then removes it and verifies it is gone. It writes only to the
// app's own per-user key and always cleans up, so it is safe to run on a dev
// machine.
func TestMarkdownContextMenuRoundTrip(t *testing.T) {
	app := NewApp()
	// Ensure we start clean and always clean up, even if an assertion fails.
	_ = app.UnregisterMarkdownContextMenu()
	t.Cleanup(func() { _ = app.UnregisterMarkdownContextMenu() })

	if app.IsMarkdownContextMenuRegistered() {
		t.Fatal("expected not registered before RegisterMarkdownContextMenu")
	}

	if err := app.RegisterMarkdownContextMenu(); err != nil {
		t.Fatalf("RegisterMarkdownContextMenu: %v", err)
	}
	if !app.IsMarkdownContextMenuRegistered() {
		t.Fatal("expected registered after RegisterMarkdownContextMenu")
	}

	// The command value must quote the executable and pass the selected file.
	key, err := registry.OpenKey(registry.CURRENT_USER, textContextMenuKey(".md")+`\command`, registry.QUERY_VALUE)
	if err != nil {
		t.Fatalf("open command key: %v", err)
	}
	command, _, err := key.GetStringValue("")
	key.Close()
	if err != nil {
		t.Fatalf("read command value: %v", err)
	}
	if !strings.Contains(command, `"%1"`) {
		t.Fatalf("command missing file placeholder: %q", command)
	}
	if !registryCommandMatches(textContextMenuKey(".log")+`\command`, command) {
		t.Fatal("expected .log context menu command to be registered")
	}

	if err := app.UnregisterMarkdownContextMenu(); err != nil {
		t.Fatalf("UnregisterMarkdownContextMenu: %v", err)
	}
	if app.IsMarkdownContextMenuRegistered() {
		t.Fatal("expected not registered after UnregisterMarkdownContextMenu")
	}

	// Unregister must be a no-op (no error) when nothing is registered.
	if err := app.UnregisterMarkdownContextMenu(); err != nil {
		t.Fatalf("second UnregisterMarkdownContextMenu should be no-op: %v", err)
	}
}

func TestMdCommandValueQuotesExe(t *testing.T) {
	got := mdCommandValue(`C:\Program Files\gxShell\gxShell.exe`)
	want := `"C:\Program Files\gxShell\gxShell.exe" "%1"`
	if got != want {
		t.Fatalf("mdCommandValue = %q, want %q", got, want)
	}
}
