package app

// Behaviour-based risk tiers for remote command execution.
//
// This file replaces the previous "unoverridable blocklist + confirm everything
// else" policy with a graded classification. The motivation is that the old
// shape had the weights backwards: the regex blocklist was the only layer that
// could not be switched off, yet it is the least accurate one, while the native
// confirmation dialog — the layer that actually carries the security guarantee —
// could be disabled wholesale by a profile trust window. A trust window
// therefore left a regex list as the sole defence, which is not what it was
// designed for.
//
// The classifier scores a command on three axes instead of one:
//
//   - reversibility  — can the effect be undone? Decides whether a command may
//     enter the unattended auto-approve lane, where an audit trail is the only
//     remaining control.
//   - confidentiality — a credential read is perfectly reversible (no byte
//     changes) yet its consequence cannot be recalled, so an audit trail cannot
//     compensate. Independent of tier, never covered by a trust window.
//   - external visibility — an effect that leaves this machine (a push, a
//     publish, a DNS record) is not "reversible" in any useful sense once
//     someone else has observed it.
//
// Tiers:
//
//	T0 tierObserve      pure observation                  never prompts
//	T1 tierRecoverable  local, scoped, recoverable change auto in trust window
//	T2 tierBounded      bounded destruction                auto in trust window;
//	                    undecidable or external            always one click
//	T3 tierCritical     irreversible / self-lock /        immediate click,
//	                    credential / external            never batched
//
// Two rules keep the classifier honest about its own limits:
//
//  1. Anything it cannot statically resolve (command substitution, variable
//     expansion, base64, eval, a pipe into a shell, an unknown binary) is
//     floored at T2 and, unlike the rest of T2, is never covered by a trust
//     window. Undecidable never means "probably fine".
//  2. A privilege wrapper (sudo/doas) is a risk amplifier, not a tier. It can
//     only raise a classification, never lower it, and it removes the implicit
//     "this would have failed on permissions anyway" assumption. `sudo
//     systemctl restart myapp` stays T1; `sudo rm -rf /` is T3 because of its
//     target, not because of sudo.
//
// The tier is computed from the maximum over every command segment and every
// nested shell level, so a single dangerous statement inside an otherwise
// harmless script raises the whole request.

import (
	"fmt"
	"path"
	"strings"
)

type commandTier int

const (
	tierObserve     commandTier = 0
	tierRecoverable commandTier = 1
	tierBounded     commandTier = 2
	tierCritical    commandTier = 3
)

func (t commandTier) String() string {
	switch t {
	case tierObserve:
		return "T0"
	case tierRecoverable:
		return "T1"
	case tierBounded:
		return "T2"
	default:
		return "T3"
	}
}

// Label returns a short human-readable tier name for dialogs and audit records.
func (t commandTier) Label() string {
	switch t {
	case tierObserve:
		return "read-only"
	case tierRecoverable:
		return "recoverable change"
	case tierBounded:
		return "bounded destructive"
	default:
		return "critical"
	}
}

func (t commandTier) labelForLanguage(language string) string {
	if !isChineseLanguage(language) {
		return t.Label()
	}
	switch t {
	case tierObserve:
		return "只读操作"
	case tierRecoverable:
		return "可恢复变更"
	case tierBounded:
		return "有限破坏性操作"
	default:
		return "高危操作"
	}
}

type riskCategory string

const (
	// T3 subtypes.
	riskIrreversible riskCategory = "irreversible" // T3-a storage destruction
	riskSelfLock     riskCategory = "self-lock"    // T3-b lose access to the host
	riskCredential   riskCategory = "credential"   // T3-c secret exposure
	riskExternal     riskCategory = "external"     // T3-d unrecallable outside state
	riskPublish      riskCategory = "publish"      // T3-d subset: public and permanent

	// Lower-tier categories, used for audit records and colouring.
	riskUndecidable riskCategory = "undecidable"
	riskDestructive riskCategory = "destructive"
	riskPersistence riskCategory = "persistence"
	riskExposure    riskCategory = "exposure"
	riskWrite       riskCategory = "write"
	riskObserve     riskCategory = "observe"
)

// riskFinding records one reason the classifier assigned a tier. Start/End are
// byte offsets into the original command text for the token that drove the
// decision, or -1 when the finding is not anchored to a single token.
type riskFinding struct {
	Tier     commandTier
	Category riskCategory
	Reason   string
	Target   string
	Start    int
	End      int
}

type riskAssessment struct {
	Tier     commandTier
	Findings []riskFinding
	Spans    []riskSpan
}

func (r riskAssessment) hasCategory(category riskCategory) bool {
	for _, finding := range r.Findings {
		if finding.Category == category {
			return true
		}
	}
	return false
}

// topFinding returns the finding that set the overall tier.
func (r riskAssessment) topFinding() (riskFinding, bool) {
	best := riskFinding{Tier: -1}
	for _, finding := range r.Findings {
		if finding.Tier > best.Tier {
			best = finding
		}
	}
	if best.Tier < 0 {
		return riskFinding{}, false
	}
	return best, true
}

// riskLines renders short action explanations for native approval dialogs and
// the synchronized in-app card. Include T1 because an untrusted T1 request also
// prompts and should explain its effect before the user decides.
func (r riskAssessment) riskLines() []string {
	return r.riskLinesForLanguage("")
}

func (r riskAssessment) riskLinesForLanguage(language string) []string {
	seen := map[string]bool{}
	lines := make([]string, 0, len(r.Findings))
	for _, finding := range r.Findings {
		if finding.Tier < tierRecoverable {
			continue
		}
		line := finding.Reason
		if isChineseLanguage(language) {
			line = riskReasonZH(finding)
		}
		if finding.Target != "" {
			separator := ": "
			if isChineseLanguage(language) {
				separator = "："
			}
			line += separator + truncate(finding.Target, 160)
		}
		if seen[line] {
			continue
		}
		seen[line] = true
		lines = append(lines, line)
	}
	return lines
}

func isChineseLanguage(language string) bool {
	return strings.EqualFold(strings.TrimSpace(language), "zh-CN") || strings.EqualFold(strings.TrimSpace(language), "zh")
}

// riskReasonZH turns the classifier's detailed English reason into a short
// Chinese action statement. Category fallbacks are intentional: newly added
// classifier rules still produce an entirely Chinese explanation even before a
// more specific wording is added here.
func riskReasonZH(finding riskFinding) string {
	reason := strings.ToLower(finding.Reason)
	switch finding.Category {
	case riskIrreversible:
		switch {
		case strings.Contains(reason, "format"), strings.Contains(reason, "filesystem signature"), strings.Contains(reason, "partition table"):
			return "格式化或重写存储结构"
		case strings.Contains(reason, "overwrite"), strings.Contains(reason, "raw data"), strings.Contains(reason, "block device"):
			return "不可逆地覆盖数据"
		default:
			return "不可逆地删除数据或资源"
		}
	case riskSelfLock:
		switch {
		case strings.Contains(reason, "power"), strings.Contains(reason, "halt"), strings.Contains(reason, "reboot"):
			return "关闭或重启服务器，当前连接会中断"
		case strings.Contains(reason, "network"), strings.Contains(reason, "routing"), strings.Contains(reason, "firewall"), strings.Contains(reason, "interface"), strings.Contains(reason, "address"):
			return "修改网络或防火墙配置，可能中断当前连接"
		case strings.Contains(reason, "service"):
			return "停止或重启远程访问服务，可能中断当前连接"
		case strings.Contains(reason, "password"), strings.Contains(reason, "account"), strings.Contains(reason, "user"), strings.Contains(reason, "group"), strings.Contains(reason, "sudoers"), strings.Contains(reason, "permission"), strings.Contains(reason, "credential"), strings.Contains(reason, "ssh"), strings.Contains(reason, "login"):
			return "修改账户、权限或登录配置，可能导致失去访问权限"
		default:
			return "修改关键系统配置，可能导致失去访问权限"
		}
	case riskCredential:
		if strings.Contains(reason, "sends") {
			return "将凭据发送到当前服务器之外"
		}
		return "读取、修改或可能暴露凭据"
	case riskPublish:
		return "向公共位置发布内容"
	case riskExternal:
		switch {
		case strings.Contains(reason, "dns"):
			return "修改公共 DNS 记录"
		case strings.Contains(reason, "publish"), strings.Contains(reason, "remote"):
			return "向外部系统发布内容或变更"
		case strings.Contains(reason, "infrastructure"):
			return "修改外部基础设施状态"
		case strings.Contains(reason, "cluster"):
			return "修改外部集群状态"
		default:
			return "修改外部系统状态或向外发送数据"
		}
	case riskPersistence:
		return "修改开机启动或登录时自动运行的配置"
	case riskExposure:
		return "修改网络暴露范围或访问策略"
	case riskDestructive:
		switch {
		case reason == "deletes files":
			return "删除文件"
		case strings.Contains(reason, "delete"), strings.Contains(reason, "remove"), strings.Contains(reason, "drop"), strings.Contains(reason, "erase"):
			return "删除现有文件、数据或资源"
		case strings.Contains(reason, "overwrite"), strings.Contains(reason, "truncate"), strings.Contains(reason, "rewrite"), strings.Contains(reason, "replace"), strings.Contains(reason, "discard"):
			return "覆盖、截断或丢弃现有数据"
		case strings.Contains(reason, "stop"), strings.Contains(reason, "kill"), strings.Contains(reason, "signal"), strings.Contains(reason, "evict"), strings.Contains(reason, "unmount"):
			return "停止进程、服务或正在运行的工作负载"
		default:
			return "修改或中断现有运行状态"
		}
	case riskWrite:
		switch {
		case strings.Contains(reason, "removes rebuildable"):
			return "删除可重新生成的构建产物"
		case strings.Contains(reason, "removes a temporary"):
			return "删除临时文件或目录"
		case strings.Contains(reason, "writes a filesystem path"):
			return "写入文件系统路径"
		case strings.Contains(reason, "writes a file"), strings.Contains(reason, "standard output"):
			return "写入文件或输出内容"
		case strings.Contains(reason, "edit"):
			return "修改文件内容"
		case strings.Contains(reason, "permission"):
			return "修改单个路径的权限"
		case strings.Contains(reason, "start") && strings.Contains(reason, "service"):
			return "启动或重启服务"
		case strings.Contains(reason, "container"):
			return "启动或修改容器"
		case strings.Contains(reason, "install"), strings.Contains(reason, "update"), strings.Contains(reason, "dependencies"):
			return "安装、更新或管理软件依赖"
		case strings.Contains(reason, "build"):
			return "运行构建"
		case strings.Contains(reason, "test"):
			return "运行测试"
		case strings.Contains(reason, "archive"):
			return "创建归档文件"
		case strings.Contains(reason, "working directory"):
			return "切换这条命令的工作目录"
		case strings.Contains(reason, "repository"), strings.Contains(reason, "branch"):
			return "修改本地代码仓库"
		default:
			return "写入或修改本地文件和运行状态"
		}
	case riskUndecidable:
		switch {
		case strings.Contains(reason, "target"), strings.Contains(reason, "destination"), strings.Contains(reason, "path"):
			return "操作目标无法仅根据命令文本确定"
		case strings.Contains(reason, "shell expansion"):
			return "在远程服务器解析 Shell 展开，实际行为无法预先确定"
		case strings.Contains(reason, "interpreter"), strings.Contains(reason, "shell"), strings.Contains(reason, "executable"), strings.Contains(reason, "command"), strings.Contains(reason, "wrapper"):
			return "执行无法仅根据命令文本判断实际行为的程序"
		case strings.Contains(reason, "network transfer"):
			return "传输数据或修改远程目标，具体影响无法预先确定"
		case strings.Contains(reason, "database") || strings.Contains(reason, "sql"):
			return "执行数据库操作，具体影响无法预先确定"
		default:
			return "执行无法仅根据命令文本判断实际行为的操作"
		}
	case riskObserve:
		return "读取系统信息，可能使用较高权限"
	default:
		return "执行需要确认的操作"
	}
}

