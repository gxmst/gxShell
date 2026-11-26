//go:build !windows

package network

import (
	"context"
	"net/netip"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"time"
)

var echoTime = regexp.MustCompile(`time([=<])\s*([0-9]+(?:\.[0-9]+)?)\s*ms`)

// Echo probes a numeric address from the established direct connection.
func Echo(peer netip.Addr, timeout time.Duration) (string, float64) {
	program := "ping"
	args := []string{"-n", "-c", "1"}
	if peer.Is6() {
		if runtime.GOOS == "darwin" || runtime.GOOS == "freebsd" {
			program = "ping6"
		} else {
			args = append(args, "-6")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, program, append(args, peer.String())...)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	out, err := cmd.CombinedOutput()
	if match := echoTime.FindSubmatch(out); match != nil {
		ms, _ := strconv.ParseFloat(string(match[2]), 64)
		if string(match[1]) == "<" {
			ms = 0
		}
		return "reply", ms
	}
	if ctx.Err() != nil {
		return "lost", 0
	}
	if exit, ok := err.(*exec.ExitError); ok {
		noReply := 1
		if runtime.GOOS == "darwin" || runtime.GOOS == "freebsd" {
			noReply = 2
		}
		if exit.ExitCode() == noReply {
			return "lost", 0
		}
	}
	return "unavailable", 0
}
