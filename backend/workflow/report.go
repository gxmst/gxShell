package workflow

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode"

	"gxShell/backend/i18n"
)

type ReportCheck struct {
	Check       string   `json:"check"`
	Status      string   `json:"status"`
	Reading     string   `json:"reading"`
	EvidenceIDs []string `json:"evidenceIds"`
	Observed    string   `json:"observed,omitempty"`
}

type Finding struct {
	Severity       string   `json:"severity"`
	Title          string   `json:"title"`
	Detail         string   `json:"detail"`
	Impact         string   `json:"impact"`
	Recommendation string   `json:"recommendation"`
	EvidenceIDs    []string `json:"evidenceIds"`
}

type Uncertainty struct {
	ID          string   `json:"id,omitempty"`
	Title       string   `json:"title"`
	Detail      string   `json:"detail"`
	EvidenceIDs []string `json:"evidenceIds"`
}

type ReportDocument struct {
	Version  int           `json:"version"`
	Verdict  string        `json:"verdict"`
	Summary  string        `json:"summary"`
	Checks   []ReportCheck `json:"checks"`
	Findings []Finding     `json:"findings"`
	Unknowns []Uncertainty `json:"unknowns"`
	Analysis *AiAnalysis   `json:"analysis,omitempty"`
}

type AiInsight struct {
	Title       string   `json:"title"`
	Opinion     string   `json:"opinion"`
	Confidence  string   `json:"confidence"`
	EvidenceIDs []string `json:"evidenceIds"`
	NextCheck   string   `json:"nextCheck"`
}
type AiAnalysis struct {
	Assessment string      `json:"assessment"`
	Insights   []AiInsight `json:"insights"`
	NextSteps  []string    `json:"nextSteps"`
	Caveats    string      `json:"caveats"`
}

func NormalizeLanguage(language string) string {
	if strings.EqualFold(strings.TrimSpace(language), "Chinese") || i18n.Chinese(language) {
		return "zh-CN"
	}
	return "en"
}

func tr(language, zh, en string) string { return i18n.Text(NormalizeLanguage(language), zh, en) }

func CheckLabel(language, check string) string {
	labels := map[string][2]string{
		"system": {"系统信息", "System"}, "load": {"系统负载", "Load"}, "disk": {"磁盘空间", "Disk"},
		"memory": {"内存使用", "Memory"}, "services": {"服务状态", "Services"}, "ports": {"监听端口", "Listening ports"},
		"containers": {"容器状态", "Containers"}, "service": {"服务补查", "Service details"},
		"connectivity": {"本机端口连通性", "Local TCP connectivity"},
		"inodes":       {"inode 使用率", "Inode usage"}, "disk_usage": {"目录占用", "Directory usage"}, "journal": {"系统日志占用", "System journal usage"}, "container_storage": {"容器存储占用", "Container storage"},
	}
	if label, ok := labels[check]; ok {
		return tr(language, label[0], label[1])
	}
	return check
}

func StatusLabel(language, status string) string {
	labels := map[string][2]string{
		"normal": {"正常", "Normal"}, "warning": {"需关注", "Warning"}, "critical": {"异常", "Critical"},
		"unknown": {"未确认", "Unconfirmed"}, "attention": {"发现需关注项", "Needs attention"},
		"collected": {"已采集", "Collected"}, "unavailable": {"无法获取", "Unavailable"},
	}
	if label, ok := labels[status]; ok {
		return tr(language, label[0], label[1])
	}
	return status
}

func LocalizeError(language, message string) string {
	if NormalizeLanguage(language) != "zh-CN" {
		return message
	}
	replacements := []string{
		"remote exit code ", "远程退出码 ", "context deadline exceeded", "任务已超时",
		"context canceled", "任务已停止", "permission denied", "权限不足",
		"model stream did not finish", "模型响应未完整结束", "model returned an empty report", "模型返回了空报告",
		"model exceeded the inspection query budget", "模型超出了补查次数限制",
		"Inspection stopped unexpectedly; collected evidence was preserved.", "巡检意外中断，已保留采集证据。",
		"Application stopped before the task finished. Start a new inspection to collect current evidence.", "上次任务未完成便退出了程序，已保留证据。请重新巡检以获取最新信息。",
	}
	return strings.NewReplacer(replacements...).Replace(message)
}

func baselineReading(run Run, e Evidence) string {
	if e.Status != "collected" {
		return tr(run.Language, "无法完成检查", "Check unavailable") + ": " + LocalizeError(run.Language, e.Error)
	}
	if e.Truncated {
		return tr(run.Language, "输出已截断，结果未确认", "Output truncated; result unconfirmed")
	}
	if noFailedUnits(e) {
		return tr(run.Language, "未报告失败的 systemd 服务单元", "No failed systemd units were reported")
	}
	return tr(run.Language, "已取得输出，尚未形成健康结论", "Output collected; health has not been assessed")
}