func (r *riskAssessment) add(finding riskFinding) {
	if finding.Tier > r.Tier {
		r.Tier = finding.Tier
	}
	r.Findings = append(r.Findings, finding)
}

// approvalStrength is how hard a human must work to authorize a command.
type approvalStrength int

const (
	approvalNone  approvalStrength = iota // no prompt at all
	approvalClick                         // one native Allow/Deny click
)

// requiredApproval maps a classification plus the profile's trust state onto a
// confirmation strength.
//
// A trust window covers T1 outright and the bounded-destruction half of T2
// (the tierBounded case spells out the two categories that stay outside it).
// It deliberately does not cover T3: its purpose is unattended low-risk work,
// not blanket authority. Every T3 request receives its own immediate native
// click and never joins a batch.
func (r riskAssessment) requiredApproval(trusted bool) approvalStrength {
	switch r.Tier {
	case tierObserve:
		return approvalNone
	case tierRecoverable:
		if trusted {
			return approvalNone
		}
		return approvalClick
	case tierBounded:
		// A trust window covers bounded destruction: the blast radius is scoped
		// and the audit trail can account for it after the fact, which is the
		// bargain the window exists to make. Two halves of the tier are outside
		// that bargain, both because an audit trail cannot compensate for them:
		//
		//   - undecidable — rule 1 above floors everything the classifier cannot
		//     statically resolve at T2, so auto-approving the whole tier would
		//     hand the window every obfuscated, substituted or piped-into-a-shell
		//     command precisely because it could not be read, turning "I could
		//     not tell" into "probably fine".
		//   - external — the effect has already left this machine. A push or a
		//     DNS change cannot be recalled once someone else has observed it,
		//     so there is nothing for the audit record to undo.
		if trusted && !r.hasCategory(riskUndecidable) && !r.hasCategory(riskExternal) {
			return approvalNone
		}
		return approvalClick
	default:
		return approvalClick
	}
}

const maxTierRecursionDepth = 8

// classifyCommand assigns a risk tier to a shell command. It never returns an
// error: an input it cannot understand is classified tierBounded, because
// "unparseable" is a risk signal rather than a reason to allow.
func classifyCommand(command string) riskAssessment {
	assessment := riskAssessment{Tier: tierObserve}
	if strings.TrimSpace(command) == "" {
		return assessment
	}

	// The confidentiality axis runs first and independently of any verb. A
	// credential read is lexically a plain `cat`, so a verb-driven walk would
	// classify it as observation.
	appendCredentialFindings(&assessment, command, 0)

	// Preserve the historical fast path exactly: only a single bare read-only
	// command with no shell machinery qualifies as T0. Everything else is at
	// least T1, which keeps the long-standing invariant that no injected or
	// obfuscated command is ever classified as read-only.
	if isReadOnlyCommand(command) {
		if assessment.Tier < tierObserve {
			assessment.Tier = tierObserve
		}
		if len(assessment.Findings) == 0 {
			assessment.add(riskFinding{Tier: tierObserve, Category: riskObserve, Reason: "read-only observation", Start: -1, End: -1})
		}
		assessment.Spans = collectRiskSpans(command, assessment.Findings)
		return assessment
	}

	if start, end, fragment, ok := opaqueShellExpansion(command); ok {
		assessment.add(riskFinding{
			Tier: tierBounded, Category: riskUndecidable,
			Reason: "shell expansion is resolved only on the remote host", Target: fragment,
			Start: start, End: end,
		})
	}

	classifyCommandInto(&assessment, command, 0, 0, false)

	// Multiple shell segments are at least T1 even when every individual
	// segment only observes state. This preserves the historical rule that a
	// compound shell program never enters the no-prompt read-only shortcut.
	if assessment.Tier < tierRecoverable && len(nonEmptyShellSegments(command)) > 1 {
		assessment.Tier = tierRecoverable
	}
	assessment.Spans = collectRiskSpans(command, assessment.Findings)
	return assessment
}

// opaqueShellExpansion locates shell syntax whose value cannot be established
// from the request text. Single-quoted dollars/backticks are literals; outside
// single quotes they can choose a command or target at runtime and therefore
// floor the request at T2.
func opaqueShellExpansion(command string) (start, end int, fragment string, ok bool) {
	var quote byte
	escaped := false
	for i := 0; i < len(command); i++ {
		ch := command[i]
		if escaped {
			escaped = false
			continue
		}
		if ch == '\\' && quote != '\'' {
			escaped = true
			continue
		}
		if quote == '\'' {
			if ch == '\'' {
				quote = 0
			}
			continue
		}
		if quote == '"' {
			if ch == '"' {
				quote = 0
				continue
			}
		} else if ch == '\'' || ch == '"' {
			quote = ch
			continue
		}
		if ch == '*' || ch == '?' {
			return i, i + 1, command[i : i+1], true
		}
		if ch != '$' && ch != '`' {
			continue
		}
		end = i + 1
		if ch == '$' && end < len(command) && (command[end] == '(' || command[end] == '{') {
			end++
		}
		return i, end, command[i:end], true
	}
	if quote != 0 || escaped {
		return 0, len(command), strings.TrimSpace(command), true
	}
	return 0, 0, "", false
}

func nonEmptyShellSegments(command string) [][2]int {
	segments := make([][2]int, 0, 2)
	for _, span := range shellSegmentRanges(command) {
		if strings.TrimSpace(command[span[0]:span[1]]) != "" {
			segments = append(segments, span)
		}
	}
	return segments
}

// classifyCommandInto walks one shell level. offset is the byte position of
// command within the original request text so findings can point at real spans.
func classifyCommandInto(assessment *riskAssessment, command string, offset, depth int, privileged bool) {
	if depth > maxTierRecursionDepth {
		assessment.add(riskFinding{
			Tier: tierBounded, Category: riskUndecidable,
			Reason: "nested shell is too deep to analyse", Start: -1, End: -1,
		})
		return
	}

	// Pipe-into-interpreter is invisible to a per-segment walk because the pipe
	// is also the segment separator, so detect it on the raw text.
	if match := pipeIntoInterpreter(command); match != "" {
		assessment.add(riskFinding{
			Tier: tierBounded, Category: riskUndecidable,
			Reason: "output is piped into an interpreter", Target: match, Start: -1, End: -1,
		})
	}

	classifyCompoundWorkingDirectory(assessment, command, offset)

	for _, span := range shellSegmentRanges(command) {
		text := command[span[0]:span[1]]
		if strings.TrimSpace(text) == "" {
			continue
		}
		classifySegment(assessment, text, offset+span[0], depth, privileged)
	}
}

// classifyCompoundWorkingDirectory closes the gap between path classification
// and shell state. A relative target is normally scoped to an unknown remote
// cwd, but after an explicit `cd /...` in the same shell program it can be
// resolved. Without this pass, `cd / && rm -rf etc` looked like an ordinary
// bounded delete even though it removes /etc.
func classifyCompoundWorkingDirectory(assessment *riskAssessment, command string, offset int) {
	cwd := ""
	lastEnd := -1
	for _, span := range shellSegmentRanges(command) {
		segment := command[span[0]:span[1]]
		if strings.TrimSpace(segment) == "" {
			continue
		}
		if lastEnd >= 0 && !workingDirectoryFlowsAcross(command[lastEnd:span[0]]) {
			cwd = ""
		}
		lastEnd = span[1]

		tokens := tokenizeCommand(segment)
		if len(tokens) == 0 {
			continue
		}
		for i := range tokens {
			tokens[i].Start += offset + span[0]
			tokens[i].End += offset + span[0]
		}
		index, privileged, _ := skipPrivilegeWrappers(tokens)
		if index >= len(tokens) {
			cwd = ""
			continue
		}
		verbToken := tokens[index]
		verb := shellCommandName(verbToken.Text)
		ctx := &segmentCtx{
			assessment: assessment,
			verb:       verb,
			verbToken:  verbToken,
			args:       tokens[index+1:],
			privileged: privileged,
		}

		if verb == "cd" {
			operands := ctx.operands()
			if len(operands) == 0 || strings.ContainsAny(operands[0].Text, "$`") {
				cwd = ""
				continue
			}
			target := operands[0].Text
			if strings.HasPrefix(target, "/") {
				cwd = path.Clean(target)
			} else if cwd != "" && !strings.HasPrefix(target, "~") {
				cwd = path.Join(cwd, target)
			} else {
				cwd = ""
			}
			continue
		}
		if cwd == "" {
			continue
		}

		var targets []cmdToken
		switch verb {
		case "rm", "rmdir":
			targets = ctx.operands()
		case "find":
			if strings.Contains(strings.ToLower(ctx.joinedArgs()), "-delete") {
				targets = findSearchRoots(ctx.args)
			}
		}
		for i := range targets {
			token := targets[i]
			if strings.HasPrefix(token.Text, "/") || strings.HasPrefix(token.Text, "~") || strings.ContainsAny(token.Text, "$`") {
				continue
			}
			addResolvedDestructivePathFinding(ctx, path.Join(cwd, token.Text), &token)
		}
	}
}

func workingDirectoryFlowsAcross(separator string) bool {
	trimmed := strings.TrimSpace(separator)
	if trimmed == "" || trimmed == ";" || trimmed == "&&" {
		return true
	}
	// A newline is a sequence operator just like ';'. Pipes, `||`, and a
	// background `&` execute in a context where the previous cd is not known to
	// affect the next command.
	return strings.Trim(trimmed, "\r\n;") == ""
}

func addResolvedDestructivePathFinding(c *segmentCtx, resolved string, token *cmdToken) {
	verdict := classifyTargetPath(resolved)
	switch verdict.Class {
	case pathFilesystemRoot, pathBlockDevice, pathHomeRoot, pathSystemConfig, pathServicePayload:
		c.add(tierCritical, riskIrreversible, "destructive target resolves to a critical path", verdict.Display, token)
	case pathCredentialStore, pathSSHDir, pathBootPersistence:
		c.add(tierCritical, riskSelfLock, "destructive target resolves to credentials or access configuration", verdict.Display, token)
	}
}

