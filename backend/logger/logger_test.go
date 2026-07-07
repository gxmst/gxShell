package logger

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRedactKeyValueAndPassword(t *testing.T) {
	cases := map[string]string{
		`password=hunter2`:     `password=<redacted>`,
		`password: hunter2`:    `password: <redacted>`,
		`"password":"hunter2"`: `"password":"<redacted>"`,
		`passphrase=secret`:    `passphrase=<redacted>`,
		`api_key=abc123`:       `api_key=<redacted>`,
		`token: bearer xyz`:    `token: <redacted> xyz`,
	}
	for in, want := range cases {
		got := redact(in)
		if got != want {
			t.Errorf("redact(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRedactLeavesNonSensitiveText(t *testing.T) {
	for _, in := range []string{
		`uptime`,
		`ls -la /var/log`,
		`docker ps -a`,
		`echo hello world`,
	} {
		if got := redact(in); got != in {
			t.Errorf("redact(%q) = %q, want unchanged", in, got)
		}
	}
}

func TestRedactMysqlInlinePassword(t *testing.T) {
	cases := map[string]string{
		`mysql -phunter2 -u root`:        `mysql -p<redacted> -u root`,
		`mysqldump -psecret dbname`:      `mysqldump -p<redacted> dbname`,
		`mariadb -pp@ss db`:              `mariadb -p<redacted> db`,
		`mysql -u root -phunter2 -e "x"`: `mysql -u root -p<redacted> -e "x"`,
	}
	for in, want := range cases {
		got := redact(in)
		if got != want {
			t.Errorf("redact(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRedactDoesNotManglePortFlag(t *testing.T) {
	// -p followed by a port number for non-database CLIs must not be touched.
	for _, in := range []string{
		`ssh -p 2222 host`,
		`curl http://host:8080`,
	} {
		if got := redact(in); got != in {
			t.Errorf("redact(%q) = %q, want unchanged", in, got)
		}
	}
}

func TestCommandAuditFieldsSummarizesByDefault(t *testing.T) {
	t.Setenv(fullCommandLogEnv, "")
	command := "echo password=hunter2\n" + strings.Repeat("x", commandPreviewLimit+20)

	fields := CommandAuditFields(command)
	if _, ok := fields["command"]; ok {
		t.Fatal("full command was logged without debug opt-in")
	}
	if fields["commandHash"] == "" {
		t.Fatal("missing command hash")
	}
	if fields["commandLength"].(int) != len(strings.TrimSpace(command)) {
		t.Fatalf("commandLength = %v, want %d", fields["commandLength"], len(strings.TrimSpace(command)))
	}
	preview := fields["commandPreview"].(string)
	if strings.Contains(preview, "hunter2") {
		t.Fatalf("preview was not redacted: %q", preview)
	}
	if !strings.Contains(preview, "password=<redacted>") {
		t.Fatalf("preview missing redacted secret: %q", preview)
	}
	if len(preview) > commandPreviewLimit {
		t.Fatalf("preview length = %d, want <= %d", len(preview), commandPreviewLimit)
	}
	if fields["commandTruncated"] != true {
		t.Fatalf("commandTruncated = %v, want true", fields["commandTruncated"])
	}
}

func TestCommandAuditFieldsCanIncludeFullCommandForDebugging(t *testing.T) {
	t.Setenv(fullCommandLogEnv, "1")
	command := "uptime"

	fields := CommandAuditFields(command)
	if fields["command"] != command {
		t.Fatalf("command = %v, want %q", fields["command"], command)
	}
}

func TestWriteToFileRotatesLogs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	if err := os.WriteFile(path, []byte(strings.Repeat("a", maxLogSize-2)), 0600); err != nil {
		t.Fatalf("seed log: %v", err)
	}

	writeToFile(path, "hello\n")

	if _, err := os.Stat(path + ".1"); err != nil {
		t.Fatalf("rotated log missing: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read new log: %v", err)
	}
	if string(data) != "hello\n" {
		t.Fatalf("new log = %q, want hello", string(data))
	}
}
