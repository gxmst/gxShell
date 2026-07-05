package sshmanager

import (
	"errors"
	"io"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestSSHAddress(t *testing.T) {
	tests := []struct {
		name string
		host string
		port int
		want string
	}{
		{"hostname", "example.com", 22, "example.com:22"},
		{"ipv4", "127.0.0.1", 2222, "127.0.0.1:2222"},
		{"ipv6", "2001:db8::1", 22, "[2001:db8::1]:22"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sshAddress(tt.host, tt.port); got != tt.want {
				t.Errorf("sshAddress(%q, %d) = %q, want %q", tt.host, tt.port, got, tt.want)
			}
		})
	}
}

func TestLimitedBufferTruncates(t *testing.T) {
	buf := newLimitedBuffer(5)
	if n, err := buf.Write([]byte("hello")); err != nil || n != 5 {
		t.Fatalf("first Write n=%d err=%v, want n=5 err=nil", n, err)
	}
	if buf.Truncated() {
		t.Fatal("buffer should not be truncated at exact limit")
	}
	if n, err := buf.Write([]byte(" world")); err != nil || n != 6 {
		t.Fatalf("second Write n=%d err=%v, want n=6 err=nil", n, err)
	}
	if got := buf.String(); got != "hello" {
		t.Errorf("buffer content = %q, want %q", got, "hello")
	}
	if !buf.Truncated() {
		t.Fatal("buffer should report truncation after limit is exceeded")
	}
}

func TestLimitedBufferPartialWrite(t *testing.T) {
	buf := newLimitedBuffer(5)
	if n, err := buf.Write([]byte("hello world")); err != nil || n != len("hello world") {
		t.Fatalf("Write n=%d err=%v, want n=%d err=nil", n, err, len("hello world"))
	}
	if got := buf.String(); got != "hello" {
		t.Errorf("buffer content = %q, want %q", got, "hello")
	}
	if !buf.Truncated() {
		t.Fatal("buffer should report truncation after partial write")
	}
}

func TestAppendLine(t *testing.T) {
	if got := appendLine("", "stderr"); got != "stderr" {
		t.Errorf("appendLine empty base = %q, want stderr", got)
	}
	if got := appendLine("stdout", "stderr"); got != "stdout\nstderr" {
		t.Errorf("appendLine with base = %q, want stdout newline stderr", got)
	}
	if got := appendLine("stdout", ""); got != "stdout" {
		t.Errorf("appendLine empty line = %q, want stdout", got)
	}
}

func TestCommandExecutionResultDisplayOutput(t *testing.T) {
	result := CommandExecutionResult{
		Output:  "stdout\nstderr",
		Summary: "(exit code: 1)",
	}
	if got := result.Output; got != "stdout\nstderr" {
		t.Fatalf("Output = %q", got)
	}
	if got := result.DisplayOutput(); got != "stdout\nstderr\n(exit code: 1)" {
		t.Fatalf("DisplayOutput = %q", got)
	}
}

func TestLimitedBufferZeroLimitUsesLargeLimit(t *testing.T) {
	buf := newLimitedBuffer(0)
	data := strings.Repeat("x", 1024)
	if _, err := buf.Write([]byte(data)); err != nil {
		t.Fatalf("Write error: %v", err)
	}
	if got := buf.String(); got != data {
		t.Errorf("buffer content length = %d, want %d", len(got), len(data))
	}
	if buf.Truncated() {
		t.Fatal("zero limit should be treated as unlimited")
	}
}

func TestBenignShellWaitError(t *testing.T) {
	if !isBenignShellWaitError(&ssh.ExitMissingError{}) {
		t.Fatal("missing SSH exit status should be treated as a benign shell close")
	}
	if !isBenignShellWaitError(io.EOF) {
		t.Fatal("EOF should be treated as a benign shell close")
	}
	if isBenignShellWaitError(errors.New("permission denied")) {
		t.Fatal("unrelated errors should not be treated as benign")
	}
}
