package main

// This file contains the shared pre-execution safety policy (dangerous-command
// and sensitive-path blocklists, the read-only allowlist, and the confirmation
// gate) used by both the in-app AI assistant and the external CLI. It is kept
// separate from app.go so the policy can be reviewed and tested in isolation.

import (
	"fmt"
	"path"
	"regexp"
	"strings"
	"sync"
)

// dangerousCmdPatterns are anchored so a verb only matches as its own token —
// `dd\s+` as a bare substring used to block `git add .`, `useradd bob`, and
// `ldd /bin/ls`. Since a blocklist hit fires BEFORE the confirmation gate and
// offers no override, a false positive here hard-blocks a legitimate command.
// Two anchor shapes are used:
//   - token anchor `(^|[^\w-])`: the verb may appear anywhere but not inside a
//     longer word (still matches after `/`, quotes, backslashes, `;`).
//   - command-position anchor: bare system verbs (shutdown, reboot, ...) only
//     match at the start, after a chain operator, or after a wrapper like
//     sudo. As an argument (`last reboot`, `cat shutdown.log`) they pass here
//     and fall through to the normal confirmation gate, which is the real
//     defense line for anything not read-only.
const cmdPos = `(?:^|[;&|]\s*|\$\(\s*|` + "`" + `\s*|\b(?:sudo|doas|nohup|eval|exec)\s+)`

var dangerousCmdPatterns = []struct {
	pattern string
	reason  string
}{
	{`(?:^|[^\w-])rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\b|/\s|$)`, "destructive rm command"},
	{`(?:^|[^\w-])mkfs`, "filesystem format"},
	{`(?:^|[^\w-])dd\s+`, "raw disk write"},
	{`:\(\)\{\s*:\|:\&\s*\}\s*;`, "fork bomb"},
	{`>\s*/dev/sd`, "direct disk write"},
	{`chmod\s+(-R\s+)?0?777\s+/`, "overly permissive chmod on root"},
	{cmdPos + `shutdown\b`, "system shutdown"},
	{cmdPos + `reboot\b`, "system reboot"},
	{cmdPos + `init\s+[06]\b`, "init to runlevel 0/6"},
	{`systemctl\s+(stop|disable)\s+(ssh|sshd|network|systemd)`, "stopping critical services"},
	{`iptables\s+-F`, "flushing firewall rules"},
	{`(?:^|[^\w-])crontab\s+-r\b`, "removing crontab"},
	{cmdPos + `userdel\b`, "deleting user"},
	{`(?:^|[^\w-])passwd\s+root\b`, "changing root password"},
	{`(?:^|[^\w-])mv\s+.*\s*/dev/null`, "moving files to /dev/null"},
}

var dangerousCmdRegexps = sync.OnceValue(func() []struct {
	*regexp.Regexp
	reason string
} {
	result := make([]struct {
		*regexp.Regexp
		reason string
	}, len(dangerousCmdPatterns))
	for i, p := range dangerousCmdPatterns {
		result[i].Regexp = regexp.MustCompile(p.pattern)
		result[i].reason = p.reason
	}
	return result
})

type commandBlock struct {
	Kind   string
	Reason string
	Detail string
}

func (b commandBlock) Message() string {
	if b.Detail == "" {
		return b.Reason
	}
	return b.Reason + " (" + b.Detail + ")"
}

// checkDangerousCommand validates if a command is safe to execute.
func checkDangerousCommand(cmd string) (string, bool) {
	block, blocked := checkDangerousCommandBlock(cmd)
	if !blocked {
		return "", false
	}
	return block.Reason, true
}

func checkDangerousCommandBlock(cmd string) (commandBlock, bool) {
	trimmed := strings.TrimSpace(cmd)
	base := trimmed
	if idx := strings.Index(trimmed, " "); idx > 0 {
		base = trimmed[:idx]
	}
	directDangerous := map[string]string{
		"mkfs": "filesystem format", "shutdown": "system shutdown", "reboot": "system reboot",
		"userdel": "deleting user", "fdisk": "disk partitioning",
	}
	if reason, ok := directDangerous[base]; ok {
		return commandBlock{
			Kind:   "dangerous-command",
			Reason: reason,
			Detail: fmt.Sprintf("command starts with %q", base),
		}, true
	}
	for _, dr := range dangerousCmdRegexps() {
		if match := dr.FindString(cmd); match != "" {
			return commandBlock{
				Kind:   "dangerous-command",
				Reason: dr.reason,
				Detail: fmt.Sprintf("matched command fragment %q", strings.TrimSpace(match)),
			}, true
		}
	}
	return commandBlock{}, false
}

