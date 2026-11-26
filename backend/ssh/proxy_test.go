package sshmanager

import (
	"context"
	"errors"
	"net"
	"path/filepath"
	"testing"
	"time"

	"gxShell/backend/types"
)

func TestFirstHopDialCancellationReachesProxy(t *testing.T) {
	manager := NewManager(filepath.Join(t.TempDir(), "known_hosts"), nil, nil)
	started := make(chan struct{})
	manager.SetDialContext(func(ctx context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" || address != "jump.test:22" {
			t.Errorf("dial=%s %s", network, address)
		}
		close(started)
		<-ctx.Done()
		return nil, ctx.Err()
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		target := types.Profile{Host: "target.test", Port: 22}
		jump := types.Profile{ID: "jump", Host: "jump.test", Port: 22}
		done <- manager.TestConnection(ctx, target, jump, 60, AuthenticationPrompts{})
	}()
	<-started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not interrupt first-hop proxy dial")
	}
}
