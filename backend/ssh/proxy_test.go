package sshmanager

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestFirstHopDialCancellationReachesProxy(t *testing.T) {
	manager := &Manager{}
	started := make(chan struct{})
	manager.SetDialContext(func(ctx context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" || address != "jump.test:22" {
			t.Errorf("dial=%s %s", network, address)
		}
		close(started)
		<-ctx.Done()
		return nil, ctx.Err()
	})
	session := &Session{done: make(chan struct{})}
	done := make(chan error, 1)
	go func() { _, err := manager.dialFirstHop(session, "jump.test:22", time.Minute); done <- err }()
	<-started
	close(session.done)
	select {
	case err := <-done:
		if err != context.Canceled {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not interrupt first-hop proxy dial")
	}
}
