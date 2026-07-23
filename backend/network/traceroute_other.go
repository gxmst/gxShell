//go:build !windows

package network

import "syscall"

// hideWindowSysProcAttr is a no-op outside Windows: HideWindow/CreationFlags
// only exist in the Windows syscall.SysProcAttr.
func hideWindowSysProcAttr() *syscall.SysProcAttr {
	return nil
}
