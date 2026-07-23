package main

import (
	"strings"
	"testing"

	sshmanager "gxShell/backend/ssh"
)

func TestBuildSecretExecutionScriptInjectsWithoutChangingCommand(t *testing.T) {
	script := buildSecretExecutionScript(map[string]string{"API_KEY": "abc'123"}, "curl -H \"Authorization: Bearer $API_KEY\" https://example.test", "")
	if !strings.Contains(script, `export API_KEY='abc'\''123'`) {
		t.Fatalf("secret was not shell quoted: %q", script)
	}
	if !strings.Contains(script, `Authorization: Bearer $API_KEY`) {
		t.Fatalf("command changed: %q", script)
	}
}

func TestRedactCommandExecutionResultRemovesResolvedSecret(t *testing.T) {
	result := sshmanager.CommandExecutionResult{
		Stdout: "abc123\n", Stderr: "Authorization: Bearer abc123",
		Output: "abc123", Summary: "token=abc123", Error: "abc123 failed",
	}
	redactCommandExecutionResult(&result, map[string]string{"API_KEY": "abc123"})
	for name, value := range map[string]string{
		"stdout": result.Stdout, "stderr": result.Stderr, "output": result.Output,
		"summary": result.Summary, "error": result.Error,
	} {
		if strings.Contains(value, "abc123") {
			t.Fatalf("%s leaked secret: %q", name, value)
		}
	}
}
