//go:build windows

package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The tray library has process-global state. Exercise a real native message
// loop in a child process with isolated settings, without touching the user's
// running desktop application or sending mouse/keyboard input.
func TestWindowsTrayMessageLoop(t *testing.T) {
	if os.Getenv("GXSHELL_TEST_TRAY_CHILD") != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestWindowsTrayMessageLoop$", "-test.v")
		cmd.Env = append(os.Environ(), "GXSHELL_TEST_TRAY_CHILD=1", "APPDATA="+t.TempDir())
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("native tray test failed: %v\n%s", err, output)
		}
		return
	}
	a := NewApp()
	icon, err := os.ReadFile(filepath.Join("..", "..", "build", "windows", "icon.ico"))
	if err != nil {
		t.Fatal(err)
	}
	a.trayIcon = icon
	a.setupSystemTray()
	defer a.stopSystemTray()

	u32 := windows.NewLazySystemDLL("user32.dll")
	enum := u32.NewProc("EnumWindows")
	owner := u32.NewProc("GetWindowThreadProcessId")
	class := u32.NewProc("GetClassNameW")
	probe := u32.NewProc("SendMessageTimeoutW")
	find := func() uintptr {
		var found uintptr
		callback := syscall.NewCallback(func(hwnd, _ uintptr) uintptr {
			var pid uint32
			owner.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
			if pid != uint32(os.Getpid()) {
				return 1
			}
			var name [256]uint16
			class.Call(hwnd, uintptr(unsafe.Pointer(&name[0])), uintptr(len(name)))
			if windows.UTF16ToString(name[:]) == "SystrayClass" {
				found = hwnd
				return 0
			}
			return 1
		})
		enum.Call(callback, 0)
		return found
	}
	deadline := time.Now().Add(5 * time.Second)
	var hwnd uintptr
	for hwnd == 0 && time.Now().Before(deadline) {
		hwnd = find()
		time.Sleep(10 * time.Millisecond)
	}
	if hwnd == 0 {
		t.Fatal("tray window was not created")
	}
	for i := 0; i < 10; i++ {
		runtime.GC()
		runtime.Gosched()
		var result uintptr
		// WM_NULL asks the owner thread to respond without changing the UI.
		ok, _, _ := probe.Call(hwnd, 0, 0, 0, 2, 500, uintptr(unsafe.Pointer(&result)))
		if ok == 0 {
			t.Fatal("tray window owner is not pumping Windows messages")
		}
	}
	a.stopSystemTray()
	deadline = time.Now().Add(2 * time.Second)
	for find() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if find() != 0 {
		t.Fatal("tray window was not removed on shutdown")
	}
}
