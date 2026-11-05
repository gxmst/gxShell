package workflow

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Change struct {
	Metric  string `json:"metric"`
	Subject string `json:"subject"`
	Before  string `json:"before"`
	After   string `json:"after"`
	Delta   string `json:"delta"`
	State   string `json:"state"`
}
type Comparison struct {
	BaselineID string    `json:"baselineId"`
	BaselineAt time.Time `json:"baselineAt"`
	ComparedAt time.Time `json:"comparedAt"`
	Changes    []Change  `json:"changes"`
}
type diskValue struct {
	used, total int64
	percent     int
}

func diskValues(e Evidence) map[string]diskValue {
	values := map[string]diskValue{}
	if e.Status != "collected" || e.Truncated {
		return values
	}
	for _, line := range strings.Split(e.Output, "\n") {
		f := strings.Fields(line)
		if len(f) < 6 || !strings.HasSuffix(f[4], "%") {
			continue
		}
		total, e1 := strconv.ParseInt(f[1], 10, 64)
		used, e2 := strconv.ParseInt(f[2], 10, 64)
		percent, e3 := strconv.Atoi(strings.TrimSuffix(f[4], "%"))
		if e1 == nil && e2 == nil && e3 == nil && total > 0 && used >= 0 && percent >= 0 && percent <= 100 {
			values[f[5]] = diskValue{used: used, total: total, percent: percent}
		}
	}
	return values
}
func evidenceFor(run Run, check string) Evidence {
	for i := len(run.Evidence) - 1; i >= 0; i-- {
		e := run.Evidence[i]
		if e.Query.Check == check {
			if check == "service" && e.Query.View != "status" {
				continue
			}
			return e
		}
	}
	return Evidence{}
}
func memoryValues(e Evidence) (used, available int64, ok bool) {
	if e.Status != "collected" || e.Truncated {
		return
	}
	for _, line := range strings.Split(e.Output, "\n") {
		f := strings.Fields(line)
		if len(f) >= 7 && f[0] == "Mem:" {
			var e1, e2 error
			used, e1 = strconv.ParseInt(f[2], 10, 64)
			available, e2 = strconv.ParseInt(f[6], 10, 64)
			ok = e1 == nil && e2 == nil && used >= 0 && available >= 0
			return
		}
	}
	return
}
func listValues(e Evidence, services bool) ([]string, bool) {
	if e.Status != "collected" || e.Truncated {
		return nil, false
	}
	if services && !strings.Contains(e.Output, "GXSHELL_SERVICE_MANAGER=systemd") {
		return nil, false
	}
	set := map[string]bool{}
	for _, line := range strings.Split(e.Output, "\n") {
		f := strings.Fields(line)
		if services {
			for _, v := range f {
				if strings.HasSuffix(v, ".service") || strings.HasSuffix(v, ".socket") || strings.HasSuffix(v, ".timer") {
					set[v] = true
					break
				}
			}
		} else if len(f) >= 5 && (f[0] == "LISTEN" || strings.HasPrefix(f[0], "tcp")) {
			set[f[3]] = true
		}
	}
	out := []string{}
	for v := range set {
		out = append(out, v)
	}
	sort.Strings(out)
	return out, true
}

