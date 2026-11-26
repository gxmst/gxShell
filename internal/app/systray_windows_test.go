//go:build windows

package app

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
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
	// testing runs each test in its own goroutine; the desktop entry point
	// normally runs on Wails' initialized main apartment.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED); err != nil {
		t.Fatal(err)
	}
	defer windows.CoUninitialize()
	const wndClass = "gxShellTrayIntegrationTest"
	host := application.New(application.Options{Name: "gxShellTrayTest", Windows: application.WindowsOptions{WndClass: wndClass}})
	a := NewApp()
	icon, err := os.ReadFile(filepath.Join("..", "..", "build", "windows", "icon.png"))
	if err != nil {
		t.Fatal(err)
	}
	a.trayIcon = icon

	probeTray := func() error {

		u32 := windows.NewLazySystemDLL("user32.dll")
		findWindow := u32.NewProc("FindWindowExW")
		owner := u32.NewProc("GetWindowThreadProcessId")
		class, _ := windows.UTF16PtrFromString(wndClass)
		probe := u32.NewProc("SendMessageTimeoutW")
		exclude := map[uintptr]bool{}
		find := func() uintptr {
			var after uintptr
			for {
				hwnd, _, _ := findWindow.Call(^uintptr(2), after, uintptr(unsafe.Pointer(class)), 0)
				if hwnd == 0 {
					return 0
				}
				var pid uint32
				owner.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
				if pid == uint32(os.Getpid()) && !exclude[hwnd] {
					return hwnd
				}
				after = hwnd
			}
		}
		for h := find(); h != 0; h = find() {
			exclude[h] = true
		}
		var tray *application.SystemTray
		application.InvokeSync(func() { tray = a.installTray(host, func() {}) })
		deadline := time.Now().Add(5 * time.Second)
		var hwnd uintptr
		for hwnd == 0 && time.Now().Before(deadline) {
			hwnd = find()
			time.Sleep(10 * time.Millisecond)
		}
		if hwnd == 0 {
			return fmt.Errorf("tray window was not created")
		}
		for i := 0; i < 10; i++ {
			runtime.GC()
			runtime.Gosched()
			var result uintptr
			// WM_NULL asks the owner thread to respond without changing the UI.
			ok, _, _ := probe.Call(hwnd, 0, 0, 0, 2, 500, uintptr(unsafe.Pointer(&result)))
			if ok == 0 {
				return fmt.Errorf("tray window owner is not pumping Windows messages")
			}
		}
		application.InvokeSync(tray.Destroy)
		deadline = time.Now().Add(2 * time.Second)
		for find() != 0 && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if find() != 0 {
			return fmt.Errorf("tray window was not removed on shutdown")
		}
		return nil
	}
	host.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		if err := probeTray(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		host.Quit()
	})
	if err := host.Run(); err != nil {
		t.Fatal(err)
	}
}