func classifySegment(assessment *riskAssessment, segment string, offset, depth int, privileged bool) {
	tokens := tokenizeCommand(segment)
	if len(tokens) == 0 {
		return
	}
	for i := range tokens {
		tokens[i].Start += offset
		tokens[i].End += offset
	}

	// Redirections are part of the segment and can destroy or create data
	// regardless of the verb.
	classifyRedirections(assessment, tokens)

	index, priv, opaqueContext := skipPrivilegeWrappers(tokens)
	privileged = privileged || priv
	if opaqueContext {
		assessment.add(riskFinding{
			Tier: tierBounded, Category: riskUndecidable,
			Reason: "execution wrapper or environment changes program behaviour", Target: tokens[0].Text,
			Start: tokens[0].Start, End: tokens[0].End,
		})
	}
	if index >= len(tokens) {
		if !opaqueContext {
			assessment.add(riskFinding{
				Tier: tierBounded, Category: riskUndecidable,
				Reason: "execution wrapper has no explicit command", Target: tokens[0].Text,
				Start: tokens[0].Start, End: tokens[0].End,
			})
		}
		return
	}
	verbToken := tokens[index]
	verb := shellCommandName(verbToken.Text)

	// A nested shell (`bash -c '...'`) is analysed as its own command so that
	// the inner statements, not the wrapper, decide the tier.
	if isShellCommandName(verb) {
		if inner, ok := nestedShellScript(tokens[index:]); ok {
			classifyCommandInto(assessment, inner.Text, inner.Offset, depth+1, privileged)
			return
		}
		// A shell with no -c payload reads its program from stdin, which this
		// classifier cannot see.
		assessment.add(riskFinding{
			Tier: tierBounded, Category: riskUndecidable,
			Reason: "shell reads its program from stdin", Target: verb,
			Start: verbToken.Start, End: verbToken.End,
		})
		return
	}

	ctx := &segmentCtx{
		assessment: assessment,
		verb:       verb,
		verbToken:  verbToken,
		args:       tokens[index+1:],
		privileged: privileged,
		depth:      depth,
	}
	classifyVerb(ctx)
}

// segmentCtx carries one resolved command invocation through the verb rules.
type segmentCtx struct {
	assessment *riskAssessment
	verb       string
	verbToken  cmdToken
	args       []cmdToken
	privileged bool
	depth      int
}

func (c *segmentCtx) add(tier commandTier, category riskCategory, reason string, target string, token *cmdToken) {
	finding := riskFinding{Tier: tier, Category: category, Reason: reason, Target: target, Start: -1, End: -1}
	if token != nil {
		finding.Start = token.Start
		finding.End = token.End
	} else {
		finding.Start = c.verbToken.Start
		finding.End = c.verbToken.End
	}
	// A privilege wrapper may only raise a tier, never lower one. It also lifts
	// pure observation to T1: files that are readable only as root are usually
	// protected for a reason, and reading them unattended deserves a record.
	if c.privileged && finding.Tier == tierObserve {
		finding.Tier = tierRecoverable
		finding.Reason = finding.Reason + " as root"
	}
	c.assessment.add(finding)
}

// flagSet returns the short and long flags present in the argument list.
func (c *segmentCtx) flagSet() map[string]bool {
	flags := map[string]bool{}
	for _, arg := range c.args {
		text := arg.Text
		if text == "--" {
			break
		}
		if strings.HasPrefix(text, "--") {
			name := strings.TrimPrefix(text, "--")
			if eq := strings.Index(name, "="); eq >= 0 {
				name = name[:eq]
			}
			flags["--"+name] = true
			continue
		}
		if strings.HasPrefix(text, "-") && len(text) > 1 {
			for _, r := range text[1:] {
				flags["-"+string(r)] = true
			}
		}
	}
	return flags
}

func (c *segmentCtx) hasFlag(names ...string) bool {
	flags := c.flagSet()
	for _, name := range names {
		if flags[name] {
			return true
		}
	}
	return false
}

// operands returns the non-flag arguments, i.e. the objects acted upon.
func (c *segmentCtx) operands() []cmdToken {
	operands := make([]cmdToken, 0, len(c.args))
	passthrough := false
	for _, arg := range c.args {
		if !passthrough {
			if arg.Text == "--" {
				passthrough = true
				continue
			}
			if strings.HasPrefix(arg.Text, "-") && len(arg.Text) > 1 {
				continue
			}
			if strings.HasPrefix(arg.Text, ">") || strings.HasPrefix(arg.Text, "<") {
				continue
			}
		}
		if arg.Text == "" {
			continue
		}
		operands = append(operands, arg)
	}
	return operands
}

// subcommand returns the first operand, which for tools like git/apt/docker
// selects the actual behaviour.
func (c *segmentCtx) subcommand() string {
	for _, arg := range c.args {
		if strings.HasPrefix(arg.Text, "-") {
			continue
		}
		return strings.ToLower(arg.Text)
	}
	return ""
}

func (c *segmentCtx) joinedArgs() string {
	parts := make([]string, 0, len(c.args))
	for _, arg := range c.args {
		parts = append(parts, arg.Text)
	}
	return strings.Join(parts, " ")
}

// classifyRedirections scores `>` and `>>` targets. Truncation destroys existing
// content, so it is bounded destruction unless the target is a rebuildable
// artifact or a temporary file; appending only adds.
func classifyRedirections(assessment *riskAssessment, tokens []cmdToken) {
	for i, token := range tokens {
		text := token.Text
		if !strings.HasPrefix(text, ">") {
			continue
		}
		append := strings.HasPrefix(text, ">>")
		target := strings.TrimLeft(text, ">")
		targetToken := token
		if strings.TrimSpace(target) == "" && i+1 < len(tokens) {
			targetToken = tokens[i+1]
			target = targetToken.Text
		}
		if strings.TrimSpace(target) == "" {
			continue
		}
		verdict := classifyTargetPath(target)
		switch verdict.Class {
		case pathBlockDevice:
			assessment.add(riskFinding{
				Tier: tierCritical, Category: riskIrreversible,
				Reason: "writes directly to a block device", Target: verdict.Display,
				Start: targetToken.Start, End: targetToken.End,
			})
		case pathSystemConfig:
			assessment.add(riskFinding{
				Tier: tierCritical, Category: riskSelfLock,
				Reason: "writes into a system path", Target: verdict.Display,
				Start: targetToken.Start, End: targetToken.End,
			})
		case pathBootPersistence:
			assessment.add(riskFinding{
				Tier: tierBounded, Category: riskPersistence,
				Reason: "writes a path that runs on boot or login", Target: verdict.Display,
				Start: targetToken.Start, End: targetToken.End,
			})
		case pathUnresolvable:
			assessment.add(riskFinding{
				Tier: tierBounded, Category: riskUndecidable,
				Reason: "redirect target cannot be resolved", Target: verdict.Display,
				Start: targetToken.Start, End: targetToken.End,
			})
		default:
			if append || verdict.Class == pathTemp || verdict.Class == pathArtifact {
				assessment.add(riskFinding{
					Tier: tierRecoverable, Category: riskWrite,
					Reason: "writes a file", Target: verdict.Display,
					Start: targetToken.Start, End: targetToken.End,
				})
				continue
			}
			assessment.add(riskFinding{
				Tier: tierBounded, Category: riskDestructive,
				Reason: "truncates an existing file", Target: verdict.Display,
				Start: targetToken.Start, End: targetToken.End,
			})
		}
	}
}

// skipPrivilegeWrappers advances to the command behind common wrappers. The
// third result marks wrappers or assignment prefixes that can change which
// program runs or how it behaves; callers floor those requests at T2 even when
// the inner command looks read-only.
func skipPrivilegeWrappers(tokens []cmdToken) (int, bool, bool) {
	privileged := false
	opaqueContext := false
	i := 0
	for i < len(tokens) {
		name := shellCommandName(tokens[i].Text)
		switch name {
		case "sudo":
			privileged = true
			i++
			var risky bool
			i, risky = skipWrapperOptions(tokens, i, map[string]bool{
				"-u": true, "--user": true, "-g": true, "--group": true,
				"-h": true, "--host": true, "-p": true, "--prompt": true,
				"-C": true, "--close-from": true, "-T": true, "--command-timeout": true,
				"-r": true, "--role": true, "-t": true, "--type": true,
				"-D": true, "--chdir": true,
			}, map[string]bool{"-E": true, "--preserve-env": true, "-D": true, "--chdir": true})
			opaqueContext = opaqueContext || risky
			continue
		case "doas":
			privileged = true
			i++
			i, _ = skipWrapperOptions(tokens, i,
				map[string]bool{"-u": true, "-C": true}, nil)
			continue
		case "env":
			opaqueContext = true
			i++
			i, _ = skipWrapperOptions(tokens, i, map[string]bool{
				"-u": true, "--unset": true, "-C": true, "--chdir": true, "-S": true, "--split-string": true,
			}, nil)
			continue
		case "timeout":
			i++
			i, _ = skipWrapperOptions(tokens, i, map[string]bool{
				"-k": true, "--kill-after": true, "-s": true, "--signal": true,
			}, nil)
			if i < len(tokens) { // duration
				i++
			}
			continue
		case "nice":
			i++
			i, _ = skipWrapperOptions(tokens, i, map[string]bool{"-n": true, "--adjustment": true}, nil)
			continue
		case "ionice":
			i++
			i, _ = skipWrapperOptions(tokens, i, map[string]bool{
				"-c": true, "--class": true, "-n": true, "--classdata": true,
				"-p": true, "--pid": true, "-P": true, "--pgid": true, "-u": true, "--uid": true,
			}, nil)
			continue
		case "stdbuf":
			i++
			i, _ = skipWrapperOptions(tokens, i, map[string]bool{
				"-i": true, "--input": true, "-o": true, "--output": true, "-e": true, "--error": true,
			}, nil)
			continue
		case "time":
			i++
			i, _ = skipWrapperOptions(tokens, i, map[string]bool{
				"-f": true, "--format": true, "-o": true, "--output": true,
			}, nil)
			continue
		case "exec":
			i++
			i, _ = skipWrapperOptions(tokens, i, map[string]bool{"-a": true}, nil)
			continue
		case "command", "setsid":
			i++
			i, _ = skipWrapperOptions(tokens, i, nil, nil)
			if name == "setsid" {
				opaqueContext = true
			}
			continue
		case "nohup":
			opaqueContext = true
			i++
			i, _ = skipWrapperOptions(tokens, i, nil, nil)
			continue
		default:
			// An environment-assignment prefix (FOO=bar cmd) is also a wrapper.
			if isEnvironmentAssignment(tokens[i].Text) {
				opaqueContext = true
				i++
				continue
			}
			return i, privileged, opaqueContext
		}
	}
	return i, privileged, opaqueContext
}

// skipWrapperOptions consumes options for one already-consumed wrapper. An
// option in valueOptions consumes the following token only when its value was
// not attached with '=' or to a short option. riskyOptions are transparent to
// parsing but make the execution context opaque (for example sudo -E).
func skipWrapperOptions(tokens []cmdToken, index int, valueOptions, riskyOptions map[string]bool) (int, bool) {
	risky := false
	for index < len(tokens) {
		text := tokens[index].Text
		if text == "--" {
			return index + 1, risky
		}
		if text == "-" || !strings.HasPrefix(text, "-") {
			return index, risky
		}
		name := text
		hasAttachedValue := false
		if equals := strings.Index(name, "="); equals >= 0 {
			name = name[:equals]
			hasAttachedValue = true
		} else if strings.HasPrefix(name, "-") && !strings.HasPrefix(name, "--") && len(name) > 2 {
			name = name[:2]
			hasAttachedValue = true
		}
		if riskyOptions[name] {
			risky = true
		}
		index++
		if valueOptions[name] && !hasAttachedValue && index < len(tokens) {
			index++
		}
	}
	return index, risky
}

