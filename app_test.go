package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"gxShell/backend/ai"
	"gxShell/backend/config"
	"gxShell/backend/logger"
	"gxShell/backend/types"
)

func TestAIToolAuthorizationClaimOnce(t *testing.T) {
	app := NewApp()
	app.registerAuthorizedAiToolCalls("sess-1", []ai.ToolCall{
		{
			ID:   "call-1",
			Type: "function",
			Function: ai.FunctionCall{
				Name:      "execute_command",
				Arguments: `{"command":"uptime"}`,
			},
		},
	})

	if _, err := app.claimAuthorizedAiToolCall("sess-2", "call-1"); err == nil {
		t.Fatal("claim from a different session should fail")
	}

	toolCall, err := app.claimAuthorizedAiToolCall("sess-1", "call-1")
	if err != nil {
		t.Fatalf("claimAuthorizedAiToolCall error: %v", err)
	}
	if toolCall.ToolName != "execute_command" || toolCall.Arguments != `{"command":"uptime"}` {
		t.Fatalf("claimed tool = %#v, want execute_command with original arguments", toolCall)
	}

	if _, err := app.claimAuthorizedAiToolCall("sess-1", "call-1"); err == nil {
		t.Fatal("second claim should fail after one-time consumption")
	}
}

func TestAIToolAuthorizationIgnoresUnknownTools(t *testing.T) {
	app := NewApp()
	app.registerAuthorizedAiToolCalls("sess-1", []ai.ToolCall{
		{
			ID:   "call-1",
			Type: "function",
			Function: ai.FunctionCall{
				Name:      "unknown_tool",
				Arguments: `{}`,
			},
		},
	})

	if _, err := app.claimAuthorizedAiToolCall("sess-1", "call-1"); err == nil {
		t.Fatal("unknown tools should not be authorized")
	}
}

func TestAIToolAuthorizationExpires(t *testing.T) {
	app := NewApp()
	key := aiToolAuthorizationKey("sess-1", "call-1")
	app.aiTools[key] = authorizedAIToolCall{
		SessionID:  "sess-1",
		ToolCallID: "call-1",
		ToolName:   "read_file",
		Arguments:  `{"path":"/var/log/syslog"}`,
		ExpiresAt:  time.Now().Add(-time.Second),
	}

	if _, err := app.claimAuthorizedAiToolCall("sess-1", "call-1"); err == nil {
		t.Fatal("expired tool call should not be claimable")
	}
	if _, ok := app.aiTools[key]; ok {
		t.Fatal("expired tool call should be pruned")
	}
}

func TestDiscardAuthorizedAiToolCalls(t *testing.T) {
	app := NewApp()
	app.registerAuthorizedAiToolCalls("sess-1", []ai.ToolCall{
		{ID: "call-1", Type: "function", Function: ai.FunctionCall{Name: "read_file", Arguments: `{"path":"/tmp/a"}`}},
	})
	app.registerAuthorizedAiToolCalls("sess-2", []ai.ToolCall{
		{ID: "call-2", Type: "function", Function: ai.FunctionCall{Name: "read_file", Arguments: `{"path":"/tmp/b"}`}},
	})

	app.discardAuthorizedAiToolCalls("sess-1")

	if _, err := app.claimAuthorizedAiToolCall("sess-1", "call-1"); err == nil {
		t.Fatal("discarded session tool call should fail")
	}
	if _, err := app.claimAuthorizedAiToolCall("sess-2", "call-2"); err != nil {
		t.Fatalf("other session tool call should remain claimable: %v", err)
	}
}

func TestReadLocalFileRequiresAllowedFile(t *testing.T) {
	app := NewApp()
	dir := t.TempDir()
	path := filepath.Join(dir, "note.md")
	if err := os.WriteFile(path, []byte("# hello"), 0600); err != nil {
		t.Fatal(err)
	}

	if _, err := app.ReadLocalFile(path); err == nil {
		t.Fatal("unallowed file should not be readable")
	}

	allowed := app.allowFile(path)
	got, err := app.ReadLocalFile(allowed)
	if err != nil {
		t.Fatalf("allowed file should be readable: %v", err)
	}
	if got != "# hello" {
		t.Fatalf("content = %q, want %q", got, "# hello")
	}
}

