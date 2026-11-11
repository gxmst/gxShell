package app

import (
	"path"
	"regexp"
	"strings"
)

var cliForkBombPattern = regexp.MustCompile(`(?m)(?:^|[;\n])\s*:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*;?\s*\}\s*;?\s*:`)

// Full trust is command authority, with a narrow host self-destruction guard.
// Credential access, service changes, SQL, publishing and opaque programs keep
// their risk classification but do not prompt. This is not a shell sandbox.
func cliSelfDestructiveBlock(command string, assessment riskAssessment) (commandBlock, bool) {
	if match := cliForkBombPattern.FindString(command); match != "" {
		return commandBlock{Kind: "self-destructive", Reason: "host self-destruction is blocked during full trust", Detail: "fork bomb"}, true
	}
	for _, finding := range assessment.Findings {
		if finding.Category == riskIrreversible {
			verdict := classifyTargetPath(finding.Target)
			if verdict.Class == pathBlockDevice || finding.Reason == "fork bomb" ||
				finding.Reason == "formats a filesystem" || finding.Reason == "reformats a swap device" ||
				finding.Reason == "erases filesystem signatures" || finding.Reason == "rewrites a partition table" ||
				finding.Reason == "destroys a storage pool or array member" || finding.Reason == "destroys encrypted storage" ||
				strings.HasPrefix(finding.Reason, "removes an LVM") {
				return commandBlock{Kind: "self-destructive", Reason: "host self-destruction is blocked during full trust", Detail: finding.Reason + ": " + finding.Target}, true
			}
		}
		// A T3 category alone is insufficient: deleting a database or an ordinary
		// deployed file is allowed. Keep only removals of host-critical targets.
		removal := strings.HasPrefix(finding.Reason, "removal target") ||
			strings.HasPrefix(finding.Reason, "destructive target resolves") ||
			strings.HasPrefix(finding.Reason, "deletes matches") || finding.Reason == "deletes files" ||
			strings.HasPrefix(finding.Reason, "moves a system path") || strings.HasPrefix(finding.Reason, "moves credentials")
		if removal && cliSelfDestructiveRemovalTarget(finding.Target) {
			return commandBlock{Kind: "self-destructive", Reason: "host self-destruction is blocked during full trust", Detail: "removal of " + finding.Target}, true
		}
		if finding.Category == riskSelfLock && strings.Contains(finding.Reason, "permissions") && cliSelfDestructiveRemovalTarget(finding.Target) {
			return commandBlock{Kind: "self-destructive", Reason: "host self-destruction is blocked during full trust", Detail: "critical path permission change: " + finding.Target}, true
		}
		if finding.Reason == "truncates a file" && cliSelfDestructiveRemovalTarget(finding.Target) {
			return commandBlock{Kind: "self-destructive", Reason: "host self-destruction is blocked during full trust", Detail: "critical path truncation: " + finding.Target}, true
		}
	}
	return commandBlock{}, false
}

func cliSelfDestructiveRemovalTarget(target string) bool {
	if target == "~ (home directory)" || classifyTargetPath(target).Class == pathHomeRoot {
		return true
	}
	// Root globs such as /* must not become exempt just because the classifier
	// marks their expansion undecidable. Variables remain opaque full-trust code.
	if at := strings.IndexAny(target, "*?["); at >= 0 {
		target = target[:at]
	}
	if target == "" || strings.ContainsAny(target, "$`") {
		return false
	}
	target = path.Clean(target)
	if target == "/" || isHomeDirectoryRoot(target) || target == "/root" || target == "/home" {
		return true
	}
	for _, critical := range []string{"/var/lib", "/var/spool", "/etc/passwd", "/etc/shadow", "/etc/fstab", "/etc/ssh/sshd_config"} {
		if target == critical {
			return true
		}
	}
	if strings.HasSuffix(target, "/.ssh/authorized_keys") {
		return true
	}
	for _, root := range criticalRemoveRoots {
		if target == root {
			return true
		}
	}
	for _, root := range []string{"/bin", "/boot", "/lib", "/lib32", "/lib64", "/sbin", "/usr", "/sys", "/proc"} {
		if strings.HasPrefix(target, root+"/") {
			return true
		}
	}
	return target == "/etc/ssh" || target == "/etc/systemd" || strings.HasSuffix(target, "/.ssh")
}