func isEnvironmentAssignment(text string) bool {
	equals := strings.IndexByte(text, '=')
	if equals <= 0 {
		return false
	}
	for i, r := range text[:equals] {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '_' || (i > 0 && r >= '0' && r <= '9') {
			continue
		}
		return false
	}
	return true
}

// nestedShellScript extracts the script text passed to a shell's -c option
// together with its byte offset in the original request, so findings inside the
// nested script still anchor to real spans.
type nestedScript struct {
	Text   string
	Offset int
}

func nestedShellScript(tokens []cmdToken) (nestedScript, bool) {
	for i := 1; i < len(tokens)-1; i++ {
		text := tokens[i].Text
		if text == "--" {
			break
		}
		if !strings.HasPrefix(text, "-") {
			break
		}
		if !strings.Contains(strings.TrimLeft(text, "-"), "c") {
			continue
		}
		payload := tokens[i+1]
		offset := payload.Start
		// Only a plainly quoted or bare payload can be mapped back to exact
		// offsets. When the raw form was rewritten by quote stripping, keep the
		// text (tier still matters) but drop offset precision.
		if len(payload.Raw) == len(payload.Text)+2 && (strings.HasPrefix(payload.Raw, "'") || strings.HasPrefix(payload.Raw, `"`)) {
			offset++
		} else if payload.Raw != payload.Text {
			offset = -1
		}
		return nestedScript{Text: payload.Text, Offset: offset}, true
	}
	return nestedScript{}, false
}

var interpreterNames = map[string]bool{
	"sh": true, "bash": true, "dash": true, "zsh": true, "ksh": true, "fish": true,
	"python": true, "python2": true, "python3": true, "perl": true, "ruby": true,
	"node": true, "php": true, "lua": true, "tclsh": true,
}

// pipeIntoInterpreter reports the interpreter a pipeline feeds, if any. Text
// arriving on an interpreter's stdin is arbitrary code this classifier cannot
// inspect.
func pipeIntoInterpreter(command string) string {
	ranges := shellSegmentRanges(command)
	if len(ranges) < 2 {
		return ""
	}
	for i := 1; i < len(ranges); i++ {
		// Only a `|` separator feeds stdin; `;` and `&&` do not.
		sep := ranges[i][0] - 1
		if sep < 0 || sep >= len(command) || command[sep] != '|' {
			continue
		}
		tokens := tokenizeCommand(command[ranges[i][0]:ranges[i][1]])
		if len(tokens) == 0 {
			continue
		}
		index, _, _ := skipPrivilegeWrappers(tokens)
		if index >= len(tokens) {
			continue
		}
		name := shellCommandName(tokens[index].Text)
		if interpreterNames[name] {
			// An interpreter with an explicit script file argument is not being
			// fed its program by the pipe.
			if name != "sh" && name != "bash" && name != "dash" && name != "zsh" && name != "ksh" {
				continue
			}
			return name
		}
	}
	return ""
}

// opaqueVerbs cannot be analysed from their command line alone: they decode,
// evaluate, or hand off to another program chosen at runtime.
var opaqueVerbs = map[string]string{
	"eval": "evaluates text as code", "base64": "decodes opaque data",
	"xxd": "decodes opaque data", "uudecode": "decodes opaque data",
	"xargs": "builds a command line at runtime", "awk": "can execute arbitrary programs",
	"perl": "can execute arbitrary programs", "python": "can execute arbitrary programs",
	"python2": "can execute arbitrary programs", "python3": "can execute arbitrary programs",
	"ruby": "can execute arbitrary programs", "node": "can execute arbitrary programs",
	"php": "can execute arbitrary programs", "watch": "repeats another command",
	"timeout": "wraps another command", "screen": "detaches another command",
	"tmux": "detaches another command", "at": "defers another command",
	"batch": "defers another command", "source": "runs another script", ".": "runs another script",
}

// classifyVerb applies the per-behaviour rules. Verbs are grouped by what they
// do rather than by how dangerous their name sounds; the tier almost always
// comes from the target, which is why every branch inspects operands.
func classifyVerb(c *segmentCtx) {
	if reason, ok := opaqueVerbs[c.verb]; ok {
		c.add(tierBounded, riskUndecidable, "opaque command: "+reason, c.verb, nil)
		return
	}
	if handler, ok := verbHandlers[c.verb]; ok {
		handler(c)
		return
	}
	if _, ok := readOnlyCommands[c.verb]; ok {
		c.add(tierObserve, riskObserve, "read-only observation", c.verb, nil)
		return
	}
	if tier, category, reason, ok := simpleVerbTier(c.verb); ok {
		target := c.verb
		var targetToken *cmdToken
		// Storage-destruction verbs act on their final operand. Preserve that
		// target so the approval explanation names what will be destroyed.
		if tier == tierCritical && category == riskIrreversible {
			operands := c.operands()
			if len(operands) > 0 {
				operand := operands[len(operands)-1]
				target = operand.Text
				targetToken = &operand
			}
		}
		c.add(tier, category, reason, target, targetToken)
		return
	}
	// Unknown program, or a path-qualified executable whose behaviour is not
	// knowable from its name. Floored at T2 by rule 1.
	target := c.verb
	reason := "unrecognised command"
	if strings.Contains(c.verbToken.Text, "/") {
		reason = "runs an executable by path"
	}
	c.add(tierBounded, riskUndecidable, reason, target, nil)
}

// simpleVerbTier covers verbs whose tier does not depend on their operands.
func simpleVerbTier(verb string) (commandTier, riskCategory, string, bool) {
	if tier, ok := irreversibleVerbs[verb]; ok {
		return tierCritical, riskIrreversible, tier, true
	}
	// Filesystem builders are almost always spelled with the type as a suffix
	// (mkfs.ext4, mkfs.xfs, mkfs.vfat). Matching only the bare `mkfs` would
	// leave every real-world invocation to the undecidable fallback at T2.
	if strings.HasPrefix(verb, "mkfs.") || strings.HasPrefix(verb, "mkfs-") {
		return tierCritical, riskIrreversible, "formats a filesystem", true
	}
	if reason, ok := selfLockVerbs[verb]; ok {
		return tierCritical, riskSelfLock, reason, true
	}
	if reason, ok := boundedVerbs[verb]; ok {
		return tierBounded, riskDestructive, reason, true
	}
	if reason, ok := recoverableVerbs[verb]; ok {
		return tierRecoverable, riskWrite, reason, true
	}
	return 0, "", "", false
}

// irreversibleVerbs destroy storage or cloud resources outright (T3-a).
var irreversibleVerbs = map[string]string{
	"mkfs":       "formats a filesystem",
	"mke2fs":     "formats a filesystem",
	"mkswap":     "reformats a swap device",
	"wipefs":     "erases filesystem signatures",
	"shred":      "overwrites data irrecoverably",
	"blkdiscard": "discards all blocks on a device",
	"fdisk":      "rewrites a partition table",
	"sfdisk":     "rewrites a partition table",
	"cfdisk":     "rewrites a partition table",
	"parted":     "rewrites a partition table",
	"sgdisk":     "rewrites a partition table",
	"gdisk":      "rewrites a partition table",
	"pvremove":   "removes an LVM physical volume",
	"vgremove":   "removes an LVM volume group",
	"lvremove":   "removes an LVM logical volume",
}

// selfLockVerbs can cost access to the machine itself (T3-b).
var selfLockVerbs = map[string]string{
	"shutdown": "powers the machine down",
	"poweroff": "powers the machine down",
	"halt":     "halts the machine",
	"reboot":   "reboots the machine",
	"userdel":  "deletes a user account",
	"groupdel": "deletes a group",
	"visudo":   "edits the sudoers policy",
	"ifdown":   "takes a network interface down",
}

// boundedVerbs destroy or disrupt something with a clear blast radius (T2).
var boundedVerbs = map[string]string{
	"kill": "signals a process", "pkill": "signals processes by name",
	"killall": "signals processes by name", "truncate": "truncates a file",
	"chattr": "changes file attributes", "setfacl": "changes access control lists",
	"usermod": "changes a user account", "groupmod": "changes a group",
	"useradd": "creates a user account", "adduser": "creates a user account",
	"groupadd": "creates a group",
	"swapoff":  "disables swap", "umount": "unmounts a filesystem",
	"mount": "mounts a filesystem", "modprobe": "loads a kernel module",
	"sysctl": "changes kernel parameters", "insmod": "loads a kernel module",
	"rmmod": "unloads a kernel module",
	"ufw":   "changes firewall rules", "firewall-cmd": "changes firewall rules",
	"nc": "opens a raw network connection", "ncat": "opens a raw network connection",
	"socat": "relays a network connection", "ssh": "connects onward to another host",
	"telnet": "opens a raw network connection",
}

// recoverableVerbs make a scoped local change whose target still decides the
// final tier (T1 when their operands satisfy the T1 conditions).
var recoverableVerbs = map[string]string{
	"cd":   "changes the working directory for this command",
	"make": "runs a build", "cmake": "configures a build",
	"cargo": "runs a Rust build", "go": "runs a Go build",
	"mvn": "runs a Maven build", "gradle": "runs a Gradle build",
	"dotnet": "runs a .NET build", "pytest": "runs tests",
	"tox": "runs tests", "composer": "manages PHP dependencies",
	"bundle": "manages Ruby dependencies", "supervisorctl": "controls a supervised service",
}

var verbHandlers = map[string]func(*segmentCtx){
	"rm":         classifyRemove,
	"rmdir":      classifyRemove,
	"dd":         classifyDD,
	"cp":         classifyCopyMove,
	"mv":         classifyCopyMove,
	"tee":        classifyWriteTarget,
	"mkdir":      classifyFilesystemWrite,
	"touch":      classifyFilesystemWrite,
	"ln":         classifyFilesystemWrite,
	"install":    classifyFilesystemWrite,
	"gzip":       classifyFilesystemWrite,
	"gunzip":     classifyFilesystemWrite,
	"bzip2":      classifyFilesystemWrite,
	"xz":         classifyFilesystemWrite,
	"unxz":       classifyFilesystemWrite,
	"zip":        classifyArchiveTool,
	"unzip":      classifyArchiveTool,
	"patch":      classifyOpaqueFileProgram,
	"curl":       classifyNetworkTransfer,
	"wget":       classifyNetworkTransfer,
	"rsync":      classifyNetworkTransfer,
	"scp":        classifyNetworkTransfer,
	"sftp":       classifyNetworkTransfer,
	"journalctl": classifyJournalctl,
	"sed":        classifySed,
	"chmod":      classifyPermission,
	"chown":      classifyPermission,
	"chgrp":      classifyPermission,
	"git":        classifyGit,
	"systemctl":  classifySystemctl,
	"service":    classifySystemctl,
	"docker":     classifyDocker,
	"podman":     classifyDocker,
	"apt":        classifyPackage,
	"apt-get":    classifyPackage,
	"dnf":        classifyPackage,
	"yum":        classifyPackage,
	"pacman":     classifyPackage,
	"zypper":     classifyPackage,
	"pip":        classifyPackage,
	"pip3":       classifyPackage,
	"npm":        classifyPackage,
	"pnpm":       classifyPackage,
	"yarn":       classifyPackage,
	"iptables":   classifyFirewall,
	"ip6tables":  classifyFirewall,
	"nft":        classifyNft,
	"find":       classifyFind,
	"tar":        classifyTar,
	"mysql":      classifyDatabase,
	"psql":       classifyDatabase,
	"mongosh":    classifyDatabase,
	"redis-cli":  classifyDatabase,
	"sqlite3":    classifyDatabase,
	"kubectl":    classifyKubectl,
	"terraform":  classifyTerraform,
	"aws":        classifyAWS,
	"ip":         classifyIP,
	"ifconfig":   classifyIP,
	"init":       classifyInit,
	"telinit":    classifyInit,
	"crontab":    classifyCrontab,
	"zpool":      classifyStoragePool,
	"zfs":        classifyStoragePool,
	"mdadm":      classifyStoragePool,
	"passwd":     classifyPasswd,
}