// noFailedUnits reads the systemd services check: the explicit
// GXSHELL_FAILED_UNITS=0 line, or (older history) a bare marker with no units.
func noFailedUnits(e Evidence) bool {
	if e.Query.Check != "services" || !strings.Contains(e.Output, "GXSHELL_SERVICE_MANAGER=systemd") {
		return false
	}
	rest := strings.TrimSpace(strings.ReplaceAll(e.Output, "GXSHELL_SERVICE_MANAGER=systemd", ""))
	if count, found := strings.CutPrefix(rest, "GXSHELL_FAILED_UNITS="); found {
		return strings.TrimSpace(count) == "0"
	}
	return rest == ""
}

func fallbackDocument(run Run) *ReportDocument {
	doc := &ReportDocument{Version: 1, Verdict: "unknown", Summary: tr(run.Language, "巡检证据已保留，尚未形成完整诊断结论。", "Evidence was preserved; a complete diagnosis is not available."), Checks: []ReportCheck{}, Findings: []Finding{}, Unknowns: []Uncertainty{}}
	for _, check := range RunChecks(run) {
		item := ReportCheck{Check: check, Status: "unknown", Reading: tr(run.Language, "尚未检查", "Not checked"), EvidenceIDs: []string{}}
		for _, e := range currentEvidence(run) {
			if e.Query.Check == check {
				if observed := observedValues(e, run.Language); observed != "" {
					item.Observed = observed
				}
				item.Reading = baselineReading(run, e)
				item.EvidenceIDs = append(item.EvidenceIDs, e.ID)
			}
		}
		if item.Reading == tr(run.Language, "未报告失败的 systemd 服务单元", "No failed systemd units were reported") {
			item.Status = "normal"
		}
		for _, e := range currentEvidence(run) {
			if e.Query.Check == check {
				if status, reading := measuredConclusion(run, e); status != "" {
					item.Status, item.Reading = status, reading
					doc.Verdict = "attention"
					doc.Findings = append(doc.Findings, Finding{Severity: status, Title: CheckLabel(run.Language, check), Detail: reading, Impact: tr(run.Language, "具体影响需结合业务核实。", "Verify the impact against the workload."), Recommendation: tr(run.Language, "先核实原因，再审核具体处理计划。", "Verify the cause before reviewing a concrete action plan."), EvidenceIDs: []string{e.ID}})
				}
			}
		}
		doc.Checks = append(doc.Checks, item)
		if item.Status == "unknown" {
			doc.Unknowns = append(doc.Unknowns, Uncertainty{Title: CheckLabel(run.Language, check), Detail: item.Reading, EvidenceIDs: item.EvidenceIDs})
		}
	}
	ensureUnknownIDs(doc)
	return doc
}

func hasHan(text string) bool {
	for _, r := range text {
		if unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}

// decodeReport is the strict form used by model evaluation and tests: any
// item the model got wrong is an error.
func decodeReport(text string, run Run) (*ReportDocument, error) {
	doc, issues, err := normalizeReport(text, run)
	if err != nil {
		return nil, err
	}
	if len(issues) > 0 {
		return nil, fmt.Errorf("%s", strings.Join(issues, "; "))
	}
	return doc, nil
}

// extractReportJSON tolerates a Markdown fence or prose around the object.
func extractReportJSON(text string) string {
	text = strings.TrimSpace(text)
	if strings.HasPrefix(text, "```") {
		if first := strings.IndexByte(text, '\n'); first >= 0 {
			text = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(text[first+1:]), "```"))
		}
	}
	start, end := strings.IndexByte(text, '{'), strings.LastIndexByte(text, '}')
	if start > 0 && end > start {
		text = text[start : end+1]
	}
	return text
}

