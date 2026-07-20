//go:build windows

package network

import "syscall"

// hideWindowSysProcAttr keeps the external tracert process from flashing a
// console window over the GUI app. CREATE_NO_WINDOW (0x08000000) suppresses
// console allocation entirely; HideWindow covers shells that still create one.
func hideWindowSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000,
	}
}