// classifyFilesystemWrite handles ordinary filesystem tools whose risk comes
// from their target, not their name. It deliberately inspects every operand:
// some tools accept several destinations, and missing one system path here
// would incorrectly put the whole request in the unattended T1 lane.
func classifyFilesystemWrite(c *segmentCtx) {
	operands := c.operands()
	if len(operands) == 0 {
		c.add(tierBounded, riskUndecidable, "filesystem operation has no explicit target", c.verb, nil)
		return
	}
	// ln/install use the final operand as the write destination. Compression
	// tools rewrite each operand in place, while mkdir/touch create each one.
	targets := operands
	if c.verb == "ln" || c.verb == "install" {
		if target, ok := commandOptionValue(c.args, "-t", "--target-directory"); ok {
			targets = []cmdToken{target}
		} else {
			targets = operands[len(operands)-1:]
		}
	}
	for i := range targets {
		token := targets[i]
		verdict := classifyTargetPath(token.Text)
		switch verdict.Class {
		case pathUnresolvable:
			c.add(tierBounded, riskUndecidable, "write target cannot be resolved", verdict.Display, &token)
		case pathFilesystemRoot, pathBlockDevice:
			c.add(tierCritical, riskIrreversible, "writes to a storage-critical target", verdict.Display, &token)
		case pathSystemConfig:
			c.add(tierCritical, riskSelfLock, "writes into a system path", verdict.Display, &token)
		case pathCredentialStore, pathSSHDir:
			c.add(tierCritical, riskSelfLock, "writes credentials or SSH configuration", verdict.Display, &token)
		case pathBootPersistence:
			c.add(tierBounded, riskPersistence, "writes a path that runs on boot or login", verdict.Display, &token)
		default:
			c.add(tierRecoverable, riskWrite, "writes a filesystem path", verdict.Display, &token)
		}
	}
}

func classifyArchiveTool(c *segmentCtx) {
	c.add(tierBounded, riskUndecidable, "archive contents can choose or replace filesystem paths", c.joinedArgs(), nil)
}

func classifyOpaqueFileProgram(c *segmentCtx) {
	c.add(tierBounded, riskUndecidable, "input data chooses which files are modified", c.joinedArgs(), nil)
}

// Network copy tools can both read and mutate a peer and may move local data
// off-host. Their command lines are too expressive to prove local/recoverable,
// so they never enter unattended T1.
func classifyNetworkTransfer(c *segmentCtx) {
	c.add(tierBounded, riskUndecidable, "network transfer can move data or change a remote target", c.joinedArgs(), nil)
}

func classifyJournalctl(c *segmentCtx) {
	if c.hasFlag("--vacuum-size", "--vacuum-time", "--vacuum-files", "--rotate", "--flush", "--sync", "--relinquish-var") {
		c.add(tierBounded, riskDestructive, "changes or removes journal data", c.joinedArgs(), nil)
		return
	}
	c.add(tierObserve, riskObserve, "reads the system journal", c.joinedArgs(), nil)
}

// classifyCrontab separates listing scheduled jobs from replacing or erasing
// them. `crontab -l` is pure observation, and treating it as a change was
// exactly the kind of verb-name blanket rule this policy exists to remove.
func classifyCrontab(c *segmentCtx) {
	flags := c.flagSet()
	args := c.joinedArgs()
	switch {
	case flags["-r"]:
		// Removing a crontab has no undo and no confirmation of its own.
		c.add(tierCritical, riskIrreversible, "erases the crontab", args, nil)
	case flags["-l"]:
		c.add(tierObserve, riskObserve, "lists scheduled jobs", args, nil)
	case flags["-e"]:
		c.add(tierBounded, riskPersistence, "edits scheduled jobs interactively", args, nil)
	default:
		// Installing a file as the crontab replaces whatever was there and makes
		// code run later, which is persistence rather than an ordinary write.
		c.add(tierBounded, riskPersistence, "replaces scheduled jobs", args, nil)
	}
}

// storagePoolReadSubcommands only report state.
var storagePoolReadSubcommands = map[string]bool{
	"status": true, "list": true, "get": true, "history": true, "iostat": true,
	"events": true, "version": true, "--detail": true, "--examine": true,
	"--query": true, "--detail-platform": true,
}

// storagePoolDestructiveSubcommands discard data or redundancy.
var storagePoolDestructiveSubcommands = map[string]bool{
	"destroy": true, "labelclear": true, "--zero-superblock": true, "--fail": true,
	"--remove": true, "--stop": true, "split": true, "rollback": true,
}

// classifyStoragePool scores zpool/zfs/mdadm by subcommand. Reporting pool state
// is observation; destroying a pool or zeroing a RAID superblock is not
// recoverable from the host.
func classifyStoragePool(c *segmentCtx) {
	args := c.joinedArgs()
	sub := c.subcommand()
	flags := c.flagSet()
	for candidate := range storagePoolDestructiveSubcommands {
		if sub == candidate || flags[candidate] {
			c.add(tierCritical, riskIrreversible, "destroys a storage pool or array member", args, nil)
			return
		}
	}
	if storagePoolReadSubcommands[sub] {
		c.add(tierObserve, riskObserve, "reports storage pool state", args, nil)
		return
	}
	for candidate := range storagePoolReadSubcommands {
		if flags[candidate] {
			c.add(tierObserve, riskObserve, "reports storage pool state", args, nil)
			return
		}
	}
	if sub == "" {
		c.add(tierObserve, riskObserve, "reports storage pool state", args, nil)
		return
	}
	c.add(tierBounded, riskUndecidable, "changes a storage pool", args, nil)
}

// classifyPasswd distinguishes changing your own password from changing root's
// or locking an account, which are ways to lose administrative access.
func classifyPasswd(c *segmentCtx) {
	args := c.joinedArgs()
	flags := c.flagSet()
	if flags["-l"] || flags["--lock"] || flags["-d"] || flags["--delete"] || flags["-e"] || flags["--expire"] {
		c.add(tierCritical, riskSelfLock, "locks, clears or expires an account password", args, nil)
		return
	}
	for _, operand := range c.operands() {
		if strings.EqualFold(operand.Text, "root") {
			c.add(tierCritical, riskSelfLock, "changes the root password", operand.Text, &operand)
			return
		}
	}
	if flags["-S"] || flags["--status"] {
		c.add(tierObserve, riskObserve, "reports password status", args, nil)
		return
	}
	c.add(tierBounded, riskDestructive, "changes a password", args, nil)
}

// classifyRemove reuses the existing critical-target analysis but reports it as
// a tier instead of an unconditional block, so a legitimate removal under a
// system path can still be authorized with an explicit confirmation rather than
// forcing the operator out of the tool.
func classifyRemove(c *segmentCtx) {
	operands := c.operands()
	forced := c.hasFlag("-f", "--force") || c.hasFlag("-r", "-R", "--recursive")
	if len(operands) == 0 {
		if forced {
			c.add(tierBounded, riskUndecidable, "forced removal has no explicit target", "", nil)
		}
		return
	}
	for i := range operands {
		token := operands[i]
		verdict := classifyTargetPath(token.Text)
		switch {
		case verdict.Class == pathUnresolvable:
			c.add(tierBounded, riskUndecidable, "removal target cannot be resolved", verdict.Display, &token)
		case verdict.Class == pathFilesystemRoot:
			c.add(tierCritical, riskIrreversible, "removal targets the filesystem root", verdict.Display, &token)
		case verdict.Class == pathCredentialStore, verdict.Class == pathSSHDir:
			c.add(tierCritical, riskSelfLock, "removal targets credentials or SSH keys", verdict.Display, &token)
		case verdict.Class == pathHomeRoot:
			c.add(tierCritical, riskIrreversible, "removal targets a home directory", verdict.Display, &token)
		case verdict.Class == pathSystemConfig, verdict.Class == pathServicePayload:
			c.add(tierCritical, riskIrreversible, "removal targets a system path", verdict.Display, &token)
		case verdict.Class == pathBootPersistence:
			c.add(tierCritical, riskSelfLock, "removal targets boot or login configuration", verdict.Display, &token)
		case verdict.Class == pathArtifact:
			// The one deliberate T1 removal: a rebuildable build artifact inside
			// the working tree. Regenerating it is a build away, which is what
			// makes it recoverable in the sense T1 requires.
			c.add(tierRecoverable, riskWrite, "removes rebuildable build output", verdict.Display, &token)
		case verdict.Class == pathTemp:
			c.add(tierRecoverable, riskWrite, "removes a temporary path", verdict.Display, &token)
		default:
			c.add(tierBounded, riskDestructive, "deletes files", verdict.Display, &token)
		}
	}
}

func classifyDD(c *segmentCtx) {
	output := ""
	var outputToken *cmdToken
	for i := range c.args {
		if strings.HasPrefix(c.args[i].Text, "of=") {
			output = strings.TrimPrefix(c.args[i].Text, "of=")
			outputToken = &c.args[i]
		}
	}
	if output == "" {
		c.add(tierRecoverable, riskObserve, "reads data with dd", "", nil)
		return
	}
	verdict := classifyTargetPath(output)
	switch verdict.Class {
	case pathBlockDevice:
		c.add(tierCritical, riskIrreversible, "writes raw data to a block device", verdict.Display, outputToken)
	case pathUnresolvable:
		c.add(tierBounded, riskUndecidable, "dd output target cannot be resolved", verdict.Display, outputToken)
	case pathSystemConfig:
		c.add(tierCritical, riskSelfLock, "writes raw data into a system path", verdict.Display, outputToken)
	case pathTemp, pathArtifact:
		c.add(tierRecoverable, riskWrite, "writes a file with dd", verdict.Display, outputToken)
	default:
		c.add(tierBounded, riskDestructive, "overwrites a file with dd", verdict.Display, outputToken)
	}
}