// normalizeReport fails only when the answer is unreadable. A wrong item is
// dropped or replaced with its evidence-derived fallback and reported as an
// issue, so one bad citation no longer discards the whole report.
// Unknown/missing/truncated evidence can never be promoted to a healthy check.
func normalizeReport(text string, run Run) (*ReportDocument, []string, error) {
	var doc ReportDocument
	if err := json.Unmarshal([]byte(extractReportJSON(text)), &doc); err != nil {
		return nil, nil, fmt.Errorf("invalid report JSON: %v", err)
	}
	if strings.TrimSpace(doc.Summary) == "" && len(doc.Checks) == 0 && doc.Analysis == nil {
		return nil, nil, fmt.Errorf("report JSON has no summary, checks or analysis")
	}
	issues := []string{}
	zh := NormalizeLanguage(run.Language) == "zh-CN"
	wrongLanguage := func(field, value string) {
		if zh && strings.TrimSpace(value) != "" && !hasHan(value) {
			issues = append(issues, field+" must use Simplified Chinese")
		}
	}
	fallback := fallbackDocument(run)
	if doc.Version != 1 && doc.Version != 2 {
		issues = append(issues, "version must be 1 or 2")
		doc.Version = 1
	}
	if run.ReportSchemaVersion >= 2 {
		doc.Version = 2
	}
	doc.Summary = strings.TrimSpace(doc.Summary)
	if doc.Summary == "" || len(doc.Summary) > 2000 {
		issues = append(issues, "summary is missing or longer than 2000 bytes")
		doc.Summary = fallback.Summary
	} else {
		wrongLanguage("summary", doc.Summary)
	}
	if doc.Findings == nil || doc.Unknowns == nil {
		issues = append(issues, "findings and unknowns must be arrays")
	}
	refs := map[string]Evidence{}
	for _, e := range run.Evidence {
		refs[e.ID] = e
	}
	validRefs := func(ids []string) bool {
		if len(ids) == 0 || len(ids) > len(refs) {
			return false
		}
		seen := map[string]bool{}
		for _, id := range ids {
			if seen[id] {
				return false
			}
			seen[id] = true
			if _, ok := refs[id]; !ok {
				return false
			}
		}
		return true
	}
	if doc.Analysis != nil {
		a := doc.Analysis
		if len(a.Caveats) > 1500 {
			issues = append(issues, "analysis.caveats is longer than 1500 bytes")
			a.Caveats = ""
		}
		wrongLanguage("analysis.caveats", a.Caveats)
		insights := []AiInsight{}
		for i, insight := range a.Insights {
			field := fmt.Sprintf("analysis.insights[%d]", i)
			if len(insights) == 4 || insight.Title == "" || len(insight.Title) > 200 || insight.Opinion == "" || len(insight.Opinion) > 2000 || insight.NextCheck == "" || len(insight.NextCheck) > 800 ||
				!containsCheck([]string{"supported", "hypothesis", "uncertain"}, insight.Confidence) || !validRefs(insight.EvidenceIDs) {
				issues = append(issues, field+" was dropped: it needs title, opinion, nextCheck, a valid confidence and existing evidence IDs (at most 4 insights)")
				continue
			}
			for _, id := range insight.EvidenceIDs {
				if insight.Confidence == "supported" && (refs[id].Status != "collected" || refs[id].Truncated) {
					issues = append(issues, field+" cites unavailable or truncated evidence and cannot be supported")
					insight.Confidence = "uncertain"
					break
				}
			}
			for _, p := range []string{insight.Title, insight.Opinion, insight.NextCheck} {
				wrongLanguage(field, p)
			}
			insights = append(insights, insight)
		}
		steps := []string{}
		for i, step := range a.NextSteps {
			if strings.TrimSpace(step) == "" || len(step) > 800 || len(steps) == 4 {
				issues = append(issues, fmt.Sprintf("analysis.nextSteps[%d] was dropped: empty, longer than 800 bytes, or beyond 4 steps", i))
				continue
			}
			wrongLanguage(fmt.Sprintf("analysis.nextSteps[%d]", i), step)
			steps = append(steps, step)
		}
		a.Insights, a.NextSteps = insights, steps
		if strings.TrimSpace(a.Assessment) == "" || len(a.Assessment) > 2000 || len(insights) == 0 || len(steps) == 0 {
			issues = append(issues, "analysis needs an assessment of at most 2000 bytes, 1-4 insights and 1-4 next steps")
		}
		wrongLanguage("analysis.assessment", a.Assessment)
		if len(a.Assessment) > 2000 {
			a.Assessment = strings.ToValidUTF8(a.Assessment[:2000], "")
		}
		if strings.TrimSpace(a.Assessment) == "" {
			doc.Analysis = nil
		}
	}
	if run.ReportSchemaVersion >= 2 && doc.Analysis == nil {
		issues = append(issues, "analysis is required")
	}
	latest := map[Query]string{}
	for _, e := range run.Evidence {
		latest[e.Query] = e.ID
	}
	fallbackChecks := map[string]ReportCheck{}
	for _, c := range fallback.Checks {
		fallbackChecks[c.Check] = c
	}
	seen := map[string]bool{}
	measured := []Finding{}
	checks := []ReportCheck{}
	for i, item := range doc.Checks {
		field := fmt.Sprintf("checks[%d] (%s)", i, item.Check)
		base, known := fallbackChecks[item.Check]
		if !known || seen[item.Check] {
			issues = append(issues, field+" is not a check of this workflow or is repeated")
			continue
		}
		seen[item.Check] = true
		if !containsCheck([]string{"normal", "warning", "critical", "unknown"}, item.Status) {
			issues = append(issues, field+" status must be normal, warning, critical or unknown")
			item.Status = "unknown"
		}
		if strings.TrimSpace(item.Reading) == "" || len(item.Reading) > 2000 {
			issues = append(issues, field+" reading is empty or longer than 2000 bytes")
			item.Reading = base.Reading
		} else {
			wrongLanguage(field+" reading", item.Reading)
		}
		cited := validRefs(item.EvidenceIDs)
		for _, id := range item.EvidenceIDs {
			if e := refs[id]; cited && (latest[e.Query] != id || e.Query.Check != item.Check) {
				cited = false
			}
		}
		if !cited {
			issues = append(issues, fmt.Sprintf("%s must cite the latest evidence of this check: %v", field, base.EvidenceIDs))
			item.EvidenceIDs = base.EvidenceIDs
		}
		measured = append(measured, reconcileCheck(run, &item, refs)...)
		checks = append(checks, item)
	}
	// Without a single recognizable check the answer used some other schema;
	// filling every check from fallbacks would pass off an empty report as a
	// corrected one.
	if len(checks) == 0 {
		names, _ := json.Marshal(RunChecks(run))
		return nil, nil, fmt.Errorf("report does not use the required schema: checks must contain one item per check identifier %s", names)
	}
	for _, check := range RunChecks(run) {
		if !seen[check] {
			issues = append(issues, "checks is missing "+check)
			item := fallbackChecks[check]
			measured = append(measured, reconcileCheck(run, &item, refs)...)
			checks = append(checks, item)
		}
	}
	doc.Checks = checks
	findings := []Finding{}
	for i, item := range doc.Findings {
		field := fmt.Sprintf("findings[%d]", i)
		available := false
		for _, id := range item.EvidenceIDs {
			if refs[id].Status == "collected" {
				available = true
			}
		}
		if len(findings) == 12 || !containsCheck([]string{"warning", "critical"}, item.Severity) || !validRefs(item.EvidenceIDs) || item.Title == "" || item.Detail == "" || item.Recommendation == "" ||
			len(item.Title) > 200 || len(item.Detail)+len(item.Impact)+len(item.Recommendation) > 6000 || !available {
			issues = append(issues, field+" was dropped: it needs warning/critical severity, title, detail, recommendation and collected evidence IDs (at most 12)")
			continue
		}
		for _, p := range []string{item.Title, item.Detail, item.Impact, item.Recommendation} {
			wrongLanguage(field, p)
		}
		findings = append(findings, item)
	}
	doc.Findings = findings
	unknowns := []Uncertainty{}
	for i, item := range doc.Unknowns {
		if len(unknowns) == 16 || item.Title == "" || item.Detail == "" || len(item.Title)+len(item.Detail) > 3000 || !validRefs(item.EvidenceIDs) {
			issues = append(issues, fmt.Sprintf("unknowns[%d] was dropped: it needs title, detail and existing evidence IDs (at most 16)", i))
			continue
		}
		wrongLanguage(fmt.Sprintf("unknowns[%d]", i), item.Title+item.Detail)
		unknowns = append(unknowns, item)
	}
	doc.Unknowns = unknowns
	for _, finding := range measured {
		found := false
		for _, old := range doc.Findings {
			for _, id := range old.EvidenceIDs {
				if containsCheck(finding.EvidenceIDs, id) {
					found = true
				}
			}
		}
		if !found {
			doc.Findings = append(doc.Findings, finding)
		}
	}
	if run.Workflow == "service_diagnosis" {
		e := evidenceFor(run, "connectivity")
		covered := false
		for _, u := range doc.Unknowns {
			if containsCheck(u.EvidenceIDs, e.ID) {
				covered = true
			}
		}
		if e.ID != "" && !covered {
			doc.Unknowns = append(doc.Unknowns, Uncertainty{Title: tr(run.Language, "外网访问路径", "External access path"), Detail: tr(run.Language, "本次仅测试服务器本机回环地址，外网访问、DNS 和防火墙仍需独立核实。", "This task tests server loopback only. Public access, DNS and firewall state need independent verification."), EvidenceIDs: []string{e.ID}})
		}
	}
	for _, e := range currentEvidence(run) {
		if e.Status == "collected" && !e.Truncated {
			continue
		}
		found := false
		for _, u := range doc.Unknowns {
			if containsCheck(u.EvidenceIDs, e.ID) {
				found = true
			}
		}
		if !found {
			doc.Unknowns = append(doc.Unknowns, Uncertainty{Title: CheckLabel(run.Language, e.Query.Check) + " " + e.Query.Service, Detail: baselineReading(run, e), EvidenceIDs: []string{e.ID}})
		}
	}
	// Reconcile status and missing coverage rather than trusting the model's overall verdict.
	doc.Verdict = "normal"
	for _, item := range doc.Checks {
		if item.Status == "unknown" {
			if doc.Verdict == "normal" {
				doc.Verdict = "unknown"
			}
			found := false
			for _, u := range doc.Unknowns {
				for _, id := range u.EvidenceIDs {
					if containsCheck(item.EvidenceIDs, id) {
						found = true
					}
				}
			}
			if !found {
				doc.Unknowns = append(doc.Unknowns, Uncertainty{Title: CheckLabel(run.Language, item.Check), Detail: item.Reading, EvidenceIDs: item.EvidenceIDs})
			}
		} else if item.Status != "normal" {
			doc.Verdict = "attention"
		}
	}
	if len(doc.Findings) > 0 {
		doc.Verdict = "attention"
	} else if len(doc.Unknowns) > 0 && doc.Verdict == "normal" {
		doc.Verdict = "unknown"
	}
	order := map[string]int{}
	for i, check := range RunChecks(run) {
		order[check] = i
	}
	sort.Slice(doc.Checks, func(i, j int) bool { return order[doc.Checks[i].Check] < order[doc.Checks[j].Check] })
	ensureUnknownIDs(&doc)
	unique := []string{}
	for _, issue := range issues {
		if !containsCheck(unique, issue) {
			unique = append(unique, issue)
		}
	}
	return &doc, unique, nil
}

