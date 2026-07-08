//go:build windows

package sshmanager

import (
	"fmt"
	"net"
	"time"

	winio "github.com/Microsoft/go-winio"
)

// windowsAgentPipe is the named pipe exposed by the Windows OpenSSH
// Authentication Agent service (and by compatible agents such as 1Password).
const windowsAgentPipe = `\\.\pipe\openssh-ssh-agent`

func dialAgent() (net.Conn, error) {
	timeout := 5 * time.Second
	conn, err := winio.DialPipe(windowsAgentPipe, &timeout)
	if err != nil {
		return nil, fmt.Errorf("cannot reach the OpenSSH agent pipe (is the 'OpenSSH Authentication Agent' service running?): %w", err)
	}
	return conn, nil
}