// classifyCopyMove scores the destination, and for mv also the source, which is
// removed by the operation.
func classifyCopyMove(c *segmentCtx) {
	operands := c.operands()
	if len(operands) < 2 {
		if len(operands) == 1 {
			c.add(tierBounded, riskUndecidable, "copy or move has no explicit destination", operands[0].Text, &operands[0])
		}
		return
	}
	destination := operands[len(operands)-1]
	if target, ok := commandOptionValue(c.args, "-t", "--target-directory"); ok {
		destination = target
	}
	verdict := classifyTargetPath(destination.Text)
	forced := c.hasFlag("-f", "--force")
	switch verdict.Class {
	case pathUnresolvable:
		c.add(tierBounded, riskUndecidable, "destination cannot be resolved", verdict.Display, &destination)
	case pathBlockDevice:
		c.add(tierCritical, riskIrreversible, "writes over a block device", verdict.Display, &destination)
	case pathSystemConfig:
		c.add(tierCritical, riskSelfLock, "writes into a system path", verdict.Display, &destination)
	case pathBootPersistence:
		c.add(tierBounded, riskPersistence, "writes a path that runs on boot or login", verdict.Display, &destination)
	case pathCredentialStore, pathSSHDir:
		c.add(tierCritical, riskSelfLock, "writes over credentials or SSH keys", verdict.Display, &destination)
	default:
		if forced {
			c.add(tierBounded, riskDestructive, "replaces an existing destination", verdict.Display, &destination)
		} else {
			c.add(tierRecoverable, riskWrite, "writes a file", verdict.Display, &destination)
		}
	}
	if c.verb == "mv" {
		for i := 0; i < len(operands)-1; i++ {
			source := operands[i]
			sourceVerdict := classifyTargetPath(source.Text)
			switch sourceVerdict.Class {
			case pathSystemConfig, pathServicePayload:
				c.add(tierCritical, riskSelfLock, "moves a system path away", sourceVerdict.Display, &source)
			case pathCredentialStore, pathSSHDir:
				c.add(tierCritical, riskSelfLock, "moves credentials or SSH keys away", sourceVerdict.Display, &source)
			case pathBootPersistence:
				c.add(tierBounded, riskPersistence, "moves boot or login configuration away", sourceVerdict.Display, &source)
			}
		}
	}
}

// commandOptionValue extracts a path-valued option in either `-t DIR`,
// `-tDIR`, `--target-directory DIR`, or `--target-directory=DIR` form. Tools
// such as cp, mv, ln, and install otherwise make the final positional operand
// look like the destination even though the option redirects writes elsewhere.
func commandOptionValue(args []cmdToken, short, long string) (cmdToken, bool) {
	for i := range args {
		text := args[i].Text
		if text == short || text == long {
			if i+1 < len(args) {
				return args[i+1], true
			}
			return cmdToken{}, false
		}
		if strings.HasPrefix(text, long+"=") {
			token := args[i]
			token.Text = strings.TrimPrefix(text, long+"=")
			return token, token.Text != ""
		}
		if strings.HasPrefix(text, short) && len(text) > len(short) && !strings.HasPrefix(text, "--") {
			token := args[i]
			token.Text = strings.TrimPrefix(text, short)
			return token, token.Text != ""
		}
	}
	return cmdToken{}, false
}

// classifyWriteTarget covers verbs whose operands are all write destinations.
func classifyWriteTarget(c *segmentCtx) {
	operands := c.operands()
	appendOnly := c.hasFlag("-a", "--append")
	if len(operands) == 0 {
		c.add(tierRecoverable, riskWrite, "writes to standard output", "", nil)
		return
	}
	for i := range operands {
		token := operands[i]
		verdict := classifyTargetPath(token.Text)
		switch verdict.Class {
		case pathUnresolvable:
			c.add(tierBounded, riskUndecidable, "write target cannot be resolved", verdict.Display, &token)
		case pathSystemConfig:
			c.add(tierCritical, riskSelfLock, "writes into a system path", verdict.Display, &token)
		case pathBlockDevice:
			c.add(tierCritical, riskIrreversible, "writes to a block device", verdict.Display, &token)
		case pathCredentialStore, pathSSHDir:
			c.add(tierCritical, riskSelfLock, "writes over credentials or SSH keys", verdict.Display, &token)
		case pathBootPersistence:
			c.add(tierBounded, riskPersistence, "writes a path that runs on boot or login", verdict.Display, &token)
		default:
			if appendOnly || verdict.Class == pathTemp || verdict.Class == pathArtifact {
				c.add(tierRecoverable, riskWrite, "writes a file", verdict.Display, &token)
			} else {
				c.add(tierBounded, riskDestructive, "overwrites a file", verdict.Display, &token)
			}
		}
	}
}

// classifySed distinguishes a read-only stream edit from an in-place rewrite.
// An in-place edit of a working-tree file is the single most common AI action,
// and is genuinely scoped and recoverable; the same edit against /etc is not.
func classifySed(c *segmentCtx) {
	inPlace := false
	for _, arg := range c.args {
		if arg.Text == "-i" || strings.HasPrefix(arg.Text, "-i") && !strings.HasPrefix(arg.Text, "--") {
			inPlace = true
		}
		if strings.HasPrefix(arg.Text, "--in-place") {
			inPlace = true
		}
	}
	if !inPlace {
		c.add(tierObserve, riskObserve, "reads and transforms text", "", nil)
		return
	}
	operands := c.operands()
	if len(operands) < 2 {
		c.add(tierBounded, riskUndecidable, "in-place edit has no explicit file", "", nil)
		return
	}
	for i := 1; i < len(operands); i++ {
		token := operands[i]
		verdict := classifyTargetPath(token.Text)
		switch verdict.Class {
		case pathUnresolvable:
			c.add(tierBounded, riskUndecidable, "in-place edit target cannot be resolved", verdict.Display, &token)
		case pathSystemConfig:
			c.add(tierCritical, riskSelfLock, "edits a system configuration file in place", verdict.Display, &token)
		case pathBootPersistence:
			c.add(tierBounded, riskPersistence, "edits boot or login configuration in place", verdict.Display, &token)
		case pathCredentialStore, pathSSHDir:
			c.add(tierCritical, riskSelfLock, "edits credentials or SSH keys in place", verdict.Display, &token)
		default:
			c.add(tierRecoverable, riskWrite, "edits a file in place", verdict.Display, &token)
		}
	}
}

func classifyPermission(c *segmentCtx) {
	recursive := c.hasFlag("-R", "-r", "--recursive")
	operands := c.operands()
	if len(operands) == 0 {
		c.add(tierBounded, riskUndecidable, "permission change has no explicit target", "", nil)
		return
	}
	mode := operands[0].Text
	targets := operands[1:]
	if len(targets) == 0 {
		c.add(tierBounded, riskUndecidable, "permission change has no explicit target", mode, &operands[0])
		return
	}
	worldWritable := c.verb == "chmod" && strings.Contains(mode, "777")
	for i := range targets {
		token := targets[i]
		verdict := classifyTargetPath(token.Text)
		switch {
		case verdict.Class == pathUnresolvable:
			c.add(tierBounded, riskUndecidable, "permission target cannot be resolved", verdict.Display, &token)
		case verdict.Class == pathFilesystemRoot:
			c.add(tierCritical, riskSelfLock, "changes permissions on the filesystem root", verdict.Display, &token)
		case verdict.Class == pathSystemConfig && recursive:
			c.add(tierCritical, riskSelfLock, "recursively changes permissions on a system path", verdict.Display, &token)
		case verdict.Class == pathSystemConfig:
			c.add(tierCritical, riskSelfLock, "changes permissions on a system path", verdict.Display, &token)
		case verdict.Class == pathSSHDir, verdict.Class == pathCredentialStore:
			c.add(tierCritical, riskSelfLock, "changes permissions on credentials or SSH keys", verdict.Display, &token)
		case worldWritable:
			c.add(tierBounded, riskExposure, "makes a path world-writable", verdict.Display, &token)
		case recursive:
			c.add(tierBounded, riskDestructive, "recursively changes permissions", verdict.Display, &token)
		default:
			c.add(tierRecoverable, riskWrite, "changes permissions on one path", verdict.Display, &token)
		}
	}
}

// gitLocalSubcommands only touch the local repository.
var gitLocalSubcommands = map[string]bool{
	"clone": true, "fetch": true, "pull": true, "checkout": true, "switch": true,
	"add": true, "commit": true, "stash": true, "merge": true, "rebase": true,
	"restore": true, "status": true, "log": true, "diff": true, "show": true,
	"branch": true, "tag": true, "remote": true, "config": true, "init": true,
	"apply": true, "cherry-pick": true, "revert": true, "submodule": true, "worktree": true,
}

var gitProtectedRefs = map[string]bool{
	"main": true, "master": true, "release": true, "production": true, "prod": true, "stable": true,
}

// classifyGit separates local history rewriting from anything that changes a
// remote. A push publishes state other people can already have fetched, so it
// is scored on the external-visibility axis rather than the reversibility one.
func classifyGit(c *segmentCtx) {
	sub := gitSubcommand(c.args)
	flags := c.flagSet()
	args := c.joinedArgs()
	switch sub {
	case "status", "log", "diff", "show":
		c.add(tierObserve, riskObserve, "reads local repository state", args, nil)
	case "push":
		if flags["--delete"] || flags["-d"] {
			c.add(tierCritical, riskExternal, "deletes a branch or tag on the remote", gitPushTarget(c), nil)
			return
		}
		if flags["--force"] || flags["-f"] || flags["--force-with-lease"] || flags["--mirror"] {
			c.add(tierCritical, riskExternal, "force-pushes and can overwrite remote history", gitPushTarget(c), nil)
			return
		}
		if reason, target := dangerousGitPushRefspec(c); target != "" {
			c.add(tierCritical, riskExternal, reason, target, nil)
			return
		}
		if ref := gitProtectedRefIn(c); ref != "" {
			c.add(tierCritical, riskExternal, "pushes to a protected branch", ref, nil)
			return
		}
		c.add(tierBounded, riskExternal, "publishes commits to a remote", gitPushTarget(c), nil)
	case "reset":
		if flags["--hard"] {
			c.add(tierBounded, riskDestructive, "discards local changes", "git reset --hard", nil)
			return
		}
		c.add(tierRecoverable, riskWrite, "moves the branch pointer", "git reset", nil)
	case "clean":
		if flags["-f"] || flags["--force"] {
			c.add(tierBounded, riskDestructive, "deletes untracked files", "git clean", nil)
			return
		}
		c.add(tierObserve, riskObserve, "lists files that would be removed", "git clean", nil)
	case "branch":
		if flags["-D"] || flags["-d"] || flags["--delete"] {
			c.add(tierBounded, riskDestructive, "deletes a local branch", args, nil)
			return
		}
		c.add(tierRecoverable, riskWrite, "changes local branches", args, nil)
	case "filter-branch", "filter-repo":
		c.add(tierBounded, riskDestructive, "rewrites local history", "git "+sub, nil)
	case "":
		c.add(tierBounded, riskUndecidable, "git subcommand is missing", "", nil)
	default:
		if gitLocalSubcommands[sub] {
			c.add(tierRecoverable, riskWrite, "changes the local repository", "git "+sub, nil)
			return
		}
		c.add(tierBounded, riskUndecidable, "unrecognised git subcommand", "git "+sub, nil)
	}
}