// reconcileCheck applies the evidence-derived rules that override any model
// status, and returns findings for measured thresholds.
func reconcileCheck(run Run, item *ReportCheck, refs map[string]Evidence) []Finding {
	measured := []Finding{}
	// Values displayed as measurements always come from collected output.
	item.Observed = ""
	for _, id := range item.EvidenceIDs {
		e := refs[id]
		if observed := observedValues(e, run.Language); observed != "" {
			item.Observed = observed
		}
		if e.Status != "collected" || e.Truncated {
			item.Status = "unknown"
			item.Reading = baselineReading(run, e)
		}
		if item.Check == "services" && baselineReading(run, e) == tr(run.Language, "未报告失败的 systemd 服务单元", "No failed systemd units were reported") {
			item.Status = "normal"
			item.Reading = baselineReading(run, e)
		}
		if item.Check == "connectivity" && e.Status == "collected" && !e.Truncated && strings.Contains(e.Output, "GXSHELL_TCP=unreachable") {
			item.Status = "critical"
			item.Reading = tr(run.Language, "服务器本机 TCP 连接未成功，外网连通性仍未确认。", "The local TCP connection did not succeed; public reachability remains unconfirmed.")
		}
		if item.Check == "service" && e.Status == "collected" && !e.Truncated && e.Query.View == "status" && (strings.Contains(e.Output, "LoadState=not-found") || strings.Contains(e.Output, "ActiveState=failed")) {
			item.Status = "critical"
			item.Reading = tr(run.Language, "所选服务不存在或处于失败状态，请核对服务名及运行状态。", "The selected service is missing or failed; verify its name and state.")
		}
		if status, reading := measuredConclusion(run, e); status != "" {
			item.Status = status
			item.Reading = reading
			measured = append(measured, Finding{Severity: status, Title: CheckLabel(run.Language, item.Check), Detail: reading, Impact: tr(run.Language, "具体影响需结合业务和采集证据核实。", "Verify the impact against the workload and evidence."), Recommendation: tr(run.Language, "先核实原因，再审核具体处理计划。", "Verify the cause before reviewing a concrete action plan."), EvidenceIDs: []string{id}})
		}
	}
	return measured
}
func containsCheck(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}

