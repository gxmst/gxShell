package network

import (
	"encoding/binary"
	"net"
	"net/netip"
	"strconv"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	ipHelper  = windows.NewLazySystemDLL("iphlpapi.dll")
	openEcho4 = ipHelper.NewProc("IcmpCreateFile")
	openEcho6 = ipHelper.NewProc("Icmp6CreateFile")
	closeEcho = ipHelper.NewProc("IcmpCloseHandle")
	sendEcho4 = ipHelper.NewProc("IcmpSendEcho")
	sendEcho6 = ipHelper.NewProc("Icmp6SendEcho2")
)

// Echo sends one unprivileged echo request to the connected peer. The Windows
// IP Helper API returns structured status and RTT regardless of system language.
func Echo(peer netip.Addr, timeout time.Duration) (state string, ms float64) {
	open := openEcho4
	if peer.Is6() {
		open = openEcho6
	}
	handle, _, _ := open.Call()
	if handle == ^uintptr(0) {
		return "unavailable", 0
	}
	defer closeEcho.Call(handle)

	data := [8]byte{'g', 'x', 'S', 'h', 'e', 'l', 'l'}
	var reply [128]uint32 // aligned and large enough for either header + payload
	const replyBytes = unsafe.Sizeof(reply)
	var count uintptr
	var err error
	var status, rtt uint32
	if peer.Is4() {
		ip := peer.As4()
		count, _, err = sendEcho4.Call(handle, uintptr(binary.NativeEndian.Uint32(ip[:])),
			uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)), 0,
			uintptr(unsafe.Pointer(&reply[0])), replyBytes, uintptr(timeout.Milliseconds()))
		// ICMP_ECHO_REPLY starts with Address, Status, RoundTripTime.
		status, rtt = reply[1], reply[2]
	} else {
		source := windows.RawSockaddrInet6{Family: windows.AF_INET6}
		target := windows.RawSockaddrInet6{Family: windows.AF_INET6, Addr: peer.As16()}
		if zone := peer.Zone(); zone != "" {
			index, e := strconv.ParseUint(zone, 10, 32)
			if e != nil {
				iface, e := net.InterfaceByName(zone)
				if e != nil {
					return "unavailable", 0
				}
				index = uint64(iface.Index)
			}
			target.Scope_id = uint32(index)
		}
		count, _, err = sendEcho6.Call(handle, 0, 0, 0, uintptr(unsafe.Pointer(&source)),
			uintptr(unsafe.Pointer(&target)), uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)), 0,
			uintptr(unsafe.Pointer(&reply[0])), replyBytes, uintptr(timeout.Milliseconds()))
		// ICMPV6_ECHO_REPLY starts with IPV6_ADDRESS_EX.
		status, rtt = reply[7], reply[8]
	}
	if count == 0 {
		code, ok := err.(syscall.Errno)
		if !ok || code == 0 {
			return "unavailable", 0
		}
		status = uint32(code)
	}
	switch status {
	case 0:
		return "reply", float64(rtt)
	case 11002, 11003, 11004, 11005, 11009, 11010, 11013, 11014, 11040, 11041, 11042, 11043, 11044, 11045:
		return "lost", 0
	default:
		return "unavailable", 0
	}
}