func gitSubcommand(args []cmdToken) string {
	valueOptions := map[string]bool{
		"-C": true, "-c": true, "--git-dir": true, "--work-tree": true,
		"--namespace": true, "--super-prefix": true, "--config-env": true,
	}
	for i := 0; i < len(args); i++ {
		text := args[i].Text
		if text == "--" {
			if i+1 < len(args) {
				return strings.ToLower(args[i+1].Text)
			}
			return ""
		}
		if !strings.HasPrefix(text, "-") || text == "-" {
			return strings.ToLower(text)
		}
		name := text
		attached := false
		if equals := strings.IndexByte(name, '='); equals >= 0 {
			name = name[:equals]
			attached = true
		}
		if valueOptions[name] && !attached {
			i++
		}
	}
	return ""
}

// Git also expresses force pushes and deletes inside refspecs: `+src:dst`
// forces an update and `:dst` deletes the remote ref. Looking only for flags
// would incorrectly leave both forms at T2.
func dangerousGitPushRefspec(c *segmentCtx) (string, string) {
	operands := c.operands()
	for i, operand := range operands {
		if i == 0 || operand.Text == "push" { // subcommand, then remote name
			continue
		}
		if strings.HasPrefix(operand.Text, "+") {
			return "force-pushes and can overwrite remote history", operand.Text
		}
		if strings.HasPrefix(operand.Text, ":") && len(operand.Text) > 1 {
			return "deletes a branch or tag on the remote", operand.Text
		}
	}
	return "", ""
}

func gitPushTarget(c *segmentCtx) string {
	operands := c.operands()
	parts := make([]string, 0, 3)
	for _, operand := range operands {
		parts = append(parts, operand.Text)
	}
	return strings.Join(parts, " ")
}

func gitProtectedRefIn(c *segmentCtx) string {
	for _, operand := range c.operands() {
		text := operand.Text
		if text == "push" {
			continue
		}
		ref := text
		if idx := strings.LastIndex(ref, ":"); idx >= 0 {
			ref = ref[idx+1:]
		}
		ref = strings.TrimPrefix(ref, "refs/heads/")
		if gitProtectedRefs[strings.ToLower(ref)] {
			return text
		}
	}
	return ""
}

// criticalServicePattern matches the services whose loss costs remote access.
var criticalServiceNames = []string{"ssh", "sshd", "network", "networking", "systemd-networkd", "NetworkManager", "wg-quick", "tailscaled", "firewalld"}

func classifySystemctl(c *segmentCtx) {
	operands := c.operands()
	if len(operands) == 0 {
		c.add(tierObserve, riskObserve, "reports service state", "", nil)
		return
	}
	action := strings.ToLower(operands[0].Text)
	if c.verb == "service" && len(operands) >= 2 {
		// `service <name> <action>` has the operands the other way round.
		action = strings.ToLower(operands[len(operands)-1].Text)
	}
	unitTokens := operands[1:]
	if c.verb == "service" && len(operands) >= 1 {
		unitTokens = operands[:1]
	}
	units := make([]string, 0, len(unitTokens))
	for _, token := range unitTokens {
		units = append(units, token.Text)
	}
	unitText := strings.Join(units, " ")
	var unitToken *cmdToken
	if len(unitTokens) > 0 {
		unitToken = &unitTokens[0]
	}
	criticalUnit := ""
	for _, unit := range units {
		base := strings.ToLower(strings.TrimSuffix(unit, ".service"))
		for _, critical := range criticalServiceNames {
			if base == strings.ToLower(critical) {
				criticalUnit = unit
			}
		}
	}

	switch action {
	case "status", "list-units", "list-unit-files", "show", "cat", "is-active", "is-enabled", "get-default":
		c.add(tierObserve, riskObserve, "reports service state", unitText, unitToken)
	case "stop", "disable", "mask", "kill":
		if criticalUnit != "" {
			c.add(tierCritical, riskSelfLock, "stops a service that provides remote access", criticalUnit, unitToken)
			return
		}
		c.add(tierBounded, riskDestructive, "stops a service", unitText, unitToken)
	case "start", "restart", "reload", "try-restart", "reload-or-restart":
		if criticalUnit != "" {
			// Restarting sshd applies whatever is in the config file now, which
			// is how a bad edit becomes a lockout.
			c.add(tierCritical, riskSelfLock, "restarts the service that provides remote access", criticalUnit, unitToken)
			return
		}
		c.add(tierRecoverable, riskWrite, "starts or restarts a service", unitText, unitToken)
	case "enable":
		c.add(tierBounded, riskPersistence, "makes a service start on boot", unitText, unitToken)
	case "daemon-reload":
		c.add(tierRecoverable, riskWrite, "reloads unit definitions", "", nil)
	case "set-default", "isolate":
		c.add(tierCritical, riskSelfLock, "changes the boot target", unitText, unitToken)
	case "poweroff", "reboot", "halt":
		c.add(tierCritical, riskSelfLock, "powers the machine down or reboots it", action, unitToken)
	default:
		c.add(tierBounded, riskUndecidable, "unrecognised service action", action, unitToken)
	}
}

func classifyDocker(c *segmentCtx) {
	operands := c.operands()
	if len(operands) == 0 {
		c.add(tierObserve, riskObserve, "reports Docker state", "", nil)
		return
	}
	sub := strings.ToLower(operands[0].Text)
	rest := ""
	if len(operands) > 1 {
		rest = operands[1].Text
	}
	if sub == "compose" && len(operands) > 1 {
		sub = "compose " + strings.ToLower(operands[1].Text)
		if len(operands) > 2 {
			rest = operands[2].Text
		} else {
			rest = ""
		}
	}
	switch sub {
	case "ps", "images", "logs", "inspect", "top", "stats", "version", "info", "compose ps", "compose logs":
		c.add(tierObserve, riskObserve, "reports Docker state", rest, nil)
	case "build", "pull", "tag", "compose build", "compose pull":
		c.add(tierRecoverable, riskWrite, "builds or fetches an image", rest, nil)
	case "run", "start", "restart", "exec", "compose up", "compose restart", "create":
		// The command inside `docker exec`/`run` is not analysed here; the
		// container boundary is not a security boundary for the host when the
		// caller can mount volumes, so this stays at T2.
		if sub == "exec" || sub == "run" {
			c.add(tierBounded, riskUndecidable, "runs a command inside a container", rest, nil)
			return
		}
		c.add(tierRecoverable, riskWrite, "starts containers", rest, nil)
	case "stop", "kill", "compose stop", "compose down", "pause":
		c.add(tierBounded, riskDestructive, "stops containers", rest, nil)
	case "rm", "rmi", "compose rm":
		c.add(tierBounded, riskDestructive, "removes containers or images", rest, nil)
	case "volume", "network":
		if rest == "rm" || rest == "prune" {
			c.add(tierCritical, riskIrreversible, "removes a Docker volume or network", sub+" "+rest, nil)
			return
		}
		c.add(tierRecoverable, riskWrite, "changes Docker volumes or networks", sub+" "+rest, nil)
	case "system", "prune", "compose prune":
		c.add(tierCritical, riskIrreversible, "prunes Docker data, including volumes", sub+" "+rest, nil)
	case "push", "compose push":
		c.add(tierCritical, riskExternal, "publishes an image to a registry", rest, nil)
	case "login", "logout":
		c.add(tierRecoverable, riskWrite, "changes registry credentials", rest, nil)
	default:
		c.add(tierBounded, riskUndecidable, "unrecognised Docker subcommand", sub, nil)
	}
}

var packageInstallSubcommands = map[string]bool{
	"install": true, "add": true, "update": true, "upgrade": true, "refresh": true,
	"ci": true, "i": true, "sync": true, "reinstall": true, "download": true, "fetch": true,
}

var packageRemoveSubcommands = map[string]bool{
	"remove": true, "purge": true, "autoremove": true, "uninstall": true,
	"erase": true, "rm": true, "prune": true,
}

// classifyPackage treats installing as recoverable (a package can be removed)
// and removing as bounded destruction (a removal can break a running service).
func classifyPackage(c *segmentCtx) {
	sub := c.subcommand()
	if sub == "" {
		c.add(tierObserve, riskObserve, "reports package state", "", nil)
		return
	}
	if c.verb == "pacman" {
		flags := c.flagSet()
		switch {
		case flags["-R"], flags["-Rs"], flags["-Rns"]:
			c.add(tierBounded, riskDestructive, "removes packages", c.joinedArgs(), nil)
			return
		case flags["-S"], flags["-Sy"], flags["-Syu"], flags["-U"]:
			c.add(tierRecoverable, riskWrite, "installs packages", c.joinedArgs(), nil)
			return
		}
	}
	switch {
	case packageRemoveSubcommands[sub]:
		c.add(tierBounded, riskDestructive, "removes packages", c.joinedArgs(), nil)
	case packageInstallSubcommands[sub]:
		c.add(tierRecoverable, riskWrite, "installs or updates packages", c.joinedArgs(), nil)
	case sub == "publish":
		c.add(tierCritical, riskPublish, "publishes a package to a public registry", c.joinedArgs(), nil)
	case sub == "run", sub == "exec", sub == "dlx", sub == "create":
		// A package script is arbitrary code chosen by the project, not by the
		// command line, so it cannot be scored from here.
		c.add(tierBounded, riskUndecidable, "runs a package script", c.joinedArgs(), nil)
	case sub == "list", sub == "show", sub == "search", sub == "info", sub == "outdated", sub == "audit":
		c.add(tierObserve, riskObserve, "reports package state", c.joinedArgs(), nil)
	default:
		c.add(tierBounded, riskUndecidable, "unrecognised package subcommand", sub, nil)
	}
}

func classifyFirewall(c *segmentCtx) {
	flags := c.flagSet()
	args := c.joinedArgs()
	switch {
	case flags["-F"], flags["--flush"]:
		c.add(tierCritical, riskSelfLock, "flushes firewall rules", args, nil)
	case flags["-P"]:
		if strings.Contains(strings.ToUpper(args), "DROP") || strings.Contains(strings.ToUpper(args), "REJECT") {
			c.add(tierCritical, riskSelfLock, "sets a default-deny firewall policy", args, nil)
			return
		}
		c.add(tierBounded, riskExposure, "changes a default firewall policy", args, nil)
	case flags["-X"]:
		c.add(tierCritical, riskSelfLock, "deletes firewall chains", args, nil)
	case flags["-A"], flags["-I"], flags["-D"], flags["-R"]:
		c.add(tierBounded, riskExposure, "changes firewall rules", args, nil)
	case flags["-L"], flags["-S"], flags["--list"]:
		c.add(tierObserve, riskObserve, "lists firewall rules", args, nil)
	default:
		c.add(tierBounded, riskUndecidable, "unrecognised firewall operation", args, nil)
	}
}

func classifyNft(c *segmentCtx) {
	args := c.joinedArgs()
	lower := strings.ToLower(args)
	sub := c.subcommand()
	switch {
	case sub == "list" || sub == "monitor":
		c.add(tierObserve, riskObserve, "lists firewall rules", args, nil)
	case sub == "flush" && strings.Contains(lower, "ruleset"):
		c.add(tierCritical, riskSelfLock, "flushes the complete firewall ruleset", args, nil)
	case sub == "add", sub == "insert", sub == "replace", sub == "delete", sub == "flush":
		c.add(tierBounded, riskExposure, "changes firewall rules", args, nil)
	default:
		c.add(tierBounded, riskUndecidable, "unrecognised nft operation", args, nil)
	}
}