func reportContract(run Run) string {
	checks, _ := json.Marshal(RunChecks(run))
	return "Return ONLY one JSON object, never Markdown prose. Schema: " +
		`{"version":2,"verdict":"normal|attention|unknown","summary":"one sentence","checks":[{"check":"check identifier","status":"normal|warning|critical|unknown","reading":"measured values and interpretation","evidenceIds":["E1"]}],"findings":[{"severity":"warning|critical","title":"issue","detail":"observation","impact":"impact or uncertainty","recommendation":"read-only verification or recommendation","evidenceIds":["E1"]}],"unknowns":[{"title":"uncertain area","detail":"reason and next verification","evidenceIds":["E1"]}],"analysis":{"assessment":"Your operational assessment or direct answer to the follow-up question","insights":[{"title":"point","opinion":"Evidence-based interpretation or explicitly tentative cause; explain significance rather than repeat raw values","confidence":"supported|hypothesis|uncertain","evidenceIds":["E1"],"nextCheck":"Next read-only verification"}],"nextSteps":["Prioritized actionable next step"],"caveats":"Limits of this assessment"}}. ` +
		"Include exactly one checks item for each of " + string(checks) + ". Empty findings/unknowns must be []. Every conclusion must cite existing relevant evidence IDs. Missing tools, permission failures and truncated output are UNKNOWN, not faults. " +
		"Analysis is REQUIRED even on healthy hosts: provide 1-4 useful insights and 1-4 prioritized next steps. Do not fabricate a fault or root cause. Supported means complete evidence supports this interpretation, hypothesis means a possible explanation requiring checks, uncertain means evidence is incomplete. Prefer the latest evidence for a repeated query. " +
		tr(run.Language, "所有面向用户的文字（summary、reading、title、detail、impact、recommendation）必须使用简体中文。仅命令、服务名、数值和证据 ID 保持原文。不要输出英文段落。", "All user-facing prose must be in English. Keep commands, service names and evidence IDs unchanged.")
}