func TestListMarkdownFilesInDirAuthorizesOnlyMarkdownSiblings(t *testing.T) {
	app := NewApp()
	dir := t.TempDir()
	first := filepath.Join(dir, "first.md")
	second := filepath.Join(dir, "second.MD")
	text := filepath.Join(dir, "notes.txt")
	for path, content := range map[string]string{
		first:  "# first",
		second: "# second",
		text:   "plain text",
	} {
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}

	app.allowFile(first)
	files, err := app.ListMarkdownFilesInDir(first)
	if err != nil {
		t.Fatalf("ListMarkdownFilesInDir error: %v", err)
	}
	if len(files) != 2 {
		t.Fatalf("markdown files = %#v, want 2 files", files)
	}
	if _, err := app.ReadLocalFile(second); err != nil {
		t.Fatalf("markdown sibling should be authorized: %v", err)
	}
	if _, err := app.ReadLocalFile(text); err == nil {
		t.Fatal("non-markdown sibling should not be authorized")
	}
}

func TestListMarkdownFilesInDirRejectsNonMarkdownFile(t *testing.T) {
	app := NewApp()
	path := filepath.Join(t.TempDir(), "notes.txt")
	if err := os.WriteFile(path, []byte("plain text"), 0600); err != nil {
		t.Fatal(err)
	}
	app.allowFile(path)

	if _, err := app.ListMarkdownFilesInDir(path); err == nil {
		t.Fatal("non-markdown file should be rejected")
	}
}

func TestIsReadOnlyCommand(t *testing.T) {
	readOnly := []string{
		"uptime",
		"ls -la /var/log",
		"df -h",
		"cat /var/log/syslog",
		"grep -r needle /etc/hosts",
		"/usr/bin/ls", // path-qualified binary
	}
	for _, cmd := range readOnly {
		if !isReadOnlyCommand(cmd) {
			t.Errorf("expected read-only: %q", cmd)
		}
	}

	notReadOnly := []string{
		"",                        // empty
		"   ",                     // blank
		"rm -rf /tmp",             // not on allowlist
		"systemctl restart nginx", // not on allowlist
		"sed -i s/a/b/ f",         // mutating, excluded
		"env ls",                  // command wrapper, not allowlisted
		"sudo ls",                 // escalation wrapper
		"FOO=bar ls",              // env-assignment prefix
		"ls; rm -rf /",            // chaining
		"cat a | grep b",          // pipe
		"echo hi > /etc/x",        // redirect
		"echo $(whoami)",          // command substitution
		"echo \x60id\x60",         // backtick substitution
		"ls && rm x",              // and-chain
		"grep 'needle' /tmp/file", // quoting can hide shell semantics
		"cat /var/log/*.log",      // globbing can hide sensitive paths
		"cat ~/.ssh/id_rsa",       // tilde expansion can hide sensitive paths
		"cat $HOME/.ssh/id_rsa",   // variable expansion can hide sensitive paths
	}
	for _, cmd := range notReadOnly {
		if isReadOnlyCommand(cmd) {
			t.Errorf("expected NOT read-only: %q", cmd)
		}
	}
}

