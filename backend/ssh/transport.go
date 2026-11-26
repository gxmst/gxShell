package sshmanager

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"time"

	"gxShell/backend/types"

	"golang.org/x/crypto/ssh"
)

// AuthenticationPrompts belong to the window that initiated the connection.
type AuthenticationPrompts struct {
	ConfirmHostKey       func(host, fingerprint string) bool
	ConfirmHostKeyChange func(host, oldFingerprint, newFingerprint string) bool
	KeyboardInteractive  KeyboardInteractivePrompt
}

// TestConnection authenticates without allocating a terminal, runtime or SSH session channel.
func (m *Manager) TestConnection(ctx context.Context, profile, jump types.Profile, timeoutSec int, prompts AuthenticationPrompts) error {
	client, jumpClient, _, err := m.dialAuthenticated(ctx, profile, jump, "", timeoutSec, prompts)
	if err != nil {
		return err
	}
	_ = client.Close()
	if jumpClient != nil {
		_ = jumpClient.Close()
	}
	return ctx.Err()
}

func (m *Manager) dialAuthenticated(ctx context.Context, profile, jump types.Profile, id string, timeoutSec int, prompts AuthenticationPrompts) (*ssh.Client, *ssh.Client, netip.Addr, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, netip.Addr{}, err
	}
	if timeoutSec <= 0 {
		timeoutSec = 15
	}
	targetPause := &handshakePause{}
	targetConfig, closeAuth, err := m.clientConfig(profile, id, timeoutSec, targetPause, prompts)
	defer closeAuth()
	if err != nil {
		return nil, nil, netip.Addr{}, err
	}
	targetAddr := sshAddress(profile.Host, profile.Port)
	firstAddr, firstConfig, firstPause := targetAddr, targetConfig, targetPause
	viaJump := jump.ID != ""
	if viaJump {
		firstAddr = sshAddress(jump.Host, jump.Port)
		firstPause = &handshakePause{}
		config, cleanup, err := m.clientConfig(jump, id, timeoutSec, firstPause, prompts)
		defer cleanup()
		if err != nil {
			return nil, nil, netip.Addr{}, fmt.Errorf("jump host config error: %w", err)
		}
		firstConfig = config
	}
	timeout := time.Duration(timeoutSec) * time.Second
	dial := m.dialContext
	if dial == nil {
		dial = (&net.Dialer{}).DialContext
	}
	dialCtx, cancel := context.WithTimeout(ctx, timeout)
	conn, err := dial(dialCtx, "tcp", firstAddr)
	cancel()
	if err != nil {
		if viaJump {
			err = fmt.Errorf("jump host connection failed: %w", err)
		}
		return nil, nil, netip.Addr{}, err
	}
	// Closing the first socket interrupts both handshakes and any forwarded dial.
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	first, err := authenticate(conn, firstAddr, firstConfig, firstPause)
	if err != nil {
		_ = conn.Close()
		if viaJump {
			err = fmt.Errorf("jump host SSH handshake failed: %w", err)
		}
		return nil, nil, netip.Addr{}, err
	}
	if !viaJump {
		var peer netip.Addr
		direct, _ := conn.(interface{ DirectSSHPeer() bool })
		if m.dialContext == nil || (direct != nil && direct.DirectSSHPeer()) {
			if addr, ok := conn.RemoteAddr().(*net.TCPAddr); ok {
				peer = addr.AddrPort().Addr().Unmap()
			}
		}
		return first, nil, peer, nil
	}
	dialCtx, cancel = context.WithTimeout(ctx, timeout)
	target, err := first.DialContext(dialCtx, "tcp", targetAddr)
	cancel()
	if err != nil {
		_ = first.Close()
		return nil, nil, netip.Addr{}, fmt.Errorf("jump host cannot reach target %s: %w", targetAddr, err)
	}
	// A forwarded channel cannot apply a socket deadline itself.
	guarded := withDeadline(target)
	client, err := authenticate(guarded, targetAddr, targetConfig, targetPause)
	if err != nil {
		_ = first.Close()
		_ = guarded.Close()
		if guarded.timedOut() {
			return nil, nil, netip.Addr{}, fmt.Errorf("target SSH handshake via jump timed out after %ds", timeoutSec)
		}
		return nil, nil, netip.Addr{}, fmt.Errorf("target SSH handshake via jump failed: %w", err)
	}
	return client, first, netip.Addr{}, nil
}

func authenticate(conn net.Conn, addr string, config *ssh.ClientConfig, pause *handshakePause) (*ssh.Client, error) {
	_ = conn.SetDeadline(time.Now().Add(config.Timeout))
	defer conn.SetDeadline(time.Time{})
	pause.attach(conn, config.Timeout)
	client, channels, requests, err := ssh.NewClientConn(conn, addr, config)
	if err != nil {
		return nil, err
	}
	return ssh.NewClient(client, channels, requests), nil
}
