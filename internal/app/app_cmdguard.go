package app

// This file contains the legacy known-pattern preflight checks used by the
// in-app AI assistant and by sensitive-path checks for transfer/copy features.
// External CLI exec requests use the behaviour-based T0-T3 classifier in
// app_cmdtier.go instead. The helpers remain isolated here so both policies can
// be reviewed and tested without implying that either one is a sandbox.

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
	if detail, blocked := checkDangerousRemove(cmd, 0); blocked {
		return commandBlock{
			Kind:   "dangerous-command",
			Reason: "destructive rm command",
			Detail: detail,
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

var criticalRemoveRoots = []string{
	"/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64",
	"/opt", "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var",
}

var criticalRemoveDescendantRoots = []string{
	"/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64",
	"/opt", "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var",
}

// checkDangerousRemove keeps an unoverrideable guard around ambiguous or
// system-level removals. A removal with a clear ordinary target (for example,
// rm -rf node_modules) falls through to the native confirmation gate.
func checkDangerousRemove(command string, depth int) (string, bool) {
	if depth > 8 {
		return "nested shell command is too deep to validate safely", true
	}
	for _, segment := range splitShellCommandSegments(command) {
		cleaned := stripShellPathObfuscation(segment)
		fields := strings.Fields(cleaned)
		if script, ok := wrappedShellScript(fields); ok {
			if detail, blocked := checkDangerousRemove(script, depth+1); blocked {
				return detail, true
			}
		}
		i := forcedRemoveCommandIndex(fields)
		if i < 0 {
			continue
		}
		forced := false
		targets := make([]string, 0, 1)
		for j := i + 1; j < len(fields); j++ {
			field := strings.Trim(fields[j], ";,|&`()")
			if field == "" {
				continue
			}
			if strings.HasPrefix(field, ">") || strings.HasPrefix(field, "<") {
				break
			}
			if field == "--" {
				continue
			}
			if strings.HasPrefix(field, "--") {
				if field == "--force" {
					forced = true
				}
				continue
			}
			if strings.HasPrefix(field, "-") && len(field) > 1 {
				forced = forced || strings.Contains(field[1:], "f")
				continue
			}
			targets = append(targets, field)
		}
		if len(targets) == 0 {
			if forced {
				return "forced removal has no explicit target", true
			}
			continue
		}
		for _, target := range targets {
			target = strings.Trim(target, ";,|&`()")
			if strings.HasPrefix(target, "~") || strings.ContainsAny(target, "${}") || hasUnscopedRemoveGlob(target) {
				return fmt.Sprintf("ambiguous removal target %q", target), true
			}
			cleanTarget := path.Clean(target)
			if cleanTarget == "." || cleanTarget == ".." || strings.HasPrefix(cleanTarget, "../") {
				return fmt.Sprintf("ambiguous removal target %q", target), true
			}
			if cleanTarget == "/" {
				return "removal targets filesystem root", true
			}
			for _, root := range criticalRemoveRoots {
				if cleanTarget == root {
					return fmt.Sprintf("removal targets critical path %q", cleanTarget), true
				}
			}
			for _, root := range criticalRemoveDescendantRoots {
				if strings.HasPrefix(cleanTarget, root+"/") {
					return fmt.Sprintf("removal targets critical path %q", cleanTarget), true
				}
			}
			if isHomeDirectoryRoot(cleanTarget) {
				return fmt.Sprintf("removal targets a user home directory %q", cleanTarget), true
			}
			if cleanTarget == "/etc/ssh" || strings.HasPrefix(cleanTarget, "/etc/ssh/") {
				return fmt.Sprintf("removal targets critical path %q", cleanTarget), true
			}
			if strings.HasSuffix(cleanTarget, "/.ssh") || strings.Contains(cleanTarget, "/.ssh/") {
				return fmt.Sprintf("removal targets SSH credentials path %q", cleanTarget), true
			}
		}
	}
	return "", false
}

func isHomeDirectoryRoot(target string) bool {
	if !strings.HasPrefix(target, "/home/") {
		return false
	}
	remainder := strings.TrimPrefix(target, "/home/")
	return remainder != "" && !strings.Contains(remainder, "/")
}

// wrappedShellScript extracts the command text passed to a supported shell's
// -c option, including when the shell itself is behind sudo/env. The quote
// characters have already been removed, so joining the remaining fields
// reconstructs enough shell structure for splitShellCommandSegments to inspect
// commands such as `cd project && rm -rf build/*` recursively.
func wrappedShellScript(fields []string) (string, bool) {
	start := 0
	for start < len(fields) {
		name := shellCommandName(fields[start])
		switch name {
		case "sudo", "doas", "nohup", "exec", "eval", "command", "env":
			start++
			for start < len(fields) && (strings.HasPrefix(fields[start], "-") || strings.Contains(fields[start], "=")) {
				start++
			}
			continue
		}
		if !isShellCommandName(name) {
			return "", false
		}
		for i := start + 1; i < len(fields)-1; i++ {
			option := fields[i]
			if strings.HasPrefix(option, "-") && strings.Contains(strings.TrimLeft(option, "-"), "c") {
				return strings.Join(fields[i+1:], " "), true
			}
		}
		return "", false
	}
	return "", false
}

func forcedRemoveCommandIndex(fields []string) int {
	return forcedRemoveCommandIndexFrom(fields, 0, 0)
}

func forcedRemoveCommandIndexFrom(fields []string, start, depth int) int {
	if start >= len(fields) || depth > 8 {
		return -1
	}
	first := shellCommandName(fields[start])
	if first == "rm" {
		return start
	}
	switch first {
	case "env":
		for i := start + 1; i < len(fields); i++ {
			field := fields[i]
			if strings.HasPrefix(field, "-") || strings.Contains(field, "=") {
				continue
			}
			return forcedRemoveCommandIndexFrom(fields, i, depth+1)
		}
	case "sudo", "doas", "nohup", "exec", "eval", "command":
		// Wrapper flags vary, so look only a short distance ahead for another
		// recognized command wrapper or rm. This keeps `docker rm` out because
		// docker itself is not a wrapper and never reaches this branch.
		for i := start + 1; i < len(fields) && i < start+8; i++ {
			name := shellCommandName(fields[i])
			if name == "rm" || name == "env" || isShellCommandName(name) {
				return forcedRemoveCommandIndexFrom(fields, i, depth+1)
			}
		}
	case "sh", "bash", "dash", "zsh", "ksh":
		// -lc/-xc and separate --login -c forms all execute the token after the
		// option containing c as shell code. Quotes have already been stripped.
		for i := start + 1; i < len(fields)-1; i++ {
			option := fields[i]
			if option == "--" {
				break
			}
			if strings.HasPrefix(option, "-") && strings.Contains(strings.TrimLeft(option, "-"), "c") {
				return forcedRemoveCommandIndexFrom(fields, i+1, depth+1)
			}
		}
	}
	return -1
}

func shellCommandName(field string) string {
	field = strings.TrimLeft(strings.Trim(field, "'\""), `\`)
	if field == "/bin/rm" || field == "/usr/bin/rm" {
		return "rm"
	}
	return field
}

func isShellCommandName(name string) bool {
	switch name {
	case "sh", "bash", "dash", "zsh", "ksh":
		return true
	default:
		return false
	}
}

// Relative globs are usable when they are scoped beneath a concrete project
// directory (`build/*`, `./dist/*.map`). A bare glob (`*`, `./*`, `foo*`) or
// any absolute glob remains ambiguous because its expansion depends entirely
// on the remote working directory or may cross into system paths.
func hasUnscopedRemoveGlob(target string) bool {
	wildcard := strings.IndexAny(target, "*?[")
	if wildcard < 0 {
		return false
	}
	prefix := target[:wildcard]
	if strings.HasPrefix(target, "/") {
		return true
	}
	slash := strings.LastIndex(prefix, "/")
	if slash < 0 {
		return true
	}
	parent := path.Clean(prefix[:slash])
	return parent == "." || parent == ".." || strings.HasPrefix(parent, "../")
}

// splitShellCommandSegments finds command positions without mistaking an
// argument such as `docker rm` for the system rm utility. Separators inside
// quotes and escaped separators remain part of the same segment.
func splitShellCommandSegments(command string) []string {
	segments := make([]string, 0, 2)
	start := 0
	var quote rune
	escaped := false
	for i, r := range command {
		if escaped {
			escaped = false
			continue
		}
		if r == '\\' {
			escaped = true
			continue
		}
		if quote != 0 {
			if r == quote {
				quote = 0
			}
			continue
		}
		if r == '\'' || r == '"' {
			quote = r
			continue
		}
		if r == ';' || r == '\n' || r == '|' || r == '&' {
			segments = append(segments, command[start:i])
			start = i + 1
		}
	}
	segments = append(segments, command[start:])
	return segments
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
			if pattern == "/etc/ssh/ssh_host_" {
				if matched := privateSSHHostKeyReference(lower); matched != "" {
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

func privateSSHHostKeyReference(lower string) string {
	const prefix = "/etc/ssh/ssh_host_"
	for _, field := range strings.Fields(lower) {
		field = strings.Trim(normalizeSensitivePathText(field), "\\\"';,|&`()[]{} ")
		if strings.Contains(field, prefix) && !strings.HasSuffix(field, ".pub") {
			return field
		}
	}
	return ""
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

// guardCommand composes the legacy known-pattern preflight checks with a human
// confirmation gate. It is retained for focused policy tests; production
// in-app AI calls checkCommandPreflightBlock before its own authorization flow,
// while external CLI exec uses classifyCommand. When
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
