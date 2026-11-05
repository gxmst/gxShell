package workflow

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

type Review struct {
	UnknownID string    `json:"unknownId"`
	Outcome   string    `json:"outcome"`
	Note      string    `json:"note"`
	Reviewer  string    `json:"reviewer"`
	At        time.Time `json:"at"`
}

func ensureUnknownIDs(doc *ReportDocument) {
	if doc == nil {
		return
	}
	for i := range doc.Unknowns {
		u := &doc.Unknowns[i]
		sum := sha256.Sum256([]byte(fmt.Sprintf("%d\n%s\n%s\n%s", i, u.Title, u.Detail, strings.Join(u.EvidenceIDs, ","))))
		u.ID = hex.EncodeToString(sum[:8])
	}
}

func LatestReviews(run Run) map[string]Review {
	latest := map[string]Review{}
	for _, review := range run.Reviews {
		latest[review.UnknownID] = review
	}
	return latest
}

func ReviewStatus(run Run) (confirmed, pending int, issue bool) {
	if run.Document == nil {
		return
	}
	latest := LatestReviews(run)
	for _, u := range run.Document.Unknowns {
		r := latest[u.ID]
		if r.Outcome != "" && r.Outcome != "pending" {
			confirmed++
			if r.Outcome == "issue" {
				issue = true
			}
		} else {
			pending++
		}
	}
	return
}

// Human review is a durable overlay. It never overwrites model conclusions,
// measurements or remote evidence, and withdrawal remains in the audit history.
func (m *Manager) ReviewUnknown(id, unknownID, outcome, note, reviewer string) (Run, error) {
	if !containsCheck([]string{"normal", "issue", "not_applicable", "pending"}, outcome) {
		return Run{}, fmt.Errorf("invalid review outcome")
	}
	if len(note) > 2000 {
		return Run{}, fmt.Errorf("review note exceeds limit")
	}
	note = m.clean(id, strings.TrimSpace(note), 2000)
	return m.editReport(id, func(r *Run) error {
		if r.Document == nil {
			return fmt.Errorf("structured report required")
		}
		found := false
		for _, u := range r.Document.Unknowns {
			if u.ID == unknownID {
				found = true
			}
		}
		if !found {
			return fmt.Errorf("unconfirmed item not found")
		}
		if len(r.Reviews) >= 256 {
			return fmt.Errorf("review history limit reached")
		}
		r.Reviews = append(r.Reviews, Review{UnknownID: unknownID, Outcome: outcome, Note: note, Reviewer: reviewer, At: time.Now()})
		return nil
	})
}

func (m *Manager) editReport(id string, fn func(*Run) error) (Run, error) {
	m.mu.Lock()
	current := m.runs[id]
	if current == nil || !Terminal(current.State) {
		m.mu.Unlock()
		return Run{}, fmt.Errorf("finished inspection required")
	}
	copy := clone(current)
	if err := fn(&copy); err != nil {
		m.mu.Unlock()
		return Run{}, err
	}
	copy.Revision++
	copy.Report = ReportMarkdown(copy)
	if err := m.save(&copy); err != nil {
		m.mu.Unlock()
		return Run{}, err
	}
	m.runs[id] = &copy
	snapshot := clone(&copy)
	m.mu.Unlock()
	if m.emit != nil {
		m.emit(snapshot)
	}
	return snapshot, nil
}

func ReviewOutcomeLabel(language, outcome string) string {
	switch outcome {
	case "normal":
		return tr(language, "人工确认正常", "Manually confirmed normal")
	case "issue":
		return tr(language, "人工确认存在问题", "Manually confirmed issue")
	case "not_applicable":
		return tr(language, "人工确认不适用", "Manually confirmed not applicable")
	default:
		return tr(language, "待核实", "Pending review")
	}
}
