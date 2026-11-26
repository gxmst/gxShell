package sftpmanager

import (
	"slices"
	"sync"
	"time"
)

// The latest event for each live job and the last 50 outcomes outlive all views.
// Published events are immutable after record returns.
type transferJournal struct {
	mu       sync.Mutex
	revision uint64
	active   map[string]map[string]any
	history  []map[string]any // oldest first
}

type TransferSnapshot struct {
	Revision uint64           `json:"revision"`
	Events   []map[string]any `json:"events"`
}

func (j *transferJournal) record(job *transferJob, sequence uint64, event map[string]any) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	if sequence <= job.publishedSequence {
		return false
	}
	job.publishedSequence = sequence
	j.revision++
	event["revision"] = j.revision
	if prev := j.active[job.id]; prev != nil && event["resumedAt"] == nil && prev["resumedAt"] != nil {
		event["resumedAt"] = prev["resumedAt"]
	}
	if event["finished"] == true {
		delete(j.active, job.id)
		event["finishedAt"] = time.Now().UnixMilli()
		j.history = append(j.history, event)
		if len(j.history) > 50 {
			j.history = slices.Delete(j.history, 0, 1)
		}
	} else {
		if j.active == nil {
			j.active = make(map[string]map[string]any)
		}
		j.active[job.id] = event
	}
	return true
}

func (m *Manager) TransferSnapshot() TransferSnapshot {
	j := &m.journal
	j.mu.Lock()
	defer j.mu.Unlock()
	events := make([]map[string]any, 0, len(j.history)+len(j.active))
	events = append(events, j.history...)
	for _, event := range j.active {
		events = append(events, event)
	}
	return TransferSnapshot{Revision: j.revision, Events: events}
}

func (m *Manager) ClearTransferHistory(sessionID string) {
	j := &m.journal
	j.mu.Lock()
	j.history = slices.DeleteFunc(j.history, func(event map[string]any) bool {
		return sessionID == "" || event["sessionId"] == sessionID
	})
	j.revision++
	revision := j.revision
	j.mu.Unlock()
	if m.emit != nil {
		m.emit("sftp:history-cleared", map[string]any{"sessionId": sessionID, "revision": revision})
	}
}
