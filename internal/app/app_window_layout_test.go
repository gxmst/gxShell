package app

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
	"gxShell/backend/config"
)

func TestRestoreWindowOnAvailableScreens(t *testing.T) {
	primary := &application.Screen{ID: "1", Name: "internal", IsPrimary: true, ScaleFactor: 1.5, WorkArea: application.Rect{X: 0, Y: 24, Width: 1280, Height: 800}}
	left := &application.Screen{ID: "7", Name: "external", ScaleFactor: 1, WorkArea: application.Rect{X: -1920, Y: -100, Width: 1920, Height: 1040}}
	placement := config.WindowPlacement{ScreenID: "old-handle", ScreenName: "external", X: 70, Y: 30, Width: 800, Height: 560, Maximised: true}
	got, ok := restoredBounds(placement, []*application.Screen{primary, left}, 320, 200)
	want := application.Rect{X: -1850, Y: -70, Width: 800, Height: 560}
	if !ok || got != want {
		t.Fatalf("restore on external display: got %+v, want %+v", got, want)
	}
	// Remove the external screen and shrink the usable work area. The saved
	// normal rectangle can exceed the new work area even for a maximised window.
	placement.X, placement.Width, placement.Height = 1700, 2000, 530
	got, ok = restoredBounds(placement, []*application.Screen{nil, primary}, 320, 200)
	want = application.Rect{X: 0, Y: 54, Width: 1280, Height: 530}
	if !ok || got != want {
		t.Fatalf("after unplug: got %+v, want %+v", got, want)
	}
	if _, ok := restoredBounds(placement, nil, 320, 200); ok {
		t.Fatal("restored without a display")
	}
}

func TestOnlyRecoverUnreachableTitleBar(t *testing.T) {
	primary := &application.Screen{WorkArea: application.Rect{Width: 1280, Height: 800}}
	left := &application.Screen{WorkArea: application.Rect{X: -1920, Width: 1920, Height: 1080}}
	r := application.Rect{X: -1000, Y: 50, Width: 800, Height: 600}
	if !titleBarReachable(r, []*application.Screen{left, primary}) || titleBarReachable(r, []*application.Screen{primary}) {
		t.Fatal("reachability did not track display removal")
	}
	r.X = -730
	if !titleBarReachable(r, []*application.Screen{primary}) {
		t.Fatal("a window spanning displays still has 70 usable title bar pixels")
	}
	r.Y = -100
	if titleBarReachable(r, []*application.Screen{primary}) {
		t.Fatal("a visible client area cannot substitute for the title bar")
	}
}

func TestWindowPlacementSharedOnlyWithinKind(t *testing.T) {
	for name, want := range map[string]string{
		"main": "main", "sftp-session-2": "sftp", "monitor-3": "monitor",
		"connection-edit-server-4": "connection-edit", "connection-new-draft-1": "connection-new",
		"document-123": "document", "approval-789": "approval",
	} {
		if got := layoutKey(name); got != want {
			t.Errorf("layoutKey(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestSftpDropUsesDirectoryOfOwningWindow(t *testing.T) {
	target := &application.DropTargetDetails{Attributes: map[string]string{
		"data-gx-drop": "sftp", "data-session": "session-2", "data-directory": "/home/目录",
	}}
	for _, window := range []string{"main", "sftp-session-2"} {
		got, ok := sftpDropDestination(window, target)
		if !ok || got != (dropDestination{"session-2", "/home/目录"}) {
			t.Errorf("drop in %q: %+v, %t", window, got, ok)
		}
	}
	for _, window := range []string{"sftp-session-1", "monitor-session-2", "connection-new-draft-1"} {
		if _, ok := sftpDropDestination(window, target); ok {
			t.Errorf("accepted drop in wrong window %q", window)
		}
	}
	delete(target.Attributes, "data-session")
	if _, ok := sftpDropDestination("main", target); ok {
		t.Fatal("accepted drop on disconnected file panel")
	}
	if _, ok := sftpDropDestination("main", nil); ok {
		t.Fatal("treated a document drop as an upload")
	}
}
