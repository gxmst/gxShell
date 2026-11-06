package workflow

import "sort"

// ModelStats summarizes saved diagnostic runs for one provider and model, so
// report reliability on real hosts can be measured instead of guessed.
type ModelStats struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	// Runs counts finished tasks. Stopped (cancelled or interrupted) runs are
	// counted but excluded from every outcome and average below.
	Runs    int `json:"runs"`
	Stopped int `json:"stopped"`
	// Report outcomes judged from report_validation trace steps: accepted on the
	// first answer, accepted after correction or repair, never accepted, and no
	// report answer at all (the task ended before one arrived).
	Clean     int `json:"clean"`
	Corrected int `json:"corrected"`
	Failed    int `json:"failed"`
	NoReport  int `json:"noReport"`
	// Latest user feedback per run.
	FalseAlarms   int   `json:"falseAlarms"`
	MissedIssues  int   `json:"missedIssues"`
	AvgTokens     int   `json:"avgTokens"`
	AvgDurationMs int64 `json:"avgDurationMs"`
}

func reportOutcome(run *Run) string {
	first, accepted := "", false
	for _, step := range run.Trace {
		if step.Kind != "report_validation" {
			continue
		}
		if first == "" {
			first = step.State
		}
		if step.State == "completed" || step.State == "corrected" {
			accepted = true
		}
	}
	switch {
	case first == "":
		return "none"
	case first == "completed":
		return "clean"
	case accepted:
		return "corrected"
	}
	return "failed"
}

// Stats groups finished runs by provider and model, most-used first.
func (m *Manager) Stats() []ModelStats {
	type totals struct {
		ModelStats
		tokens   int
		duration int64
	}
	m.mu.Lock()
	groups := map[[2]string]*totals{}
	for _, run := range m.runs {
		if !Terminal(run.State) {
			continue
		}
		key := [2]string{run.Provider, run.Model}
		group := groups[key]
		if group == nil {
			group = &totals{ModelStats: ModelStats{Provider: run.Provider, Model: run.Model}}
			groups[key] = group
		}
		group.Runs++
		if run.State == "cancelled" || run.State == "interrupted" {
			group.Stopped++
			continue
		}
		switch reportOutcome(run) {
		case "clean":
			group.Clean++
		case "corrected":
			group.Corrected++
		case "failed":
			group.Failed++
		default:
			group.NoReport++
		}
		if n := len(run.Feedback); n > 0 {
			switch run.Feedback[n-1].Outcome {
			case "false_alarm":
				group.FalseAlarms++
			case "missed_issue":
				group.MissedIssues++
			}
		}
		group.tokens += run.PromptTokens + run.CompletionTokens
		if !run.FinishedAt.IsZero() && run.FinishedAt.After(run.CreatedAt) {
			group.duration += run.FinishedAt.Sub(run.CreatedAt).Milliseconds()
		}
	}
	m.mu.Unlock()
	out := make([]ModelStats, 0, len(groups))
	for _, group := range groups {
		if counted := group.Runs - group.Stopped; counted > 0 {
			group.AvgTokens = group.tokens / counted
			group.AvgDurationMs = group.duration / int64(counted)
		}
		out = append(out, group.ModelStats)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Runs != out[j].Runs {
			return out[i].Runs > out[j].Runs
		}
		return out[i].Provider+"/"+out[i].Model < out[j].Provider+"/"+out[j].Model
	})
	return out
}