var sensitivePaths = []struct {
	pattern string
	reason  string
}{
	{"/etc/shadow", "password hashes"},
	{"/etc/gshadow", "group password hashes"},
	{"/etc/ssh/ssh_host_", "SSH private host keys"},
	{"/root/.ssh/id_", "SSH private keys"},
	{"/home/", "user home SSH private keys"},
	// Well-known credential stores. These are substring matches, so each catches
	// the file under any user's home as well as under /root. They are the same
	// class of secret as the SSH keys above: lexically a plain `cat` would be
	// classified read-only and executed by the CLI path without a confirmation,
	// so they must be blocked before the read-only shortcut runs.
	{"/.aws/credentials", "AWS credentials"},
	{"/.kube/config", "Kubernetes credentials"},
	{"/.docker/config.json", "Docker registry credentials"},
	{"/.netrc", "netrc credentials"},
	{"/.git-credentials", "stored git credentials"},
}

// checkSensitivePath validates if a path contains sensitive files. The input may
// be a full shell command, so it checks a few conservative normalizations to
// catch common shell/path obfuscation such as /etc//shadow, /etc/../etc/shadow,
// quoted path fragments, and backslash-escaped characters.
func checkSensitivePath(p string) (string, bool) {
	block, blocked := checkSensitivePathBlock(p)
	if !blocked {
		return "", false
	}
	return block.Reason, true
}

func checkSensitivePathBlock(p string) (commandBlock, bool) {
	for _, candidate := range sensitivePathCandidates(p) {
		lower := strings.ToLower(normalizeSensitivePathText(candidate))
		for _, sp := range sensitivePaths {
			pattern := strings.ToLower(sp.pattern)
			if pattern == "/home/" {
				if matched := privateSSHKeyReference(lower); matched != "" {
					return commandBlock{
						Kind:   "sensitive-path",
						Reason: sp.reason,
						Detail: fmt.Sprintf("matched sensitive path %q", matched),
					}, true
				}
				continue
			}
			if strings.Contains(lower, pattern) {
				return commandBlock{
					Kind:   "sensitive-path",
					Reason: sp.reason,
					Detail: fmt.Sprintf("matched sensitive path pattern %q", sp.pattern),
				}, true
			}
		}
	}
	return commandBlock{}, false
}

func sensitivePathCandidates(input string) []string {
	stripped := stripShellPathObfuscation(input)
	candidates := []string{input, stripped}
	for _, field := range strings.Fields(stripped) {
		candidates = append(candidates, field)
		if cleaned := cleanRemotePathToken(field); cleaned != "" {
			candidates = append(candidates, cleaned)
		}
	}
	return candidates
}