func CompareReports(current, baseline Run) (*Comparison, error) {
	sameServer := current.ProfileID != "" && current.ProfileID == baseline.ProfileID
	if current.ProfileID == "" {
		sameServer = current.SessionID != "" && current.SessionID == baseline.SessionID
	}
	if !sameServer || current.Workflow != baseline.Workflow || current.Service != baseline.Service || current.Port != baseline.Port || !current.CreatedAt.After(baseline.CreatedAt) || !Terminal(current.State) || !Terminal(baseline.State) {
		return nil, fmt.Errorf("select an earlier report for the same server and workflow")
	}
	c := &Comparison{BaselineID: baseline.ID, BaselineAt: baseline.CreatedAt, ComparedAt: time.Now(), Changes: []Change{}}
	l := current.Language
	add := func(metric, subject, before, after, delta string, valid bool) {
		state := "unchanged"
		if !valid {
			state = "unknown"
			before = tr(l, "数据不完整", "Incomplete data")
			after = before
			delta = ""
		} else if before != after {
			state = "changed"
		}
		c.Changes = append(c.Changes, Change{Metric: metric, Subject: subject, Before: before, After: after, Delta: delta, State: state})
	}
	for _, metric := range []string{"disk", "inodes"} {
		if !containsCheck(RunChecks(current), metric) {
			continue
		}
		oldDisk, newDisk := diskValues(evidenceFor(baseline, metric)), diskValues(evidenceFor(current, metric))
		mounts := map[string]bool{}
		for m := range oldDisk {
			mounts[m] = true
		}
		for m := range newDisk {
			mounts[m] = true
		}
		names := []string{}
		for m := range mounts {
			names = append(names, m)
		}
		sort.Strings(names)
		if len(names) == 0 {
			add(metric, "", "", "", "", false)
		}
		for _, m := range names {
			a, aok := oldDisk[m]
			b, bok := newDisk[m]
			before, after, delta := fmt.Sprintf("%d%% · %.1f MiB", a.percent, float64(a.used)/1024), fmt.Sprintf("%d%% · %.1f MiB", b.percent, float64(b.used)/1024), fmt.Sprintf("%+d%% · %+.1f MiB", b.percent-a.percent, float64(b.used-a.used)/1024)
			if metric == "inodes" {
				before, after, delta = fmt.Sprintf("%d%% · %d", a.percent, a.used), fmt.Sprintf("%d%% · %d", b.percent, b.used), fmt.Sprintf("%+d%% · %+d", b.percent-a.percent, b.used-a.used)
			}
			add(metric, m, before, after, delta, aok && bok)
		}
	}
	if containsCheck(RunChecks(current), "disk_usage") {
		oldDirs, newDirs := directoryValues(evidenceFor(baseline, "disk_usage")), directoryValues(evidenceFor(current, "disk_usage"))
		for _, scope := range DiskScopes {
			a, aok := oldDirs[scope]
			b, bok := newDirs[scope]
			add("disk_usage", scope, fmt.Sprintf("%.1f MiB", float64(a)/1024), fmt.Sprintf("%.1f MiB", float64(b)/1024), fmt.Sprintf("%+.1f MiB", float64(b-a)/1024), aok && bok)
		}
	}
	if containsCheck(RunChecks(current), "memory") {
		a, av, aok := memoryValues(evidenceFor(baseline, "memory"))
		b, bv, bok := memoryValues(evidenceFor(current, "memory"))
		add("memory_used", "", fmt.Sprintf("%d MiB", a), fmt.Sprintf("%d MiB", b), fmt.Sprintf("%+d MiB", b-a), aok && bok)
		add("memory_available", "", fmt.Sprintf("%d MiB", av), fmt.Sprintf("%d MiB", bv), fmt.Sprintf("%+d MiB", bv-av), aok && bok)
	}
	if containsCheck(RunChecks(current), "load") {
		oldLoad, newLoad := evidenceFor(baseline, "load"), evidenceFor(current, "load")
		oldMatch, newMatch := loadValues.FindStringSubmatch(oldLoad.Output), loadValues.FindStringSubmatch(newLoad.Output)
		for i := 1; i <= 3; i++ {
			if oldLoad.Status == "collected" && newLoad.Status == "collected" && !oldLoad.Truncated && !newLoad.Truncated && len(oldMatch) == 4 && len(newMatch) == 4 {
				a, _ := strconv.ParseFloat(oldMatch[i], 64)
				b, _ := strconv.ParseFloat(newMatch[i], 64)
				add("load", []string{"1m", "5m", "15m"}[i-1], oldMatch[i], newMatch[i], fmt.Sprintf("%+.2f", b-a), true)
			} else {
				add("load", []string{"1m", "5m", "15m"}[i-1], "", "", "", false)
			}
		}
	}
	for _, metric := range []string{"ports", "services"} {
		if !containsCheck(RunChecks(current), metric) {
			continue
		}
		a, aok := listValues(evidenceFor(baseline, metric), metric == "services")
		b, bok := listValues(evidenceFor(current, metric), metric == "services")
		old, new := strings.Join(a, ", "), strings.Join(b, ", ")
		empty := tr(l, "无", "None")
		if old == "" {
			old = empty
		}
		if new == "" {
			new = empty
		}
		delta := []string{}
		for _, v := range b {
			if !containsCheck(a, v) {
				delta = append(delta, "+ "+v)
			}
		}
		for _, v := range a {
			if !containsCheck(b, v) {
				delta = append(delta, "− "+v)
			}
		}
		add(metric, "", old, new, strings.Join(delta, "; "), aok && bok)
	}
	// Service and port snapshots supplement resource trends for targeted diagnoses.
	if current.Workflow == "service_diagnosis" {
		a, b := evidenceFor(baseline, "service"), evidenceFor(current, "service")
		add("service_state", current.Service, strings.TrimSpace(a.Output), strings.TrimSpace(b.Output), "", a.Status == "collected" && b.Status == "collected" && !a.Truncated && !b.Truncated)
	}
	return c, nil
}

func (m *Manager) Compare(currentID, baselineID string) (Run, error) {
	current, err := m.Get(currentID)
	if err != nil {
		return Run{}, err
	}
	baseline, err := m.Get(baselineID)
	if err != nil {
		return Run{}, err
	}
	comparison, err := CompareReports(current, baseline)
	if err != nil {
		return Run{}, err
	}
	return m.editReport(currentID, func(r *Run) error { r.Comparison = comparison; return nil })
}
func metricLabel(language, metric string) string {
	switch metric {
	case "disk":
		return CheckLabel(language, "disk")
	case "inodes", "disk_usage":
		return CheckLabel(language, metric)
	case "memory_used":
		return tr(language, "已用内存", "Used memory")
	case "memory_available":
		return tr(language, "可用内存", "Available memory")
	case "load":
		return CheckLabel(language, "load")
	case "ports":
		return CheckLabel(language, "ports")
	case "services":
		return tr(language, "失败服务单元", "Failed service units")
	case "service_state":
		return CheckLabel(language, "service")
	default:
		return metric
	}
}

func directoryValues(e Evidence) map[string]int64 {
	values := map[string]int64{}
	if e.Status != "collected" || e.Truncated {
		return values
	}
	for _, line := range strings.Split(e.Output, "\n") {
		f := strings.Fields(line)
		if len(f) != 2 || !containsCheck(DiskScopes, f[1]) {
			continue
		}
		n, err := strconv.ParseInt(f[0], 10, 64)
		if err == nil && n >= 0 {
			values[f[1]] = n
		}
	}
	return values
}
