package app

// Tokenizer and target-path analysis backing the risk-tier classifier.
//
// The tier of a command is almost always decided by what it acts on rather than
// by which verb it uses: `sed -i` against a file in the working tree is an
// ordinary edit, while the same `sed -i` against /etc/ssh/sshd_config can cost
// remote access. That makes path classification the load-bearing part of the
// policy, so it lives here with its own tests rather than being inlined into the
// verb rules.
//
// Everything in this file is deliberately conservative in one direction: when a
// path cannot be resolved statically (variable expansion, command substitution,
// an unscoped glob) it is reported as pathUnresolvable, which the verb rules
// floor at T2. A path that cannot be read cannot be argued to be safe.

import (
	"path"
	"strings"
)

// cmdToken is one lexical token with its position in the original text, so a
// finding can point back at the exact fragment that drove it.
type cmdToken struct {
	// Text is the token with quotes removed and backslash escapes resolved.
	Text string
	// Raw is the original slice, used to tell a quoted payload from a bare one.
	Raw   string
	Start int
	End   int
}

// tokenizeCommand splits one command segment into tokens, honouring single
// quotes, double quotes and backslash escapes, and isolating redirection
// operators so they can be scored separately from ordinary operands.
func tokenizeCommand(segment string) []cmdToken {
	tokens := make([]cmdToken, 0, 8)
	i := 0
	n := len(segment)
	for i < n {
		for i < n && (segment[i] == ' ' || segment[i] == '\t' || segment[i] == '\n' || segment[i] == '\r') {
			i++
		}
		if i >= n {
			break
		}
		start := i
		// A redirection operator is its own token.
		if segment[i] == '>' || segment[i] == '<' {
			for i < n && (segment[i] == '>' || segment[i] == '<' || segment[i] == '&') {
				i++
			}
			raw := segment[start:i]
			tokens = append(tokens, cmdToken{Text: raw, Raw: raw, Start: start, End: i})
			continue
		}
		var text strings.Builder
		var quote byte
		for i < n {
			ch := segment[i]
			if quote == 0 {
				if ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' {
					break
				}
				if ch == '>' || ch == '<' {
					break
				}
				if ch == '\\' && i+1 < n {
					text.WriteByte(segment[i+1])
					i += 2
					continue
				}
				if ch == '\'' || ch == '"' {
					quote = ch
					i++
					continue
				}
				text.WriteByte(ch)
				i++
				continue
			}
			if ch == quote {
				quote = 0
				i++
				continue
			}
			if ch == '\\' && quote == '"' && i+1 < n {
				text.WriteByte(segment[i+1])
				i += 2
				continue
			}
			text.WriteByte(ch)
			i++
		}
		tokens = append(tokens, cmdToken{Text: text.String(), Raw: segment[start:i], Start: start, End: i})
	}
	return tokens
}

// shellSegmentRanges reports the byte ranges of each command position, using the
// same quoting rules as splitShellCommandSegments but preserving offsets.
func shellSegmentRanges(command string) [][2]int {
	ranges := make([][2]int, 0, 2)
	start := 0
	var quote rune
	escaped := false
	for i, r := range command {
		if escaped {
			escaped = false
			continue
		}
		// A backslash is literal inside single quotes. Treating it as an
		// escape here would hide the closing quote and every command separator
		// after it, allowing a later command to escape classification.
		if r == '\\' && quote != '\'' {
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
			ranges = append(ranges, [2]int{start, i})
			start = i + 1
		}
	}
	ranges = append(ranges, [2]int{start, len(command)})
	return ranges
}

type pathClass int

const (
	pathOrdinary pathClass = iota
	pathUnresolvable
	pathFilesystemRoot
	pathBlockDevice
	pathSystemConfig
	pathServicePayload
	pathBootPersistence
	pathCredentialStore
	pathSSHDir
	pathHomeRoot
	pathTemp
	pathArtifact
)

type pathVerdict struct {
	Class pathClass
	// Display is the normalized spelling shown to the operator. It is the
	// resolved absolute form when one exists, otherwise the original text.
	Display string
}

