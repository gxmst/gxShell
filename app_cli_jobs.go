package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	sshmanager "gxShell/backend/ssh"
)

const cliJobRetention = 30 * time.Minute

var allowedCliShells = map[string]struct{}{
	"sh": {}, "bash": {}, "dash": {}, "zsh": {}, "ksh": {},
}

func isAllowedCliShell(shell string) bool {
	_, ok := allowedCliShells[shell]
	return ok
}

type cliJobEvent struct {
	Sequence int64  `json:"sequence"`
	Stream   string `json:"stream"`
	Data     string `json:"data"`
}

type cliJob struct {
	mu         sync.Mutex
	ID         string
	Alias      string
	SessionID  string
	Command    string
	State      string
	CreatedAt  time.Time
	StartedAt  time.Time
	FinishedAt time.Time
	Events     []cliJobEvent
	NextSeq    int64
	Result     sshmanager.CommandExecutionResult
	cancel     context.CancelFunc
}

func newCliResourceID(prefix string) string {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
	}
	return prefix + "-" + hex.EncodeToString(raw[:])
}

func (a *App) startCliJob(alias, sessionID, command string, stdin *string, timeout time.Duration) *cliJob {
	ctx, cancel := context.WithCancel(context.Background())
	job := &cliJob{
		ID: newCliResourceID("job"), Alias: alias, SessionID: sessionID,
		Command: command, State: "queued", CreatedAt: time.Now(), cancel: cancel,
	}
	a.cliJobsMu.Lock()
	if a.cliJobs == nil {
		a.cliJobs = map[string]*cliJob{}
	}
	a.pruneCliJobsLocked(time.Now())
	a.cliJobs[job.ID] = job
	a.cliJobsMu.Unlock()

	go func() {
		job.mu.Lock()
		job.State = "running"
		job.StartedAt = time.Now()
		job.mu.Unlock()

		activityID := a.beginTerminalAutomation(sessionID, "cli", "execute_command", command)
		result, err := a.ssh.ExecuteCommandResultStream(ctx, sessionID, command, stdin, timeout, cliOutputLimit, func(stream string, chunk []byte) {
			job.mu.Lock()
			job.NextSeq++
			job.Events = append(job.Events, cliJobEvent{Sequence: job.NextSeq, Stream: stream, Data: string(chunk)})
			job.mu.Unlock()
		})
		if err != nil {
			result.Error = err.Error()
			if result.ExitCode == 0 {
				result.ExitCode = 1
			}
		}
		a.finishTerminalAutomation(sessionID, activityID, "cli", "execute_command", result.DisplayOutput(), result.Error, result.ExitCode, result.Duration, result.Truncated)

		job.mu.Lock()
		job.Result = result
		job.FinishedAt = time.Now()
		switch {
		case ctx.Err() != nil:
			job.State = "cancelled"
		case result.TimedOut:
			job.State = "failed"
		case result.Error != "" || result.ExitCode != 0:
			job.State = "failed"
		default:
			job.State = "succeeded"
		}
		job.mu.Unlock()
	}()
	return job
}

func (a *App) handleCliJobs(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		writeCliError(w, http.StatusBadRequest, "validation", "job id is required")
		return
	}
	job := a.cliJobByID(id)
	if job == nil {
		writeCliError(w, http.StatusNotFound, "daemon", "job not found")
		return
	}

	switch r.Method {
	case http.MethodGet:
		after := int64(0)
		if raw := strings.TrimSpace(r.URL.Query().Get("after")); raw != "" {
			parsed, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || parsed < 0 {
				writeCliError(w, http.StatusBadRequest, "validation", "after must be a non-negative integer")
				return
			}
			after = parsed
		}
		writeCliJSON(w, http.StatusOK, cliJobSnapshot(job, after))
	case http.MethodDelete:
		job.mu.Lock()
		terminal := isCliJobTerminal(job.State)
		cancel := job.cancel
		job.mu.Unlock()
		if !terminal && cancel != nil {
			cancel()
		}
		writeCliJSON(w, http.StatusOK, map[string]any{"jobId": id, "cancelRequested": !terminal})
	default:
		writeCliError(w, http.StatusMethodNotAllowed, "validation", "method not allowed")
	}
}

func (a *App) cliJobByID(id string) *cliJob {
	a.cliJobsMu.Lock()
	defer a.cliJobsMu.Unlock()
	a.pruneCliJobsLocked(time.Now())
	return a.cliJobs[id]
}

func (a *App) pruneCliJobsLocked(now time.Time) {
	for id, job := range a.cliJobs {
		job.mu.Lock()
		finished := job.FinishedAt
		terminal := isCliJobTerminal(job.State)
		job.mu.Unlock()
		if terminal && !finished.IsZero() && now.Sub(finished) > cliJobRetention {
			delete(a.cliJobs, id)
		}
	}
}

func cliJobSnapshot(job *cliJob, after int64) map[string]any {
	job.mu.Lock()
	defer job.mu.Unlock()
	events := make([]cliJobEvent, 0)
	for _, event := range job.Events {
		if event.Sequence > after {
			events = append(events, event)
		}
	}
	payload := map[string]any{
		"jobId": job.ID, "alias": job.Alias, "state": job.State,
		"createdAt": job.CreatedAt, "events": events, "nextSequence": job.NextSeq,
	}
	if !job.StartedAt.IsZero() {
		payload["startedAt"] = job.StartedAt
	}
	if !job.FinishedAt.IsZero() {
		payload["finishedAt"] = job.FinishedAt
		payload["exitCode"] = job.Result.ExitCode
		payload["timedOut"] = job.Result.TimedOut
		payload["truncated"] = job.Result.Truncated
		payload["durationMs"] = job.Result.Duration.Milliseconds()
		if job.Result.Error != "" {
			payload["error"] = job.Result.Error
			payload["errorKind"] = "remote"
		}
	}
	return payload
}

func isCliJobTerminal(state string) bool {
	return state == "succeeded" || state == "failed" || state == "cancelled"
}

func (a *App) cancelCliJobs() {
	a.cliJobsMu.Lock()
	jobs := make([]*cliJob, 0, len(a.cliJobs))
	for _, job := range a.cliJobs {
		jobs = append(jobs, job)
	}
	a.cliJobsMu.Unlock()
	for _, job := range jobs {
		job.mu.Lock()
		if !isCliJobTerminal(job.State) && job.cancel != nil {
			job.cancel()
		}
		job.mu.Unlock()
	}
}
