package sshmanager

import (
	"context"
	"errors"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
	"net"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

func TestCancelledCommandDoesNotLookupSession(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	m := NewManager("", nil, nil)
	_, err := m.ExecuteCommandResultStream(ctx, "absent", "uptime", nil, time.Second, 1024, nil)
	var notStarted *CommandNotStartedError
	if !errors.Is(err, context.Canceled) || !errors.As(err, &notStarted) || notStarted.Retryable {
		t.Fatalf("cancelled command: %v", err)
	}
}

func TestCancellationDuringChannelOpenDoesNotSendExec(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var commands atomic.Int32
	profile, known, _ := echoSSHServer(t, echoSSHObservation{
		openChannel: cancel,
		request: func(r *ssh.Request) {
			if r.Type == "exec" {
				commands.Add(1)
			}
		},
	})
	callback, err := knownhosts.New(known)
	if err != nil {
		t.Fatal(err)
	}
	client, err := ssh.Dial("tcp", net.JoinHostPort(profile.Host, strconv.Itoa(profile.Port)), &ssh.ClientConfig{User: "test", HostKeyCallback: callback, Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	m := NewManager(known, nil, nil)
	m.sessions["test"] = &Session{client: client}
	_, err = m.ExecuteCommandResultStream(ctx, "test", "uptime", nil, time.Second, 1024, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("command error: %v", err)
	}
	if commands.Load() != 0 {
		t.Fatal("exec sent after cancellation during channel open")
	}
}
