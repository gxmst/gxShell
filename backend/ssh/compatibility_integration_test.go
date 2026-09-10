package sshmanager

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/ssh"
	"gxShell/backend/sessionlog"
	"gxShell/backend/types"
)

type compatibilityBuffer struct {
	mu    sync.Mutex
	value bytes.Buffer
}

func (b *compatibilityBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.value.Write(data)
}

func (b *compatibilityBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.value.String()
}

func TestLegacyTerminalOverRealSSH(t *testing.T) {
	input := &compatibilityBuffer{}
	pty := make(chan string, 1)
	profile, known, _ := echoSSHServer(t, echoSSHObservation{input: input, request: func(request *ssh.Request) {
		if request.Type != "pty-req" {
			return
		}
		var payload struct {
			Term                      string
			Cols, Rows, Width, Height uint32
			Modes                     string
		}
		if err := ssh.Unmarshal(request.Payload, &payload); err != nil {
			return
		}
		pty <- payload.Term
	}})
	profile.Terminal = &types.TerminalSettings{Encoding: "gbk", TerminalType: "vt100"}
	output := &compatibilityBuffer{}
	outputSeen := make(chan struct{}, 20)
	m := NewManager(known, func(event string, value any) {
		if event == "terminal:data" {
			data := value.(map[string]any)["data"].(string)
			_, _ = output.Write([]byte(data))
			outputSeen <- struct{}{}
		}
	}, nil)
	logDir := t.TempDir()
	m.SetOutputLogFactory(func(types.Profile) (OutputLog, error) {
		return sessionlog.New(logDir, "legacy", types.SessionLogSettings{}, nil)
	})
	info, _, err := m.ConnectInstanceViaJumpWithStatus(profile, types.Profile{}, "", 3, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Disconnect(info.ID) })
	select {
	case term := <-pty:
		if term != "vt100" {
			t.Fatalf("negotiated TERM=%q", term)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("missing PTY request")
	}
	castPath := filepath.Join(t.TempDir(), "legacy.cast")
	if err := m.StartRecording(info.ID, castPath, "Legacy terminal"); err != nil {
		t.Fatal(err)
	}
	// The active session owns its codec; later profile edits affect reconnects.
	profile.Terminal.Encoding = "utf-8"
	if err := m.Write(info.ID, "echo 😀\r"); err == nil {
		t.Fatal("unsupported input was accepted")
	}
	text := "\x1b[32m中文\x1b[0m\r\n"
	if err := m.Write(info.ID, text); err != nil {
		t.Fatal(err)
	}
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for output.String() != text {
		select {
		case <-outputSeen:
		case <-timer.C:
			t.Fatalf("decoded output=%q", output.String())
		}
	}
	expectedWire := "\x1b[32m\xd6\xd0\xce\xc4\x1b[0m\r\n"
	if got := input.String(); got != expectedWire {
		t.Fatalf("SSH input=%x, want %x", got, expectedWire)
	}
	// Wait for the output pump before finalizing logs and the recording.
	if err := m.Disconnect(info.ID); err != nil {
		t.Fatal(err)
	}
	cast, err := os.ReadFile(castPath)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(cast)), "\n")
	var header struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &header); err != nil {
		t.Fatal(err)
	}
	if header.Env["TERM"] != "vt100" {
		t.Fatalf("recorded TERM=%v", header.Env)
	}
	var recorded string
	for _, line := range lines[1:] {
		var event []json.RawMessage
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatal(err)
		}
		var chunk string
		if err := json.Unmarshal(event[2], &chunk); err != nil {
			t.Fatal(err)
		}
		recorded += chunk
	}
	if recorded != text {
		t.Fatalf("recorded output=%q", recorded)
	}
	paths, err := filepath.Glob(filepath.Join(logDir, "*.log"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("logs=%v, %v", paths, err)
	}
	var logs string
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		logs += string(data)
	}
	if !utf8.ValidString(logs) || !strings.Contains(logs, "中文") || strings.Contains(logs, "\x1b") {
		t.Fatalf("session log is not clean Unicode: %q", logs)
	}
}