func TestGuardCommand(t *testing.T) {
	neverConfirm := func() bool {
		t.Helper()
		t.Fatal("confirm must not be called")
		return false
	}

	// Dangerous commands are blocked before any confirmation.
	if reason, ok := guardCommand("rm -rf /", true, neverConfirm); ok || reason == "" {
		t.Fatalf("dangerous command should be blocked, got ok=%v reason=%q", ok, reason)
	}

	// Sensitive paths are blocked even though `cat` is read-only: the
	// sensitive-path check must run before the read-only shortcut.
	for _, cmd := range []string{
		"cat /etc/shadow",
		"cat /etc//shadow",
		"cat /etc/../etc/shadow",
		"cat /etc/sha'dow'",
		"cat ~/.ssh/id_rsa",
		"cat /home/alice/.ssh/./id_rsa",
		"cat /home/alice/.ssh/id_rsa.pub.bak",
	} {
		if reason, ok := guardCommand(cmd, true, neverConfirm); ok || reason == "" {
			t.Fatalf("sensitive path should be blocked for %q, got ok=%v reason=%q", cmd, ok, reason)
		}
	}

	// Read-only commands run without calling confirm.
	if reason, ok := guardCommand("uptime", true, neverConfirm); !ok || reason != "" {
		t.Fatalf("read-only command should run without confirm, got ok=%v reason=%q", ok, reason)
	}
	if reason, ok := guardCommand("cat /home/alice/.ssh/id_rsa.pub", true, neverConfirm); !ok || reason != "" {
		t.Fatalf("public key read should be allowed without confirm, got ok=%v reason=%q", ok, reason)
	}

	// AI tools pass allowReadOnlyWithoutConfirm=false, so even read-only
	// commands still require a native confirmation in that path.
	aiConfirmed := 0
	if reason, ok := guardCommand("uptime", false, func() bool { aiConfirmed++; return true }); !ok || reason != "" {
		t.Fatalf("AI read-only command should run after confirm, got ok=%v reason=%q", ok, reason)
	}
	if aiConfirmed != 1 {
		t.Fatalf("AI read-only command should confirm exactly once, got %d", aiConfirmed)
	}

	// Non-read-only commands require confirmation; an approval lets them run.
	confirmed := 0
	if reason, ok := guardCommand("touch /tmp/x", true, func() bool { confirmed++; return true }); !ok || reason != "" {
		t.Fatalf("approved command should run, got ok=%v reason=%q", ok, reason)
	}
	if confirmed != 1 {
		t.Fatalf("confirm should be called exactly once, got %d", confirmed)
	}

	// A declined confirmation blocks the command.
	if reason, ok := guardCommand("touch /tmp/x", true, func() bool { return false }); ok || reason != "user declined execution" {
		t.Fatalf("declined command should be blocked, got ok=%v reason=%q", ok, reason)
	}
}

func TestMigrateCliProfileFlagsMovesLegacyValues(t *testing.T) {
	app := NewApp()
	dir := t.TempDir()
	// Seed a profiles.json written under the old aiEnabled/aiAlias keys.
	legacy := `[{"id":"p1","aiEnabled":true,"aiAlias":"prod-web"},{"id":"p2","aiEnabled":false}]`
	if err := os.WriteFile(filepath.Join(dir, "profiles.json"), []byte(legacy), 0600); err != nil {
		t.Fatal(err)
	}
	// NewStoreAt's ensureDefaults only writes profiles.json when absent, so the
	// legacy seed above survives.
	store, err := config.NewStoreAt(dir)
	if err != nil {
		t.Fatal(err)
	}
	app.store = store
	app.log = logger.New(dir)

	app.migrateCliProfileFlags()

	profiles, err := store.ListProfiles()
	if err != nil {
		t.Fatal(err)
	}
	var p1 *types.Profile
	for i := range profiles {
		if profiles[i].ID == "p1" {
			p1 = &profiles[i]
		}
	}
	if p1 == nil {
		t.Fatal("p1 missing after migration")
	}
	if !p1.CliEnabled || p1.CliAlias != "prod-web" {
		t.Fatalf("legacy flags not migrated: %#v", p1)
	}
	if p1.LegacyAIEnabled || p1.LegacyAIAlias != "" {
		t.Fatalf("legacy fields not cleared: %#v", p1)
	}
}

func TestValidateProfileCliSettings(t *testing.T) {
	existing := []types.Profile{
		{ID: "p1", CliEnabled: true, CliAlias: "prod-web"},
		{ID: "p2", CliEnabled: false, CliAlias: "dev-box"},
	}

	if err := validateProfileCliSettings(types.Profile{ID: "p3", CliEnabled: true, CliAlias: "  staging  "}, existing); err != nil {
		t.Fatalf("unique alias should be accepted: %v", err)
	}
	if err := validateProfileCliSettings(types.Profile{ID: "p3", CliEnabled: true, CliAlias: ""}, existing); err == nil {
		t.Fatal("enabled profile without alias should be rejected")
	}
	if err := validateProfileCliSettings(types.Profile{ID: "p3", CliEnabled: true, CliAlias: "PROD-WEB"}, existing); err == nil {
		t.Fatal("duplicate alias should be rejected case-insensitively")
	}
	if err := validateProfileCliSettings(types.Profile{ID: "p3", CliEnabled: true, CliAlias: "dev-box"}, existing); err != nil {
		t.Fatalf("alias on disabled profile should not reserve CLI name: %v", err)
	}
}