func findSearchRoots(args []cmdToken) []cmdToken {
	roots := make([]cmdToken, 0, 2)
	for _, token := range args {
		text := token.Text
		if text == "--" {
			continue
		}
		if strings.HasPrefix(text, "-") || text == "!" || text == "(" {
			break
		}
		roots = append(roots, token)
	}
	return roots
}

func classifyFind(c *segmentCtx) {
	args := c.joinedArgs()
	lower := strings.ToLower(args)
	switch {
	case strings.Contains(lower, "-delete"):
		roots := findSearchRoots(c.args)
		if len(roots) == 0 {
			c.add(tierBounded, riskUndecidable, "find delete has no explicit search root", args, nil)
		}
		for i := range roots {
			root := roots[i]
			verdict := classifyTargetPath(root.Text)
			switch verdict.Class {
			case pathFilesystemRoot, pathHomeRoot, pathSystemConfig, pathServicePayload:
				c.add(tierCritical, riskIrreversible, "deletes matches across a critical search root", verdict.Display, &root)
			case pathCredentialStore, pathSSHDir, pathBootPersistence:
				c.add(tierCritical, riskSelfLock, "deletes matches from credentials or access configuration", verdict.Display, &root)
			case pathUnresolvable:
				c.add(tierBounded, riskUndecidable, "find delete search root cannot be resolved", verdict.Display, &root)
			default:
				if root.Text == "." {
					c.add(tierBounded, riskUndecidable, "find delete search root depends on the remote working directory", root.Text, &root)
				}
			}
		}
		c.add(tierBounded, riskDestructive, "deletes matching files", args, nil)
	case strings.Contains(lower, "-exec"), strings.Contains(lower, "-execdir"), strings.Contains(lower, "-ok"):
		c.add(tierBounded, riskUndecidable, "runs a command per matching file", args, nil)
	default:
		c.add(tierObserve, riskObserve, "searches the filesystem", args, nil)
	}
}

func classifyTar(c *segmentCtx) {
	flags := c.flagSet()
	args := c.joinedArgs()
	switch {
	case flags["-x"], flags["--extract"]:
		// Extraction writes paths chosen by the archive, not by the command
		// line, so the destination cannot be bounded statically.
		c.add(tierBounded, riskUndecidable, "extracts archive-chosen paths", args, nil)
	case flags["-c"], flags["--create"]:
		c.add(tierRecoverable, riskWrite, "creates an archive", args, nil)
	case flags["-t"], flags["--list"]:
		c.add(tierObserve, riskObserve, "lists archive contents", args, nil)
	default:
		c.add(tierBounded, riskUndecidable, "unrecognised tar operation", args, nil)
	}
}

var destructiveSQLPatterns = []struct {
	needle string
	reason string
}{
	{"drop database", "drops a database"},
	{"drop schema", "drops a schema"},
	{"drop table", "drops a table"},
	{"truncate", "truncates a table"},
	{"flushall", "erases the entire keyspace"},
	{"flushdb", "erases a keyspace"},
	{"delete from", "deletes rows"},
	{"drop user", "drops a database user"},
	{"drop index", "drops an index"},
}

func classifyDatabase(c *segmentCtx) {
	args := c.joinedArgs()
	lower := strings.ToLower(args)
	for _, pattern := range destructiveSQLPatterns {
		if strings.Contains(lower, pattern.needle) {
			c.add(tierCritical, riskIrreversible, "database statement "+pattern.reason, pattern.needle, nil)
			return
		}
	}
	if strings.Contains(args, "<") {
		c.add(tierBounded, riskUndecidable, "runs SQL from a file", args, nil)
		return
	}
	if c.hasFlag("-e", "--execute", "-c", "--command", "--eval") {
		c.add(tierBounded, riskUndecidable, "runs an inline database statement", args, nil)
		return
	}
	c.add(tierBounded, riskUndecidable, "opens a database session", args, nil)
}

func classifyKubectl(c *segmentCtx) {
	sub := c.subcommand()
	args := c.joinedArgs()
	lower := strings.ToLower(args)
	switch sub {
	case "get", "describe", "logs", "explain", "top", "version", "config", "api-resources":
		c.add(tierObserve, riskObserve, "reads cluster state", args, nil)
	case "delete":
		if c.hasFlag("--all", "--all-namespaces", "-A") {
			c.add(tierCritical, riskExternal, "deletes cluster resources across a broad scope", args, nil)
			return
		}
		if strings.Contains(lower, "namespace") || strings.Contains(lower, " ns ") || strings.Contains(lower, "pvc") || strings.Contains(lower, "persistentvolume") {
			c.add(tierCritical, riskIrreversible, "deletes a namespace or persistent volume", args, nil)
			return
		}
		c.add(tierBounded, riskDestructive, "deletes cluster resources", args, nil)
	case "apply", "create", "patch", "set", "scale", "rollout", "annotate", "label":
		c.add(tierBounded, riskExternal, "changes cluster state", args, nil)
	case "exec", "run", "port-forward", "proxy", "cp":
		c.add(tierBounded, riskUndecidable, "runs a command or opens a channel in the cluster", args, nil)
	case "drain", "cordon", "taint":
		c.add(tierBounded, riskDestructive, "evicts workloads from a node", args, nil)
	default:
		c.add(tierBounded, riskUndecidable, "unrecognised kubectl subcommand", sub, nil)
	}
}

func classifyTerraform(c *segmentCtx) {
	sub := c.subcommand()
	args := c.joinedArgs()
	switch sub {
	case "destroy":
		c.add(tierCritical, riskIrreversible, "destroys managed infrastructure", args, nil)
	case "apply":
		if c.hasFlag("--auto-approve", "-auto-approve") {
			c.add(tierCritical, riskExternal, "applies infrastructure changes without its own approval", args, nil)
			return
		}
		c.add(tierCritical, riskExternal, "applies infrastructure changes", args, nil)
	case "plan", "show", "output", "validate", "fmt", "version", "providers":
		c.add(tierObserve, riskObserve, "reads infrastructure state", args, nil)
	case "import", "state", "taint", "untaint":
		c.add(tierBounded, riskExternal, "changes infrastructure state tracking", args, nil)
	case "init", "get":
		c.add(tierRecoverable, riskWrite, "initialises a working directory", args, nil)
	default:
		c.add(tierBounded, riskUndecidable, "unrecognised terraform subcommand", sub, nil)
	}
}

var awsDestructiveOperations = []struct {
	needle string
	reason string
}{
	{"rb", "removes a bucket"},
	{"delete-bucket", "removes a bucket"},
	{"terminate-instances", "terminates instances"},
	{"delete-db-instance", "deletes a database instance"},
	{"delete-cluster", "deletes a cluster"},
	{"delete-stack", "deletes a stack"},
	{"delete-table", "deletes a table"},
	{"delete-key-pair", "deletes a key pair"},
	{"delete-volume", "deletes a volume"},
}

func classifyAWS(c *segmentCtx) {
	args := c.joinedArgs()
	lower := strings.ToLower(args)
	for _, operation := range awsDestructiveOperations {
		if strings.Contains(lower, operation.needle) {
			c.add(tierCritical, riskIrreversible, "cloud operation "+operation.reason, operation.needle, nil)
			return
		}
	}
	switch {
	case strings.Contains(lower, "change-resource-record-sets"), strings.Contains(lower, "route53"):
		c.add(tierCritical, riskExternal, "changes public DNS records", args, nil)
	case strings.Contains(lower, " rm "), strings.Contains(lower, "delete"), strings.Contains(lower, "remove"):
		c.add(tierBounded, riskExternal, "deletes cloud resources", args, nil)
	case strings.Contains(lower, " ls "), strings.Contains(lower, "describe"), strings.Contains(lower, "list"), strings.Contains(lower, "get"):
		c.add(tierObserve, riskObserve, "reads cloud state", args, nil)
	default:
		c.add(tierBounded, riskUndecidable, "changes cloud resources", args, nil)
	}
}

// classifyIP scores network reconfiguration, which is the classic way to lose a
// remote session.
func classifyIP(c *segmentCtx) {
	args := strings.ToLower(c.joinedArgs())
	switch {
	case strings.Contains(args, "link set") && strings.Contains(args, "down"):
		c.add(tierCritical, riskSelfLock, "takes a network interface down", c.joinedArgs(), nil)
	case strings.Contains(args, "route del"), strings.Contains(args, "route delete"), strings.Contains(args, "route replace"), strings.Contains(args, "route change"):
		c.add(tierCritical, riskSelfLock, "changes routing, which can cut the session", c.joinedArgs(), nil)
	case strings.Contains(args, "addr del"), strings.Contains(args, "addr flush"):
		c.add(tierCritical, riskSelfLock, "removes an interface address", c.joinedArgs(), nil)
	case strings.Contains(args, "addr"), strings.Contains(args, "link"), strings.Contains(args, "route"):
		if strings.Contains(args, "show") || strings.Contains(args, "list") || args == "" {
			c.add(tierObserve, riskObserve, "reads network configuration", c.joinedArgs(), nil)
			return
		}
		c.add(tierBounded, riskExposure, "changes network configuration", c.joinedArgs(), nil)
	case args == "", strings.Contains(args, "show"), strings.Contains(args, "list"):
		c.add(tierObserve, riskObserve, "reads network configuration", c.joinedArgs(), nil)
	default:
		c.add(tierBounded, riskUndecidable, "unrecognised network operation", c.joinedArgs(), nil)
	}
}

func classifyInit(c *segmentCtx) {
	args := c.joinedArgs()
	for _, operand := range c.operands() {
		if operand.Text == "0" || operand.Text == "6" {
			c.add(tierCritical, riskSelfLock, "switches to a halt or reboot runlevel", args, nil)
			return
		}
	}
	c.add(tierBounded, riskUndecidable, "changes the init runlevel", args, nil)
}

// tierAuditFields renders an assessment for the structured log.
func tierAuditFields(assessment riskAssessment) map[string]any {
	categories := make([]string, 0, len(assessment.Findings))
	seen := map[riskCategory]bool{}
	for _, finding := range assessment.Findings {
		if seen[finding.Category] {
			continue
		}
		seen[finding.Category] = true
		categories = append(categories, string(finding.Category))
	}
	fields := map[string]any{
		"tier":           assessment.Tier.String(),
		"tierLabel":      assessment.Tier.Label(),
		"riskCategories": strings.Join(categories, ","),
	}
	if finding, ok := assessment.topFinding(); ok {
		fields["riskReason"] = finding.Reason
		if finding.Target != "" {
			fields["riskTarget"] = finding.Target
		}
	}
	return fields
}

// describeTier is a compact one-line summary used in dialog text.
func describeTier(assessment riskAssessment) string {
	finding, ok := assessment.topFinding()
	if !ok {
		return assessment.Tier.String()
	}
	if finding.Target == "" {
		return fmt.Sprintf("%s (%s): %s", assessment.Tier, assessment.Tier.Label(), finding.Reason)
	}
	return fmt.Sprintf("%s (%s): %s — %s", assessment.Tier, assessment.Tier.Label(), finding.Reason, finding.Target)
}
