package workflow

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

type ActionPlan struct {
	ID                string    `json:"id"`
	Kind              string    `json:"kind"`
	Title             string    `json:"title"`
	Command           string    `json:"command"`
	Impact            string    `json:"impact"`
	Status            string    `json:"status"`
	Output            string    `json:"output,omitempty"`
	Error             string    `json:"error,omitempty"`
	ExitCode          int       `json:"exitCode"`
	RemoteState       string    `json:"remoteState,omitempty"`
	VerificationID    string    `json:"verificationId,omitempty"`
	VerificationError string    `json:"verificationError,omitempty"`
	CreatedAt         time.Time `json:"createdAt"`
	StartedAt         time.Time `json:"startedAt"`
	FinishedAt        time.Time `json:"finishedAt"`
}

func PlanTemplate(run Run, kind string) (ActionPlan, error) {
	p := ActionPlan{Kind: kind, Status: "proposed", CreatedAt: time.Now()}
	switch kind {
	case "restart_service":
		e := evidenceFor(run, "service")
		if run.Workflow != "service_diagnosis" || ValidateService(run.Service) != nil || e.Status != "collected" || e.Truncated || !strings.Contains(e.Output, "LoadState=loaded") {
			return p, fmt.Errorf("a loaded service with complete status evidence is required")
		}
		p.Title = tr(run.Language, "重启所选服务", "Restart selected service")
		p.Command = "systemctl restart -- '" + run.Service + "'"
		p.Impact = tr(run.Language, "服务会短暂中断，现有连接可能断开。使用当前账户权限执行；不提权。执行后重新诊断。", "The service will briefly stop and existing connections may disconnect. Uses current account permissions without elevation. A fresh diagnosis follows.")
	case "vacuum_journal_7d":
		e := evidenceFor(run, "journal")
		if run.Workflow != "disk_diagnosis" || e.Status != "collected" || e.Truncated {
			return p, fmt.Errorf("complete journal size evidence is required")
		}
		p.Title = tr(run.Language, "清理七天前的归档系统日志", "Remove archived system journals older than seven days")
		p.Command = "journalctl --vacuum-time=7d"
		p.Impact = tr(run.Language, "永久删除超过七天的归档系统日志，无法恢复；活动日志不在此清理范围。使用当前账户权限；不提权。执行后重新检查磁盘。", "Permanently deletes archived system journals older than seven days; they cannot be restored. Active journals are outside this cleanup scope. Uses current account permissions without elevation. A fresh disk diagnosis follows.")
	default:
		return p, fmt.Errorf("unsupported action plan")
	}
	return p, nil
}