// systemConfigRoots are paths whose contents the operating system depends on.
// Writing into them can leave a host unbootable or unreachable, so they are the
// self-lock axis rather than the ordinary-write one.
var systemConfigRoots = []string{
	"/etc", "/boot", "/usr", "/lib", "/lib32", "/lib64", "/libx32",
	"/bin", "/sbin", "/sys", "/proc", "/var/lib", "/var/spool", "/dev",
}

// servicePayloadRoots hold deployed application state: not required to boot,
// but not reconstructible from a build either.
var servicePayloadRoots = []string{"/opt", "/var/www", "/var/log", "/var/backups"}

// bootPersistenceNeedles mark paths that cause code to run later, which is how a
// one-off command becomes a standing foothold.
var bootPersistenceNeedles = []string{
	"/etc/cron", "/var/spool/cron", "/etc/systemd/system", "/lib/systemd/system",
	"/usr/lib/systemd/system", "/.config/systemd", "/etc/rc.local", "/etc/init.d",
	"/etc/profile", "/.bashrc", "/.bash_profile", "/.profile", "/.zshrc", "/.zprofile",
	"/etc/update-motd.d", "/.config/autostart", "/etc/ld.so.preload",
}

// credentialNeedles and credentialSuffixes extend the older sensitivePaths list
// used by the hard blocklist. They deliberately feed only the tier classifier
// (T3-c, immediate confirmation) and not the transfer/copy hard block, because
// deploying a certificate or an .env file is ordinary work that should stay
// possible with an explicit human answer.
var credentialNeedles = []string{
	"/etc/shadow", "/etc/gshadow", "/.aws/credentials", "/.kube/config",
	"/.docker/config.json", "/.netrc", "/.git-credentials", "/.gnupg/private-keys",
	"/.ssh/id_", "/etc/ssh/ssh_host_", "/.config/gcloud/credentials",
	"/var/lib/kubelet", "/.npmrc", "/.pypirc", "/.my.cnf", "/.pgpass",
	"service-account", "credentials.json", "secrets.yml", "secrets.yaml",
	"/.env",
}

var credentialSuffixes = []string{
	".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".ppk", ".asc", ".gpg",
}

var artifactComponents = map[string]bool{
	"build": true, "dist": true, "target": true, "node_modules": true, "out": true,
	"coverage": true, ".next": true, ".nuxt": true, "__pycache__": true,
	".pytest_cache": true, ".cache": true, "obj": true, ".gradle": true,
	".terraform": true, "tmp": true,
}

var tempRoots = []string{"/tmp", "/var/tmp", "/dev/shm"}

// blockDevicePrefixes name whole-disk and volume devices. A write here bypasses
// the filesystem entirely, which is the definition of unrecoverable.
var blockDevicePrefixes = []string{
	"/dev/sd", "/dev/hd", "/dev/vd", "/dev/xvd", "/dev/nvme", "/dev/mmcblk",
	"/dev/loop", "/dev/md", "/dev/dm-", "/dev/mapper/", "/dev/disk/", "/dev/nbd",
	"/dev/zd", "/dev/vg", "/dev/sr", "/dev/fd",
}

