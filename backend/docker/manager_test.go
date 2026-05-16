package docker

import "testing"

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
