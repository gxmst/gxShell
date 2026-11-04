package networkproxy

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"unsafe"

	"golang.org/x/net/http/httpproxy"
	"golang.org/x/sys/windows"
)

var winhttp = windows.NewLazySystemDLL("winhttp.dll")
var getIEConfig = winhttp.NewProc("WinHttpGetIEProxyConfigForCurrentUser")
var getDefaultConfig = winhttp.NewProc("WinHttpGetDefaultProxyConfiguration")
var getProxyForURL = winhttp.NewProc("WinHttpGetProxyForUrl")
var openSession = winhttp.NewProc("WinHttpOpen")
var closeSession = winhttp.NewProc("WinHttpCloseHandle")
var setTimeouts = winhttp.NewProc("WinHttpSetTimeouts")
var globalFree = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalFree")

type ieConfig struct {
	AutoDetect             uint32
	AutoURL, Proxy, Bypass *uint16
}
type proxyInfo struct {
	AccessType    uint32
	Proxy, Bypass *uint16
}
type autoOptions struct {
	Flags, DetectFlags       uint32
	URL                      *uint16
	Reserved                 unsafe.Pointer
	ReservedFlags, AutoLogon uint32
}

func freeProxyStrings(pointers ...*uint16) {
	for _, p := range pointers {
		if p != nil {
			globalFree.Call(uintptr(unsafe.Pointer(p)))
		}
	}
}

func systemProxy(req *http.Request) (*url.URL, error) {
	env := httpproxy.FromEnvironment()
	if env.HTTPProxy != "" || env.HTTPSProxy != "" {
		return env.ProxyFunc()(req.URL)
	}
	var cfg ieConfig
	ok, _, _ := getIEConfig.Call(uintptr(unsafe.Pointer(&cfg)))
	if ok == 0 {
		var fallback proxyInfo
		ok, _, _ = getDefaultConfig.Call(uintptr(unsafe.Pointer(&fallback)))
		defer freeProxyStrings(fallback.Proxy, fallback.Bypass)
		if ok == 0 || fallback.AccessType == 1 {
			return nil, nil
		}
		return staticSystemProxy(windows.UTF16PtrToString(fallback.Proxy), windows.UTF16PtrToString(fallback.Bypass), req.URL)
	}
	defer freeProxyStrings(cfg.AutoURL, cfg.Proxy, cfg.Bypass)
	if cfg.AutoURL != nil {
		return automaticSystemProxy(req, windows.UTF16PtrToString(cfg.AutoURL), false)
	}
	if cfg.Proxy != nil && windows.UTF16PtrToString(cfg.Proxy) != "" {
		return staticSystemProxy(windows.UTF16PtrToString(cfg.Proxy), windows.UTF16PtrToString(cfg.Bypass), req.URL)
	}
	if cfg.AutoDetect != 0 {
		return automaticSystemProxy(req, "", true)
	}
	return nil, nil
}

func staticSystemProxy(server, bypass string, target *url.URL) (*url.URL, error) {
	entries := map[string]string{}
	for _, part := range strings.Split(server, ";") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			value = key
			key = ""
		}
		entries[strings.ToLower(key)] = strings.TrimSpace(value)
	}
	address := entries[target.Scheme]
	if address == "" {
		address = entries[""]
	}
	if address == "" && entries["socks"] != "" {
		address = "socks5://" + entries["socks"]
	}
	if address == "" {
		return nil, nil
	}
	if !strings.Contains(address, "://") {
		address = "http://" + address
	}
	if strings.Contains(bypass, "<local>") && !strings.Contains(target.Hostname(), ".") {
		return nil, nil
	}
	return (&httpproxy.Config{HTTPProxy: address, HTTPSProxy: address, NoProxy: strings.ReplaceAll(bypass, ";", ",")}).ProxyFunc()(target)
}

func automaticSystemProxy(req *http.Request, script string, detect bool) (*url.URL, error) {
	if err := req.Context().Err(); err != nil {
		return nil, err
	}
	handle, _, err := openSession.Call(0, 1, 0, 0, 0)
	if handle == 0 {
		return nil, fmt.Errorf("cannot open Windows proxy resolver: %w", err)
	}
	defer closeSession.Call(handle)
	// Bound PAC/WPAD network work. Never automatically send Windows logon
	// credentials in response to a proxy-script authentication challenge.
	setTimeouts.Call(handle, 5000, 5000, 5000, 5000)
	target, err := windows.UTF16PtrFromString(req.URL.String())
	if err != nil {
		return nil, err
	}
	options := autoOptions{Flags: 2}
	if detect {
		options.Flags = 1
		options.DetectFlags = 3
	} else {
		options.URL, err = windows.UTF16PtrFromString(script)
		if err != nil {
			return nil, err
		}
	}
	var info proxyInfo
	ok, _, callErr := getProxyForURL.Call(handle, uintptr(unsafe.Pointer(target)), uintptr(unsafe.Pointer(&options)), uintptr(unsafe.Pointer(&info)))
	defer freeProxyStrings(info.Proxy, info.Bypass)
	if err := req.Context().Err(); err != nil {
		return nil, err
	}
	if ok == 0 {
		// WPAD not finding a configuration is Windows' normal direct case.
		if detect && callErr == windows.Errno(12180) {
			return nil, nil
		}
		return nil, fmt.Errorf("Windows automatic proxy resolution failed: %w", callErr)
	}
	if info.AccessType == 1 {
		return nil, nil
	}
	return staticSystemProxy(windows.UTF16PtrToString(info.Proxy), windows.UTF16PtrToString(info.Bypass), req.URL)
}
