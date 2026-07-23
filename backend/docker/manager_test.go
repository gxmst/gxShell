package docker

import (
	"sync/atomic"
	"testing"
)

func TestSanitizeDockerArg(t *testing.T) {
	tests := []struct {
		name    string
		arg     string
		wantErr bool
	}{
		{"valid hex id", "abc123def456", false},
		{"valid with dots", "my-container.v2", false},
		{"valid with dashes", "my-container-2", false},
		{"valid with underscores", "my_container_2", false},
		{"empty string", "", true},
		{"shell injection semicolon", "abc;rm -rf", true},
		{"shell injection backtick", "abc`whoami`", true},
		{"shell injection dollar", "abc$(whoami)", true},
		{"shell injection pipe", "abc|cat", true},
		{"shell injection ampersand", "abc&&ls", true},
		{"shell injection space", "abc def", true},
		{"path traversal", "../etc/passwd", true},
		{"newline injection", "abc\nwhoami", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := sanitizeDockerArg(tt.arg)
			if (err != nil) != tt.wantErr {
				t.Errorf("sanitizeDockerArg(%q) error = %v, wantErr %v", tt.arg, err, tt.wantErr)
			}
		})
	}
}

func TestSanitizeTailArg(t *testing.T) {
	tests := []struct {
		name    string
		tail    int
		wantErr bool
	}{
		{"zero", 0, false},
		{"typical", 200, false},
		{"upper bound", 100000, false},
		{"negative", -1, true},
		{"too large", 100001, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := sanitizeTailArg(tt.tail)
			if (err != nil) != tt.wantErr {
				t.Errorf("sanitizeTailArg(%d) error = %v, wantErr %v", tt.tail, err, tt.wantErr)
			}
		})
	}
}

func TestSanitizeLogStreamID(t *testing.T) {
	for _, id := range []string{"docker-123", "2da950af-f4a6-4e8d-b0f6-43cf3bd32c2b", "stream_1"} {
		if err := sanitizeLogStreamID(id); err != nil {
			t.Fatalf("sanitizeLogStreamID(%q): %v", id, err)
		}
	}
	for _, id := range []string{"", "bad/id", "bad id", "bad;id"} {
		if err := sanitizeLogStreamID(id); err == nil {
			t.Fatalf("sanitizeLogStreamID(%q) unexpectedly succeeded", id)
		}
	}
}

func TestLogStreamReplacementAndExactStop(t *testing.T) {
	m := NewManager(nil)
	var firstCancelled atomic.Int32
	var secondCancelled atomic.Int32
	first := &logStream{id: "first", key: "session:container", cancel: func() { firstCancelled.Add(1) }}
	second := &logStream{id: "second", key: "session:container", cancel: func() { secondCancelled.Add(1) }}

	if err := m.activateLogStream(first); err != nil {
		t.Fatal(err)
	}
	if err := m.activateLogStream(second); err != nil {
		t.Fatal(err)
	}
	if got := firstCancelled.Load(); got != 1 {
		t.Fatalf("replaced stream cancel count = %d, want 1", got)
	}

	// A stale UI stop names the old stream and must not affect its successor.
	m.StopContainerLogs("first")
	if got := secondCancelled.Load(); got != 0 {
		t.Fatalf("stale stop cancelled replacement %d times", got)
	}
	if m.logStreams["second"] != second {
		t.Fatal("replacement stream is no longer active")
	}

	m.StopContainerLogs("second")
	if got := secondCancelled.Load(); got != 1 {
		t.Fatalf("exact stop cancel count = %d, want 1", got)
	}
	if len(m.logStreams) != 0 || len(m.logByKey) != 0 {
		t.Fatalf("stream indexes not cleaned up: streams=%d keys=%d", len(m.logStreams), len(m.logByKey))
	}
}

func TestParseDockerTime(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  int64
	}{
		{"RFC3339", "2024-01-15T10:30:00Z", 1705314600},
		{"empty string", "", 0},
		{"invalid format", "not-a-date", 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseDockerTime(tt.input)
			if got != tt.want {
				t.Errorf("parseDockerTime(%q) = %d, want %d", tt.input, got, tt.want)
			}
		})
	}
}

func TestParseContainerJSON(t *testing.T) {
	raw := `[{
		"Id": "abc123def456789",
		"Names": ["/my-container"],
		"Image": "nginx:latest",
		"State": "running",
		"Status": "Up 2 hours",
		"Ports": [{"IP":"0.0.0.0","PrivatePort":80,"PublicPort":8080,"Type":"tcp"}],
		"Created": 1705312200
	}]`

	containers, err := ParseContainerJSON(raw)
	if err != nil {
		t.Fatalf("ParseContainerJSON error: %v", err)
	}
	if len(containers) != 1 {
		t.Fatalf("expected 1 container, got %d", len(containers))
	}
	c := containers[0]
	if c.ID != "abc123def456" {
		t.Errorf("ID = %q, want %q", c.ID, "abc123def456")
	}
	if len(c.Names) != 1 || c.Names[0] != "my-container" {
		t.Errorf("Names = %v, want [my-container]", c.Names)
	}
	if c.Image != "nginx:latest" {
		t.Errorf("Image = %q, want %q", c.Image, "nginx:latest")
	}
	if c.State != "running" {
		t.Errorf("State = %q, want %q", c.State, "running")
	}
}