func (m *Manager) PreparePlan(id, kind string) (Run, error) {
	run, err := m.Get(id)
	if err != nil {
		return Run{}, err
	}
	p, err := PlanTemplate(run, kind)
	if err != nil {
		return Run{}, err
	}
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return Run{}, err
	}
	p.ID = hex.EncodeToString(bytes[:])
	return m.editReport(id, func(r *Run) error {
		if len(r.Plans) >= 12 {
			return fmt.Errorf("action plan limit reached")
		}
		for _, old := range r.Plans {
			if old.Status == "proposed" || old.Status == "running" {
				return fmt.Errorf("review the existing action plan first")
			}
		}
		r.Plans = append(r.Plans, p)
		return nil
	})
}
func (m *Manager) BeginPlan(parent context.Context, id, planID string) (ActionPlan, context.Context, error) {
	m.mu.Lock()
	run := m.runs[id]
	if run == nil || !Terminal(run.State) {
		m.mu.Unlock()
		return ActionPlan{}, nil, fmt.Errorf("finished inspection required")
	}
	for activeID := range m.active {
		if sameRunServer(*run, *m.runs[activeID]) {
			m.mu.Unlock()
			return ActionPlan{}, nil, fmt.Errorf("server inspection is still active")
		}
	}
	for activeID := range m.activePlans {
		if sameRunServer(*run, *m.runs[activeID]) {
			m.mu.Unlock()
			return ActionPlan{}, nil, fmt.Errorf("server action is already active")
		}
	}
	copy := clone(run)
	index := -1
	for i, p := range copy.Plans {
		if p.ID == planID && p.Status == "proposed" {
			index = i
		}
	}
	if index < 0 {
		m.mu.Unlock()
		return ActionPlan{}, nil, fmt.Errorf("action plan is no longer pending")
	}
	// Commands are re-derived from backend templates at execution time.
	template, err := PlanTemplate(copy, copy.Plans[index].Kind)
	if err != nil || template.Command != copy.Plans[index].Command {
		m.mu.Unlock()
		return ActionPlan{}, nil, fmt.Errorf("action plan changed")
	}
	copy.Plans[index].Status = "running"
	copy.Plans[index].StartedAt = time.Now()
	copy.Revision++
	copy.Report = ReportMarkdown(copy)
	if err := m.save(&copy); err != nil {
		m.mu.Unlock()
		return ActionPlan{}, nil, err
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	m.activePlans[id] = cancel
	m.runs[id] = &copy
	snapshot := clone(&copy)
	plan := copy.Plans[index]
	m.mu.Unlock()
	if m.emit != nil {
		m.emit(snapshot)
	}
	return plan, ctx, nil
}
func (m *Manager) FinishPlan(id, planID string, result ActionPlan) (Run, error) {
	result.Output = m.clean(id, result.Output, maxOutput)
	result.Error = m.clean(id, result.Error, 2000)
	m.mu.Lock()
	cancel := m.activePlans[id]
	delete(m.activePlans, id)
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	updated, err := m.editReport(id, func(r *Run) error {
		for i, p := range r.Plans {
			if p.ID == planID && p.Status == "running" {
				p.Status = result.Status
				p.Output = result.Output
				p.Error = LocalizeError(r.Language, result.Error)
				p.ExitCode = result.ExitCode
				p.RemoteState = result.RemoteState
				p.FinishedAt = time.Now()
				r.Plans[i] = p
				return nil
			}
		}
		return fmt.Errorf("active action plan not found")
	})
	if err == nil {
		return updated, nil
	}
	// The remote operation cannot be undone by a failed history write. Expose
	// an unknown outcome in memory and prevent replay of the consumed plan.
	m.mu.Lock()
	run := m.runs[id]
	if run == nil {
		m.mu.Unlock()
		return Run{}, err
	}
	for i := range run.Plans {
		if run.Plans[i].ID == planID {
			run.Plans[i].Status = "unknown"
			run.Plans[i].Output = result.Output
			run.Plans[i].ExitCode = result.ExitCode
			run.Plans[i].RemoteState = result.RemoteState
			run.Plans[i].FinishedAt = time.Now()
			run.Plans[i].Error = tr(run.Language, "操作已发起，但执行记录保存失败，请重新诊断核实结果。", "The operation was attempted but its history could not be saved; run a fresh diagnosis.")
		}
	}
	run.Revision++
	run.Report = ReportMarkdown(*run)
	snapshot := clone(run)
	m.mu.Unlock()
	if m.emit != nil {
		m.emit(snapshot)
	}
	return snapshot, err
}
func (m *Manager) LinkVerification(id, planID, verificationID string) (Run, error) {
	return m.editReport(id, func(r *Run) error {
		for i := range r.Plans {
			if r.Plans[i].ID == planID {
				r.Plans[i].VerificationID = verificationID
				return nil
			}
		}
		return fmt.Errorf("action plan not found")
	})
}
func (m *Manager) RecordVerificationError(id, planID, message string) (Run, error) {
	message = m.clean(id, message, 2000)
	return m.editReport(id, func(r *Run) error {
		for i := range r.Plans {
			if r.Plans[i].ID == planID {
				r.Plans[i].VerificationError = LocalizeError(r.Language, message)
				return nil
			}
		}
		return fmt.Errorf("action plan not found")
	})
}
func (m *Manager) DismissPlan(id, planID string) (Run, error) {
	return m.editReport(id, func(r *Run) error {
		for i := range r.Plans {
			if r.Plans[i].ID == planID && r.Plans[i].Status == "proposed" {
				r.Plans[i].Status = "dismissed"
				r.Plans[i].FinishedAt = time.Now()
				return nil
			}
		}
		return fmt.Errorf("pending plan not found")
	})
}
func sameRunServer(a, b Run) bool {
	if a.ProfileID != "" {
		return a.ProfileID == b.ProfileID
	}
	return a.SessionID == b.SessionID
}

func PlanStatusLabel(language, status string) string {
	switch status {
	case "proposed":
		return tr(language, "待审核", "Pending review")
	case "running":
		return tr(language, "执行中", "Running")
	case "completed":
		return tr(language, "命令执行成功", "Command succeeded")
	case "failed":
		return tr(language, "命令执行失败", "Command failed")
	case "dismissed":
		return tr(language, "已撤回计划", "Plan dismissed")
	default:
		return tr(language, "远程结果未确认", "Remote outcome unknown")
	}
}