// classifyTargetPath resolves one operand and reports what kind of thing it
// names. The order of the checks matters: a path can satisfy several categories
// at once (/etc/ssh/ssh_host_rsa_key is a credential, an SSH path and a system
// path), and the most consequential reading must win.
func classifyTargetPath(raw string) pathVerdict {
	text := strings.TrimSpace(raw)
	if text == "" {
		return pathVerdict{Class: pathUnresolvable, Display: raw}
	}
	// Anything whose value is decided at runtime cannot be scored. An unscoped
	// glob is in the same category: its expansion depends on the remote working
	// directory, so `rm -rf *` is not a knowable target.
	if strings.ContainsAny(text, "$`") {
		return pathVerdict{Class: pathUnresolvable, Display: text}
	}
	if hasUnscopedRemoveGlob(text) {
		return pathVerdict{Class: pathUnresolvable, Display: text}
	}

	resolved := text
	inHome := false
	switch {
	case text == "~":
		return pathVerdict{Class: pathHomeRoot, Display: "~ (home directory)"}
	case strings.HasPrefix(text, "~/"):
		inHome = true
		resolved = "/home/__self__/" + strings.TrimPrefix(text, "~/")
	case strings.HasPrefix(text, "~"):
		if slash := strings.Index(text, "/"); slash > 1 {
			resolved = "/home/" + text[1:]
		} else {
			return pathVerdict{Class: pathHomeRoot, Display: text}
		}
	}
	absolute := strings.HasPrefix(resolved, "/")
	cleaned := path.Clean(resolved)
	lower := strings.ToLower(cleaned)
	display := cleaned
	if inHome {
		display = text
	}

	if cleaned == "/" {
		return pathVerdict{Class: pathFilesystemRoot, Display: "/"}
	}
	// A relative path that climbs out of the working directory lands somewhere
	// only the remote shell knows.
	if !absolute && (cleaned == ".." || strings.HasPrefix(cleaned, "../")) {
		return pathVerdict{Class: pathUnresolvable, Display: text}
	}

	for _, prefix := range blockDevicePrefixes {
		if strings.HasPrefix(lower, prefix) {
			return pathVerdict{Class: pathBlockDevice, Display: display}
		}
	}
	if class, ok := credentialPathClass(lower); ok {
		return pathVerdict{Class: class, Display: display}
	}
	if strings.HasSuffix(lower, "/.ssh") || strings.Contains(lower, "/.ssh/") || lower == "/etc/ssh" || strings.HasPrefix(lower, "/etc/ssh/") {
		return pathVerdict{Class: pathSSHDir, Display: display}
	}
	for _, needle := range bootPersistenceNeedles {
		if strings.Contains(lower, needle) {
			return pathVerdict{Class: pathBootPersistence, Display: display}
		}
	}
	if isHomeDirectoryRoot(cleaned) || cleaned == "/root" || cleaned == "/home" {
		return pathVerdict{Class: pathHomeRoot, Display: display}
	}
	for _, root := range tempRoots {
		if cleaned == root || strings.HasPrefix(cleaned, root+"/") {
			return pathVerdict{Class: pathTemp, Display: display}
		}
	}
	for _, root := range systemConfigRoots {
		if cleaned == root || strings.HasPrefix(cleaned, root+"/") {
			return pathVerdict{Class: pathSystemConfig, Display: display}
		}
	}
	for _, root := range servicePayloadRoots {
		if cleaned == root || strings.HasPrefix(cleaned, root+"/") {
			return pathVerdict{Class: pathServicePayload, Display: display}
		}
	}
	// A rebuildable artifact directory is the one target class that stays T1 for
	// a delete, because regenerating it is a build away.
	if hasArtifactComponent(cleaned) {
		return pathVerdict{Class: pathArtifact, Display: display}
	}
	return pathVerdict{Class: pathOrdinary, Display: display}
}

func credentialPathClass(lower string) (pathClass, bool) {
	// A public key is not a secret; the older blocklist made the same exception
	// and it matters in practice (deploying authorized_keys reads .pub files).
	if strings.HasSuffix(lower, ".pub") {
		return 0, false
	}
	for _, needle := range credentialNeedles {
		if strings.Contains(lower, needle) {
			return pathCredentialStore, true
		}
	}
	for _, suffix := range credentialSuffixes {
		if strings.HasSuffix(lower, suffix) {
			return pathCredentialStore, true
		}
	}
	base := path.Base(lower)
	if base == ".env" || strings.HasPrefix(base, ".env.") || strings.HasSuffix(base, ".env") {
		return pathCredentialStore, true
	}
	if strings.Contains(lower, "authorized_keys") {
		return pathSSHDir, true
	}
	return 0, false
}

func hasArtifactComponent(cleaned string) bool {
	for _, component := range strings.Split(cleaned, "/") {
		if artifactComponents[strings.ToLower(component)] {
			return true
		}
	}
	return false
}

// looksLikePath reports whether a token is plausibly a filesystem operand. It
// is used when correlating later execution with an uploaded file path.
func looksLikePath(text string) bool {
	if text == "" || strings.HasPrefix(text, "-") {
		return false
	}
	if strings.HasPrefix(text, "/") || strings.HasPrefix(text, "~") || strings.HasPrefix(text, "./") {
		return true
	}
	return strings.Contains(text, "/")
}