func currentEvidence(run Run) []Evidence {
	latest := map[Query]int{}
	for i, e := range run.Evidence {
		latest[e.Query] = i
	}
	result := []Evidence{}
	for i, e := range run.Evidence {
		if latest[e.Query] == i {
			result = append(result, e)
		}
	}
	return result
}

func markdownText(value string) string {
	return strings.NewReplacer("\\", "\\\\", "|", "\\|", "*", "\\*", "_", "\\_", "[", "\\[", "]", "\\]", "<", "&lt;", ">", "&gt;", "#", "\\#", "`", "\\`", "\r", "", "\n", " ").Replace(value)
}

func ReportMarkdown(run Run) string {
	doc := run.Document
	if doc == nil {
		return run.Report
	}
	l := run.Language
	var out strings.Builder
	title := tr(l, "主机巡检报告", "Host inspection report")
	if run.Workflow == "service_diagnosis" {
		title = tr(l, "服务连通性诊断报告", "Service connectivity diagnosis")
	}
	if run.Workflow == "disk_diagnosis" {
		title = tr(l, "磁盘空间诊断报告", "Disk space diagnosis")
	}
	fmt.Fprintf(&out, "# %s\n\n", title)
	fmt.Fprintf(&out, "| %s | %s |\n| --- | --- |\n", tr(l, "报告信息", "Report details"), tr(l, "内容", "Value"))
	fields := [][2]string{{tr(l, "主机", "Host"), run.Target}, {tr(l, "报告编号", "Report ID"), run.ID}, {tr(l, "巡检时间", "Started"), run.CreatedAt.Local().Format("2006-01-02 15:04:05")}, {tr(l, "总体结论", "Verdict"), StatusLabel(l, doc.Verdict)}}
	if len(doc.Unknowns) > 0 {
		confirmed, pending, issue := ReviewStatus(run)
		status := tr(l, "待人工核实", "Pending human review")
		if pending == 0 {
			status = tr(l, "已人工核实", "Manually reviewed")
		}
		if issue {
			status += tr(l, " · 人工确认存在问题", " · Manually confirmed issue")
		}
		fields[3][0] = tr(l, "AI 原结论", "Original AI conclusion")
		fields = append(fields, [2]string{tr(l, "人工核实状态", "Human review status"), fmt.Sprintf("%s · %d/%d", status, confirmed, confirmed+pending)})
	}
	if !run.FinishedAt.IsZero() {
		fields = append(fields, [2]string{tr(l, "耗时", "Duration"), fmt.Sprintf("%.0fs", run.FinishedAt.Sub(run.CreatedAt).Seconds())})
	}
	if run.Service != "" {
		fields = append(fields, [2]string{tr(l, "服务", "Service"), run.Service})
	}
	if run.Port > 0 {
		fields = append(fields, [2]string{tr(l, "端口", "Port"), fmt.Sprint(run.Port)})
	}
	for _, field := range fields {
		fmt.Fprintf(&out, "| %s | %s |\n", field[0], markdownText(field[1]))
	}
	summaryTitle := tr(l, "总体结论", "Summary")
	if len(run.Reviews) > 0 {
		summaryTitle = tr(l, "AI 原始摘要", "Original AI summary")
	}
	fmt.Fprintf(&out, "\n## %s\n\n%s\n\n", summaryTitle, markdownText(doc.Summary))
	if confirmed, pending, _ := ReviewStatus(run); confirmed > 0 && pending == 0 {
		normal, issues, notApplicable := 0, 0, 0
		latest := LatestReviews(run)
		for _, unknown := range doc.Unknowns {
			switch latest[unknown.ID].Outcome {
			case "normal":
				normal++
			case "issue":
				issues++
			case "not_applicable":
				notApplicable++
			}
		}
		fmt.Fprintf(&out, "## %s\n\n", tr(l, "人工核实结论", "Human review conclusion"))
		fmt.Fprintf(&out, tr(l, "人工核实已完成：%d 项正常，%d 项确认存在问题，%d 项不适用。\n\n", "Human review complete: %d normal, %d confirmed issues, %d not applicable.\n\n"), normal, issues, notApplicable)
	}
	writeAnalysisMarkdown(&out, run)
	if run.UnverifiedAnswer != "" {
		fence := strings.Repeat("`", 3)
		fmt.Fprintf(&out, "## %s\n\n> %s\n\n%stext\n%s\n%s\n\n", tr(l, "AI 原文（未通过格式校验）", "AI answer (failed format validation)"),
			tr(l, "模型没有按要求的格式返回，以下是它的原文，结论没有经过程序核对。", "The model ignored the required format. Its text is shown as-is; nothing in it was checked by the program."),
			fence, strings.ReplaceAll(run.UnverifiedAnswer, fence, "'''"), fence)
	}
	fmt.Fprintf(&out, "## %s\n\n", tr(l, "检查总览", "Check overview"))
	fmt.Fprintf(&out, "| %s | %s | %s | %s |\n| --- | --- | --- | --- |\n", tr(l, "检查项", "Check"), tr(l, "结论", "Result"), tr(l, "关键读数", "Reading"), tr(l, "证据", "Evidence"))
	linkRefs := markdownEvidenceRefs
	for _, c := range doc.Checks {
		fmt.Fprintf(&out, "| %s | %s | %s | %s |\n", CheckLabel(l, c.Check), StatusLabel(l, c.Status), markdownText(strings.TrimSpace(c.Observed+" "+c.Reading)), linkRefs(c.EvidenceIDs))
	}
	fmt.Fprintf(&out, "\n## %s\n\n", tr(l, "问题与建议", "Findings and recommendations"))
	if len(doc.Findings) == 0 {
		out.WriteString(tr(l, "没有已确认的问题。", "No confirmed findings.") + "\n")
	}
	for _, f := range doc.Findings {
		fmt.Fprintf(&out, "### %s · %s\n\n%s %s\n\n**%s**：%s\n\n**%s**：%s\n\n", StatusLabel(l, f.Severity), markdownText(f.Title), markdownText(f.Detail), linkRefs(f.EvidenceIDs), tr(l, "影响", "Impact"), markdownText(f.Impact), tr(l, "建议", "Recommendation"), markdownText(f.Recommendation))
	}
	confirmed, pending, _ := ReviewStatus(run)
	reviewTitle := tr(l, "未确认项", "Unconfirmed items")
	if confirmed > 0 && pending == 0 {
		reviewTitle = tr(l, "人工核实结果", "Human review results")
	}
	fmt.Fprintf(&out, "\n## %s\n\n", reviewTitle)
	if len(doc.Unknowns) == 0 {
		out.WriteString(tr(l, "本次范围内没有额外未确认项。", "No additional uncertainty within this inspection scope.") + "\n")
	}
	for _, u := range doc.Unknowns {
		fmt.Fprintf(&out, "- **%s**：%s %s\n", markdownText(u.Title), markdownText(u.Detail), linkRefs(u.EvidenceIDs))
		if review, ok := LatestReviews(run)[u.ID]; ok {
			fmt.Fprintf(&out, "  - %s · %s · %s\n", ReviewOutcomeLabel(l, review.Outcome), markdownText(review.Reviewer), review.At.Local().Format("2006-01-02 15:04:05"))
			if review.Note != "" {
				out.WriteString("  - " + markdownText(review.Note) + "\n")
			}
		}
	}
	if len(run.Reviews) > 0 {
		confirmed, pending, _ := ReviewStatus(run)
		fmt.Fprintf(&out, "\n**%s**：%d %s / %d %s\n", tr(l, "人工核实进度", "Human review"), confirmed, tr(l, "已核实", "confirmed"), pending, tr(l, "待核实", "pending"))
		fmt.Fprintf(&out, "\n### %s\n\n", tr(l, "确认记录", "Review history"))
		for _, review := range run.Reviews {
			fmt.Fprintf(&out, "- %s · %s · %s · %s · %s\n", review.At.Local().Format("2006-01-02 15:04:05"), markdownText(review.UnknownID), ReviewOutcomeLabel(l, review.Outcome), markdownText(review.Reviewer), markdownText(review.Note))
		}
	}
	if run.Comparison != nil {
		fmt.Fprintf(&out, "\n## %s\n\n%s: %s · %s\n\n", tr(l, "历史报告对比", "Report comparison"), tr(l, "基准报告", "Baseline"), markdownText(run.Comparison.BaselineID), run.Comparison.BaselineAt.Local().Format("2006-01-02 15:04:05"))
		fmt.Fprintf(&out, "| %s | %s | %s | %s | %s |\n| --- | --- | --- | --- | --- |\n", tr(l, "项目", "Metric"), tr(l, "对象", "Subject"), tr(l, "之前", "Before"), tr(l, "本次", "Current"), tr(l, "变化", "Change"))
		for _, change := range run.Comparison.Changes {
			fmt.Fprintf(&out, "| %s | %s | %s | %s | %s |\n", metricLabel(l, change.Metric), markdownText(change.Subject), markdownText(change.Before), markdownText(change.After), markdownText(change.Delta))
		}
	}
	if len(run.Plans) > 0 {
		fmt.Fprintf(&out, "\n## %s\n\n", tr(l, "执行计划与复查", "Action plans and verification"))
		for _, p := range run.Plans {
			fmt.Fprintf(&out, "### %s · %s\n\n%s\n\n    %s\n\n", markdownText(p.Title), PlanStatusLabel(l, p.Status), markdownText(p.Impact), p.Command)
			if p.Output != "" {
				for _, line := range strings.Split(p.Output, "\n") {
					out.WriteString("    " + line + "\n")
				}
				out.WriteString("\n")
			}
			if p.Error != "" {
				out.WriteString(markdownText(p.Error) + "\n\n")
			}
			if p.VerificationID != "" {
				out.WriteString(tr(l, "复查报告编号：", "Verification report: ") + p.VerificationID + "\n\n")
			}
			if p.VerificationError != "" {
				out.WriteString(markdownText(p.VerificationError) + "\n\n")
			}
		}
	}
	if run.Error != "" {
		fmt.Fprintf(&out, "\n**%s**：%s\n", tr(l, "任务说明", "Task note"), markdownText(LocalizeError(l, run.Error)))
	}
	writeLearningMarkdown(&out, run)
	fmt.Fprintf(&out, "\n## %s\n\n", tr(l, "采集证据", "Collected evidence"))
	for _, e := range run.Evidence {
		fmt.Fprintf(&out, "### %s\n\n**%s %s %s** · %s\n\n", e.ID, CheckLabel(l, e.Query.Check), markdownText(e.Query.Service), queryView(l, e.Query.View), StatusLabel(l, e.Status))
		if e.Reason != "" {
			out.WriteString(markdownText(e.Reason) + "\n\n")
		}
		if !e.CollectedAt.IsZero() {
			label := tr(l, "本次采集", "Newly collected")
			if e.SourceRunID != "" {
				label = tr(l, "历史证据", "Historical evidence")
			}
			fmt.Fprintf(&out, "%s · %s · %s %s\n\n", label, e.CollectedAt.Local().Format("2006-01-02 15:04:05"), markdownText(e.SourceRunID), markdownText(e.SourceEvidenceID))
		}
		if e.Error != "" {
			out.WriteString(markdownText(LocalizeError(l, e.Error)) + "\n\n")
		}
		// Indented code blocks keep arbitrary remote output from changing report structure.
		for _, line := range strings.Split(strings.ReplaceAll(e.Output, "\r", ""), "\n") {
			out.WriteString("    " + line + "\n")
		}
		out.WriteString("\n")
	}
	if len(run.Plans) > 0 {
		out.WriteString(tr(l, "采集是只读的，执行过的操作记录在上面。", "Collection is read-only; any action taken is recorded above.") + "\n")
	} else if run.ParentID != "" {
		out.WriteString(tr(l, "部分证据来自之前的报告，注意看采集时间。", "Part of the evidence comes from the earlier report; check its collection time.") + "\n")
	} else {
		out.WriteString(tr(l, "本次只做了查询，未确认项还需要核实。", "Read-only. Unconfirmed items still need checking.") + "\n")
	}
	return out.String()
}

var unsafeFilename = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]`)

func ExportFilename(run Run) string {
	name := strings.Trim(strings.TrimSpace(unsafeFilename.ReplaceAllString(run.Target, "-")), ". ")
	if name == "" {
		name = "server"
	}
	runes := []rune(name)
	if len(runes) > 60 {
		name = string(runes[:60])
	}
	return name + "-" + run.CreatedAt.Local().Format("20060102-150405") + "-" + run.ID[:min(8, len(run.ID))] + ".md"
}
