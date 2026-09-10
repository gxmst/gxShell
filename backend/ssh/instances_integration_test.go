package sshmanager

import (
	"crypto/ed25519"
	"crypto/rand"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"gxShell/backend/types"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// Real TCP and SSH channels exercise transport ownership without a remote host
// or any change to the developer's network. Each shell echoes only its input.
type echoSSHObservation struct {
	request func(*ssh.Request)
	input   io.Writer
}

func echoSSHServer(t *testing.T, observations ...echoSSHObservation) (types.Profile, string, func(string)) {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{NoClientAuth: true}
	config.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	connections := map[string]net.Conn{}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			connections[conn.RemoteAddr().String()] = conn
			mu.Unlock()
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer conn.Close()
				server, channels, requests, err := ssh.NewServerConn(conn, config)
				if err != nil {
					return
				}
				defer server.Close()
				go ssh.DiscardRequests(requests)
				for incoming := range channels {
					channel, requests, err := incoming.Accept()
					if err != nil {
						continue
					}
					wg.Add(1)
					go func() {
						defer wg.Done()
						defer channel.Close()
						for request := range requests {
							for _, observation := range observations {
								if observation.request != nil {
									observation.request(request)
								}
							}
							_ = request.Reply(true, nil)
							if request.Type == "shell" {
								go ssh.DiscardRequests(requests)
								var input io.Reader = channel
								for _, observation := range observations {
									if observation.input != nil {
										input = io.TeeReader(input, observation.input)
									}
								}
								_, _ = io.Copy(channel, input)
								return
							}
						}
					}()
				}
			}()
		}
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		mu.Lock()
		for _, conn := range connections {
			_ = conn.Close()
		}
		mu.Unlock()
		wg.Wait()
	})
	path := filepath.Join(t.TempDir(), "known_hosts")
	if err := os.WriteFile(path, []byte(knownhosts.Line([]string{listener.Addr().String()}, signer.PublicKey())+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	profile := types.Profile{ID: "test", Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, Username: "test", AuthType: types.AuthPassword, Password: "test-only"}
	return profile, path, func(address string) {
		mu.Lock()
		defer mu.Unlock()
		if conn := connections[address]; conn != nil {
			_ = conn.Close()
		}
	}
}

func TestTerminalInstancesOverRealSSH(t *testing.T) {
	profile, known, drop := echoSSHServer(t)
	var mu sync.Mutex
	output := map[string]string{}
	closed := make(chan string, 10)
	m := NewManager(known, func(event string, value any) {
		if event == "terminal:data" {
			data := value.(map[string]any)
			mu.Lock()
			output[data["sessionId"].(string)] += data["data"].(string)
			mu.Unlock()
		}
	}, nil)
	m.SetOnClosed(func(id string) { closed <- id })
	t.Cleanup(func() {
		for _, s := range m.List() {
			_ = m.Disconnect(s.ID)
		}
	})
	var infos [3]types.SessionInfo
	var errs [3]error
	var wg sync.WaitGroup
	for i, instance := range []string{"", "second", "third"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			infos[i], _, errs[i] = m.ConnectInstanceViaJumpWithStatus(profile, types.Profile{}, instance, 3, 80, 24)
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("connect %d: %v", i, err)
		}
	}
	if len(m.List()) != 3 {
		t.Fatalf("sessions: %#v", m.List())
	}
	assertOutput := func(info types.SessionInfo, input, expected string) {
		t.Helper()
		if err := m.Write(info.ID, input); err != nil {
			t.Fatal(err)
		}
		deadline := time.NewTimer(3 * time.Second)
		defer deadline.Stop()
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			mu.Lock()
			got := output[info.ID]
			mu.Unlock()
			if got == expected {
				return
			}
			if !strings.HasPrefix(expected, got) {
				t.Fatalf("crossed output for %s: %q", info.InstanceID, got)
			}
			select {
			case <-deadline.C:
				t.Fatalf("output for %s = %q, want %q", info.InstanceID, got, expected)
			case <-ticker.C:
			}
		}
	}
	for i, info := range infos {
		assertOutput(info, info.ID+"\n", info.ID+"\n")
		if info.Generation != 1 {
			t.Fatalf("generation %d: %d", i, info.Generation)
		}
	}
	reused, owner, err := m.ConnectInstanceViaJumpWithStatus(profile, types.Profile{}, "second", 3, 80, 24)
	if err != nil || owner || reused.ID != infos[1].ID {
		t.Fatalf("reuse: %#v %v %v", reused, owner, err)
	}
	session, _ := m.get(infos[1].ID)
	drop(session.client.LocalAddr().String())
	select {
	case id := <-closed:
		if id != infos[1].ID {
			t.Fatalf("wrong session closed: %s", id)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("dropped transport not cleaned up")
	}
	reconnected, _, err := m.ConnectInstanceViaJumpWithStatus(profile, types.Profile{}, "second", 3, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if reconnected.ID == infos[1].ID || reconnected.Generation != 2 || reconnected.RuntimeID != infos[1].RuntimeID {
		t.Fatalf("reconnect identity: %#v", reconnected)
	}
	assertOutput(reconnected, "new\n", "new\n")
	for _, i := range []int{0, 2} {
		assertOutput(infos[i], "still-live\n", infos[i].ID+"\nstill-live\n")
		current, err := m.Get(infos[i].ID)
		if err != nil || current.Generation != 1 {
			t.Fatalf("sibling changed: %#v %v", current, err)
		}
	}
}

func TestCloseDuringSSHHandshakeReleasesSocketAndSlot(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			accepted <- conn
		}
	}()
	m := NewManager(filepath.Join(t.TempDir(), "known_hosts"), func(string, any) {}, nil)
	finished := make(chan error, 1)
	go func() {
		_, _, err := m.ConnectInstanceViaJumpWithStatus(types.Profile{ID: "test", Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, Username: "test", AuthType: types.AuthPassword, Password: "test-only"}, types.Profile{}, "second", 3, 80, 24)
		finished <- err
	}()
	var conn net.Conn
	select {
	case conn = <-accepted:
	case <-time.After(3 * time.Second):
		t.Fatal("no TCP connection")
	}
	defer conn.Close()
	// Reading the client banner proves the socket has been registered for cancellation.
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buffer := make([]byte, 256)
	if _, err := conn.Read(buffer); err != nil {
		t.Fatal(err)
	}
	if err := m.Disconnect(m.List()[0].ID); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("cancelled handshake succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("handshake leaked after close")
	}
	if _, err := conn.Read(buffer); err == nil {
		t.Fatal("socket still open")
	}
	if len(m.List()) != 0 || len(m.connecting) != 0 {
		t.Fatal("cancelled connection retained a slot")
	}
}