func stripShellPathObfuscation(s string) string {
	replacer := strings.NewReplacer("'", "", `"`, "", `\`, "")
	return replacer.Replace(s)
}

func normalizeSensitivePathText(s string) string {
	for strings.Contains(s, "//") {
		s = strings.ReplaceAll(s, "//", "/")
	}
	for strings.Contains(s, "/./") {
		s = strings.ReplaceAll(s, "/./", "/")
	}
	return s
}

func cleanRemotePathToken(token string) string {
	token = normalizeSensitivePathText(token)
	if token == "" {
		return ""
	}
	if strings.HasPrefix(token, "~/") {
		return path.Clean("/home/__self__/" + strings.TrimPrefix(token, "~/"))
	}
	if strings.HasPrefix(token, "~root/") {
		return path.Clean("/root/" + strings.TrimPrefix(token, "~root/"))
	}
	if strings.HasPrefix(token, "~") {
		if slash := strings.Index(token, "/"); slash > 1 {
			return path.Clean("/home/" + token[1:])
		}
	}
	if strings.HasPrefix(token, "/") {
		return path.Clean(token)
	}
	return ""
}

func containsPrivateSSHKeyReference(lower string) bool {
	return privateSSHKeyReference(lower) != ""
}

func privateSSHKeyReference(lower string) string {
	for _, field := range strings.Fields(lower) {
		field = normalizeSensitivePathText(field)
		if strings.Contains(field, "/.ssh/id_") && !strings.HasSuffix(field, ".pub") {
			return field
		}
	}
	return ""
}

// readOnlyCommands lists binaries that only inspect state. A command whose
// program name is in this set is allowed to run without an explicit human
// confirmation when the caller explicitly allows the read-only shortcut. The
// set is intentionally conservative: shell operators, quoting, expansion, and
// globbing are rejected separately by isReadOnlyCommand, so each entry only
// needs to be safe as a standalone command with literal arguments. Every entry
// here must be unable to mutate state OR execute another program even when
// given arbitrary flags. Commands with a known mutating flag (date -s, ss -K,
// dmesg -C, hostname NAME, sort -o, sed -i, find -exec) and command wrappers
// (env, command, xargs, sudo, watch, timeout, awk, sed, sh, ...) are deliberately
// excluded so they fall through to confirmation.
var readOnlyCommands = map[string]struct{}{
	"echo": {},
	// File content inspection
	"cat": {}, "tac": {}, "nl": {}, "head": {}, "tail": {}, "wc": {},
	"cksum": {}, "md5sum": {}, "sha1sum": {}, "sha256sum": {}, "sha512sum": {}, "zcat": {},
	// Read-only text search
	"grep": {}, "egrep": {}, "fgrep": {}, "zgrep": {},
	// Filesystem inspection
	"ls": {}, "pwd": {}, "df": {}, "du": {}, "stat": {}, "file": {},
	"realpath": {}, "readlink": {}, "basename": {}, "dirname": {}, "tree": {},
	// Process / network / environment inspection
	"ps": {}, "pgrep": {}, "pstree": {}, "lsof": {}, "netstat": {}, "getent": {}, "printenv": {},
	// System / identity info
	"uptime": {}, "uname": {}, "whoami": {}, "id": {}, "arch": {}, "nproc": {},
	"w": {}, "who": {}, "last": {}, "groups": {},
	"lscpu": {}, "lsblk": {}, "lsusb": {}, "lspci": {}, "free": {}, "vmstat": {}, "iostat": {}, "mpstat": {},
	// Locators
	"which": {}, "whereis": {}, "type": {},
}

// isReadOnlyCommand reports whether cmd is a single read-only command that may
// run without a confirmation prompt. It is deliberately conservative: any shell
// metacharacter that could chain, redirect, background or substitute commands
// disqualifies the command (returning false), as does an environment-assignment
// prefix or a program name that is not on the read-only allowlist. A false
// result is always safe because it only means the caller must confirm.
func isReadOnlyCommand(cmd string) bool {
	trimmed := strings.TrimSpace(cmd)
	if trimmed == "" {
		return false
	}
	// Reject anything that can chain, redirect, background, substitute, quote,
	// escape, expand paths, or glob. That is stricter than a shell parser, but
	// false only means the caller asks for confirmation.
	if strings.ContainsAny(trimmed, ";|&<>`$\\'\"~*?[]{}\n\r") {
		return false
	}
	first := strings.Fields(trimmed)[0]
	// Reject an environment-assignment prefix such as `FOO=bar cmd`.
	if strings.Contains(first, "=") {
		return false
	}
	// Only bare command names qualify for the no-confirm shortcut. A path such
	// as /tmp/ls may point at an arbitrary executable whose basename merely
	// resembles a trusted read-only utility. Path-qualified commands still work,
	// but they go through the normal native confirmation gate.
	if strings.Contains(first, "/") {
		return false
	}
	_, ok := readOnlyCommands[first]
	return ok
}

// guardCommand applies the shared pre-execution safety policy used by both the
// in-app AI assistant and the external CLI: the dangerous-command and
// sensitive-path blocklists, then a human confirmation gate. When
// allowReadOnlyWithoutConfirm is true, commands on the read-only allowlist skip
// confirmation; every other command requires confirm() to return true. confirm
// must be backed by a native dialog the renderer cannot forge. It returns
// ok=true when the command may run; when ok=false, reason is a short
// human-readable explanation (a blocklist hit or a declined prompt).
//
// Ordering matters: the sensitive-path check runs before the read-only check so
// that, e.g., `cat /etc/shadow` is blocked rather than waved through as a read.
func guardCommand(command string, allowReadOnlyWithoutConfirm bool, confirm func() bool) (reason string, ok bool) {
	block, allowed := guardCommandReport(command, allowReadOnlyWithoutConfirm, confirm)
	if !allowed {
		return block.Message(), false
	}
	return "", true
}

func guardCommandReport(command string, allowReadOnlyWithoutConfirm bool, confirm func() bool) (commandBlock, bool) {
	if block, blocked := checkCommandPreflightBlock(command); blocked {
		return block, false
	}
	if allowReadOnlyWithoutConfirm && isReadOnlyCommand(command) {
		return commandBlock{}, true
	}
	if !confirm() {
		return commandBlock{Kind: "confirmation", Reason: "user declined execution"}, false
	}
	return commandBlock{}, true
}

func checkCommandPreflightBlock(command string) (commandBlock, bool) {
	if block, blocked := checkDangerousCommandBlock(command); blocked {
		return block, true
	}
	if block, blocked := checkSensitivePathBlock(command); blocked {
		return block, true
	}
	return commandBlock{}, false
}