// commandPathOperands collects every distinct path-like operand in the command,
// in order of appearance.
func commandPathOperands(command string) []string {
	seen := map[string]bool{}
	targets := make([]string, 0, 4)
	for _, span := range shellSegmentRanges(command) {
		for _, token := range tokenizeCommand(command[span[0]:span[1]]) {
			text := token.Text
			if strings.HasPrefix(text, "of=") {
				text = strings.TrimPrefix(text, "of=")
			}
			if strings.HasPrefix(text, "if=") {
				text = strings.TrimPrefix(text, "if=")
			}
			if !looksLikePath(text) {
				continue
			}
			verdict := classifyTargetPath(text)
			if seen[verdict.Display] {
				continue
			}
			seen[verdict.Display] = true
			targets = append(targets, verdict.Display)
		}
	}
	return targets
}

// outboundVerbs can move bytes off the host. Paired with a credential operand
// they describe an exfiltration rather than a local read.
var outboundVerbs = map[string]bool{
	"curl": true, "wget": true, "nc": true, "ncat": true, "socat": true,
	"scp": true, "sftp": true, "rsync": true, "ftp": true, "tftp": true,
	"mail": true, "mailx": true, "sendmail": true, "telnet": true, "ssh": true,
}

// appendCredentialFindings implements the confidentiality axis. It runs before
// and independently of the verb rules because a credential read is lexically
// indistinguishable from ordinary observation: `cat ~/.aws/credentials` is a
// plain read whose consequence no audit trail can undo.
func appendCredentialFindings(assessment *riskAssessment, command string, offset int) {
	outbound := ""
	credentialTokens := make([]cmdToken, 0, 2)
	for _, span := range shellSegmentRanges(command) {
		segment := command[span[0]:span[1]]
		tokens := tokenizeCommand(segment)
		if len(tokens) == 0 {
			continue
		}
		index, _, _ := skipPrivilegeWrappers(tokens)
		if index < len(tokens) {
			if outboundVerbs[shellCommandName(tokens[index].Text)] {
				outbound = shellCommandName(tokens[index].Text)
			}
		}
		for _, token := range tokens {
			text := token.Text
			if eq := strings.Index(text, "="); eq > 0 && !strings.HasPrefix(text, "-") {
				text = text[eq+1:]
			}
			text = strings.TrimPrefix(text, "@")
			if !looksLikePath(text) && !strings.Contains(text, ".") {
				continue
			}
			normalized := strings.ToLower(normalizeSensitivePathText(stripShellPathObfuscation(text)))
			if normalized == "" {
				continue
			}
			if class, ok := credentialPathClass(normalized); ok && class == pathCredentialStore {
				token.Start += offset + span[0]
				token.End += offset + span[0]
				credentialTokens = append(credentialTokens, token)
			}
		}
	}
	for i := range credentialTokens {
		token := credentialTokens[i]
		reason := "reads or writes a credential store"
		if outbound != "" {
			reason = "sends a credential store off this host with " + outbound
		}
		assessment.add(riskFinding{
			Tier: tierCritical, Category: riskCredential,
			Reason: reason, Target: token.Text,
			Start: token.Start, End: token.End,
		})
	}
}

// riskSpan is a coloured region of the command text for the in-app card. The
// native dialog shows the same information as plain text; this is an additional
// readability layer and never the sole basis for a decision.
type riskSpan struct {
	Start int    `json:"start"`
	End   int    `json:"end"`
	Class string `json:"class"`
	Note  string `json:"note,omitempty"`
}

const (
	spanTierDriver = "tier-driver" // red: decided the tier
	spanAmplifier  = "amplifier"   // orange: widens the blast radius
	spanOpaque     = "opaque"      // purple: cannot be analysed
	spanCredential = "credential"  // blue: secret material
	spanNetwork    = "network"     // cyan: data can leave
)

