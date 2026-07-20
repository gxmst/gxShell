package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestNormalizeScriptInputStripsBOMAndNormalizesNewlines(t *testing.T) {
	input := append([]byte{0xef, 0xbb, 0xbf}, []byte("printf hi\r\ncat <<'PY'\r\nprint(1)\r\nPY\r")...)
	got := normalizeScriptInput(input)
	want := "printf hi\ncat <<'PY'\nprint(1)\nPY\n"
	if got != want {
		t.Fatalf("normalizeScriptInput = %q, want %q", got, want)
	}
}

func TestStripTrailingFlagsOnlyConsumesTrailingFlags(t *testing.T) {
	args, opts, err := stripTrailingFlags([]string{"cmd", "--json", "literal"}, cliOptions{})
	if err != nil {
		t.Fatalf("stripTrailingFlags error: %v", err)
	}
	if opts.json {
		t.Fatal("middle --json should be left as a command argument")
	}
	if !reflect.DeepEqual(args, []string{"cmd", "--json", "literal"}) {
		t.Fatalf("args = %#v", args)
	}

	args, opts, err = stripTrailingFlags([]string{"cmd", "--timeout", "2m", "--json"}, cliOptions{})
	if err != nil {
		t.Fatalf("stripTrailingFlags trailing error: %v", err)
	}
	if !opts.json || opts.timeout == 0 {
		t.Fatalf("expected trailing flags to be parsed, opts=%#v", opts)
	}
	if !reflect.DeepEqual(args, []string{"cmd"}) {
		t.Fatalf("trailing args = %#v", args)
	}
}

func TestScriptAndJobFlagsParse(t *testing.T) {
	args, opts, err := stripTrailingFlags([]string{"script.sh", "--shell", "bash", "--detach"}, cliOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(args, []string{"script.sh"}) || opts.shell != "bash" || !opts.detach {
		t.Fatalf("args=%#v opts=%#v", args, opts)
	}

	args, opts, err = parseLeadingFlags([]string{"--follow", "server", "uptime"}, cliOptions{})
	if err != nil || !opts.follow || !reflect.DeepEqual(args, []string{"server", "uptime"}) {
		t.Fatalf("args=%#v opts=%#v err=%v", args, opts, err)
	}
}

func TestAllowedShellAndRemoteSpec(t *testing.T) {
	if !isAllowedShell("bash") || isAllowedShell("bash -c") || isAllowedShell("powershell") {
		t.Fatal("shell allowlist is not strict")
	}
	server, remotePath, err := parseRemoteSpec("2:/var/lib/app/config.yaml")
	if err != nil || server != "2" || remotePath != "/var/lib/app/config.yaml" {
		t.Fatalf("server=%q path=%q err=%v", server, remotePath, err)
	}
	if _, _, err := parseRemoteSpec("missing-colon"); err == nil {
		t.Fatal("invalid remote spec was accepted")
	}
}

func TestParseTimeoutValidatesRange(t *testing.T) {
	if _, err := parseTimeout("500ms"); err == nil {
		t.Fatal("500ms timeout should be rejected")
	}
	if _, err := parseTimeout("31m"); err == nil {
		t.Fatal("31m timeout should be rejected")
	}
	if got, err := parseTimeout("2m"); err != nil || got.String() != "2m0s" {
		t.Fatalf("2m timeout = %v, err=%v", got, err)
	}
}

func TestNormalizeExecResultMovesSyntheticOutputToSummary(t *testing.T) {
	result := map[string]any{
		"exitCode": float64(1),
		"stdout":   "",
		"stderr":   "",
		"output":   "(exit code: 1)",
	}
	normalizeExecResult(result)
	if got := result["output"]; got != "" {
		t.Fatalf("output = %#v, want empty", got)
	}
	if got := result["summary"]; got != "(exit code: 1)" {
		t.Fatalf("summary = %#v", got)
	}

	timeout := map[string]any{
		"error":  "remote command timeout",
		"output": "error: remote command timeout",
	}
	normalizeExecResult(timeout)
	if got := timeout["output"]; got != "" {
		t.Fatalf("timeout output = %#v, want empty", got)
	}
	if got := timeout["summary"]; got != "error: remote command timeout" {
		t.Fatalf("timeout summary = %#v", got)
	}
}

func TestBlockedMessagePrefersStructuredReason(t *testing.T) {
	result := map[string]any{
		"error":  "BLOCKED: raw disk write (matched command fragment \"dd\")",
		"reason": "raw disk write",
		"detail": "matched command fragment \"dd\"",
	}
	if got := blockedMessage(result); got != "raw disk write" {
		t.Fatalf("blockedMessage = %q", got)
	}

	fallback := map[string]any{"error": "BLOCKED: password hashes"}
	if got := blockedMessage(fallback); got != "password hashes" {
		t.Fatalf("fallback blockedMessage = %q", got)
	}
}

func TestTimeoutHintMessage(t *testing.T) {
	result := map[string]any{
		"timeoutMs": float64(120000),
	}
	got := timeoutHintMessage(result)
	if !strings.Contains(got, "2m0s remote timeout") || !strings.Contains(got, "--timeout 10m") {
		t.Fatalf("timeoutHintMessage = %q", got)
	}

	custom := map[string]any{"timeoutHint": "custom timeout hint"}
	if got := timeoutHintMessage(custom); got != "custom timeout hint" {
		t.Fatalf("custom timeoutHintMessage = %q", got)
	}
}

func TestPathContainsDir(t *testing.T) {
	dir := t.TempDir()
	child := filepath.Join(dir, "child")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	pathEnv := strings.Join([]string{filepath.Join(dir, "other"), child}, string(os.PathListSeparator))
	if !pathContainsDir(pathEnv, child) {
		t.Fatalf("expected PATH to contain %q", child)
	}
	if pathContainsDir(pathEnv, filepath.Join(dir, "missing")) {
		t.Fatal("unexpected PATH match for missing directory")
	}
}
