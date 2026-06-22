package main

import (
	"reflect"
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
