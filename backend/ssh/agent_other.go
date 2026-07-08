//go:build !windows

package sshmanager

import (
	"errors"
	"net"
	"os"
)

func dialAgent() (net.Conn, error) {
	sock := os.Getenv("SSH_AUTH_SOCK")
	if sock == "" {
		return nil, errors.New("SSH_AUTH_SOCK is not set; no SSH agent available")
	}
	return net.Dial("unix", sock)
}