// amplifierFlags widen scope without changing the verb.
var amplifierFlags = map[string]string{
	"-r": "recursive", "-R": "recursive", "--recursive": "recursive",
	"-f": "forced", "--force": "forced", "--all": "everything",
	"-a": "everything", "-y": "no questions asked", "--yes": "no questions asked",
	"--no-preserve-root": "allows removing the root", "--hard": "discards work",
	"-9": "unconditional kill", "--purge": "removes configuration too",
}

// collectRiskSpans maps findings and scope-widening tokens onto text ranges.
func collectRiskSpans(command string, findings []riskFinding) []riskSpan {
	spans := make([]riskSpan, 0, len(findings)+4)
	occupied := func(start, end int) bool {
		for _, span := range spans {
			if start < span.End && end > span.Start {
				return true
			}
		}
		return false
	}
	maxTier := tierObserve
	for _, finding := range findings {
		if finding.Tier > maxTier {
			maxTier = finding.Tier
		}
	}
	for _, finding := range findings {
		if finding.Start < 0 || finding.End <= finding.Start || finding.End > len(command) {
			continue
		}
		class := spanTierDriver
		switch finding.Category {
		case riskCredential:
			class = spanCredential
		case riskUndecidable:
			class = spanOpaque
		default:
			if finding.Tier < maxTier || finding.Tier < tierBounded {
				continue
			}
		}
		if occupied(finding.Start, finding.End) {
			continue
		}
		spans = append(spans, riskSpan{Start: finding.Start, End: finding.End, Class: class, Note: finding.Reason})
	}
	for _, segment := range shellSegmentRanges(command) {
		for _, token := range tokenizeCommand(command[segment[0]:segment[1]]) {
			start := token.Start + segment[0]
			end := token.End + segment[0]
			if occupied(start, end) {
				continue
			}
			if note, ok := amplifierFlags[token.Text]; ok {
				spans = append(spans, riskSpan{Start: start, End: end, Class: spanAmplifier, Note: note})
				continue
			}
			if strings.HasPrefix(token.Text, "-") && len(token.Text) > 1 && !strings.HasPrefix(token.Text, "--") {
				if note, ok := combinedFlagNote(token.Text); ok {
					spans = append(spans, riskSpan{Start: start, End: end, Class: spanAmplifier, Note: note})
					continue
				}
			}
			if strings.ContainsAny(token.Raw, "$`") || strings.Contains(token.Raw, "*") || strings.Contains(token.Raw, "?") {
				spans = append(spans, riskSpan{Start: start, End: end, Class: spanOpaque, Note: "resolved on the remote host, not here"})
				continue
			}
			if _, ok := opaqueVerbs[shellCommandName(token.Text)]; ok {
				spans = append(spans, riskSpan{Start: start, End: end, Class: spanOpaque, Note: "opaque command"})
				continue
			}
			if outboundVerbs[shellCommandName(token.Text)] {
				spans = append(spans, riskSpan{Start: start, End: end, Class: spanNetwork, Note: "can move data off this host"})
				continue
			}
			if looksLikeNetworkTarget(token.Text) {
				spans = append(spans, riskSpan{Start: start, End: end, Class: spanNetwork, Note: "network destination"})
			}
		}
	}
	sortRiskSpans(spans)
	return spans
}

func combinedFlagNote(flag string) (string, bool) {
	notes := make([]string, 0, 2)
	for _, r := range flag[1:] {
		if note, ok := amplifierFlags["-"+string(r)]; ok {
			notes = append(notes, note)
		}
	}
	if len(notes) == 0 {
		return "", false
	}
	return strings.Join(notes, ", "), true
}

func looksLikeNetworkTarget(text string) bool {
	lower := strings.ToLower(text)
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") ||
		strings.HasPrefix(lower, "ftp://") || strings.HasPrefix(lower, "ssh://") ||
		strings.HasPrefix(lower, "git@") {
		return true
	}
	return false
}

func sortRiskSpans(spans []riskSpan) {
	for i := 1; i < len(spans); i++ {
		for j := i; j > 0 && spans[j].Start < spans[j-1].Start; j-- {
			spans[j], spans[j-1] = spans[j-1], spans[j]
		}
	}
}
