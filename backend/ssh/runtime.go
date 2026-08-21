package sshmanager

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"gxShell/backend/types"
)

// RuntimeState is the lifecycle state of a stable remote runtime. The current
// SSH manager only transitions through connecting/active/disconnected/error;
// link_down and reconnecting are reserved for the coordinator that will own
// recovery in a later increment.
type RuntimeState string

const (
	RuntimeConnecting   RuntimeState = "connecting"
	RuntimeActive       RuntimeState = "active"
	RuntimeLinkDown     RuntimeState = "link_down"
	RuntimeReconnecting RuntimeState = "reconnecting"
	RuntimeDisconnected RuntimeState = "disconnected"
	RuntimeError        RuntimeState = "error"
)

// EventEnvelope is attached to session-scoped events. sessionId remains the
// legacy routing key; runtimeId and generation let a consumer reject an event
// that arrived from a superseded physical connection.
type EventEnvelope struct {
	SessionID  string       `json:"sessionId"`
	RuntimeID  string       `json:"runtimeId"`
	Generation uint64       `json:"generation"`
	State      RuntimeState `json:"state"`
}

// Fields returns the JSON-shaped fields used by Wails event payloads. Keeping
// this in one place prevents individual events from drifting as the lifecycle
// model grows.
func (e EventEnvelope) Fields() map[string]any {
	return map[string]any{
		"sessionId":  e.SessionID,
		"runtimeId":  e.RuntimeID,
		"generation": e.Generation,
		"state":      e.State,
	}
}

// RuntimeSnapshot is the stable, node-level view that survives a session
// replacement. A disconnected runtime still retains its latest generation so
// callers can fence stale work without keeping the old SSH objects alive.
type RuntimeSnapshot struct {
	RuntimeID  string       `json:"runtimeId"`
	Generation uint64       `json:"generation"`
	SessionID  string       `json:"sessionId,omitempty"`
	State      RuntimeState `json:"state"`
	UpdatedAt  time.Time    `json:"updatedAt"`
}

// SessionSnapshot combines the legacy session information with the new
// runtime identity. It is intentionally additive and does not replace
// types.SessionInfo in existing public methods.
type SessionSnapshot struct {
	EventEnvelope
	ProfileID string    `json:"profileId"`
	Name      string    `json:"name"`
	Error     string    `json:"error,omitempty"`
	Cols      int       `json:"cols"`
	Rows      int       `json:"rows"`
	StartedAt time.Time `json:"startedAt"`
}

type runtimeRecord struct {
	generation     uint64
	currentSession string
	state          RuntimeState
	updatedAt      time.Time
}

type connectCall struct {
	done chan struct{}
	info types.SessionInfo
	err  error
}

const (
	maxRuntimeRecords = 512
	runtimeRecordTTL  = 24 * time.Hour
)

// beginRuntimeConnect elects one caller as the owner of a physical handshake.
// It also reuses a healthy current session, which makes the backend robust to
// duplicate entry points (UI double-click, restore, reconnect, and CLI).
func (m *Manager) beginRuntimeConnect(runtimeID string) (types.SessionInfo, *connectCall, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.connecting == nil {
		m.connecting = make(map[string]*connectCall)
	}
	m.pruneRuntimeRecordsLocked(time.Now(), runtimeID)
	if call := m.connecting[runtimeID]; call != nil {
		return types.SessionInfo{}, call, false
	}
	if record := m.runtimes[runtimeID]; record != nil && record.currentSession != "" {
		if session := m.sessions[record.currentSession]; session != nil {
			session.mu.RLock()
			info := session.info
			session.mu.RUnlock()
			if info.State == types.SessionConnected {
				return info, nil, false
			}
		}
	}
	call := &connectCall{done: make(chan struct{})}
	m.connecting[runtimeID] = call
	return types.SessionInfo{}, call, true
}

func (m *Manager) finishRuntimeConnect(runtimeID string, call *connectCall, info types.SessionInfo, err error) {
	m.mu.Lock()
	if m.connecting[runtimeID] == call {
		delete(m.connecting, runtimeID)
	}
	call.info = info
	call.err = err
	close(call.done)
	m.mu.Unlock()
}

func (m *Manager) pruneRuntimeRecordsLocked(now time.Time, keepRuntimeID string) {
	for runtimeID, record := range m.runtimes {
		if runtimeID != keepRuntimeID && record.currentSession == "" && now.Sub(record.updatedAt) >= runtimeRecordTTL {
			delete(m.runtimes, runtimeID)
		}
	}
	if len(m.runtimes) < maxRuntimeRecords {
		return
	}
	type candidate struct {
		id        string
		updatedAt time.Time
	}
	candidates := make([]candidate, 0, len(m.runtimes))
	for runtimeID, record := range m.runtimes {
		if runtimeID != keepRuntimeID && record.currentSession == "" {
			candidates = append(candidates, candidate{id: runtimeID, updatedAt: record.updatedAt})
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].updatedAt.Before(candidates[j].updatedAt) })
	for _, item := range candidates {
		if len(m.runtimes) < maxRuntimeRecords {
			break
		}
		delete(m.runtimes, item.id)
	}
}

// RuntimeIDForProfile returns a stable, non-secret identity for a saved
// connection. Profile IDs are preferred because two profiles may intentionally
// point at the same host with different credentials or jump routes. The
// endpoint fallback only uses non-secret connection coordinates for callers
// constructing an unsaved profile.
func RuntimeIDForProfile(profile types.Profile) string {
	if profile.ID != "" {
		return "profile:" + profile.ID
	}
	port := profile.Port
	if port <= 0 {
		port = 22
	}
	seed := strings.Join([]string{
		strings.TrimSpace(profile.Host),
		fmt.Sprintf("%d", port),
		strings.TrimSpace(profile.Username),
		string(profile.AuthType),
		strings.TrimSpace(profile.ProxyJumpID),
	}, "\x00")
	digest := sha256.Sum256([]byte(seed))
	return "endpoint:" + hex.EncodeToString(digest[:12])
}

func runtimeStateForSession(state types.SessionState) RuntimeState {
	switch state {
	case types.SessionConnecting:
		return RuntimeConnecting
	case types.SessionConnected:
		return RuntimeActive
	case types.SessionDisconnected:
		return RuntimeDisconnected
	case types.SessionError:
		return RuntimeError
	default:
		return RuntimeState(state)
	}
}

func (m *Manager) reserveRuntime(runtimeID, sessionID string) uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.reserveRuntimeLocked(runtimeID, sessionID)
}

func (m *Manager) reserveRuntimeLocked(runtimeID, sessionID string) uint64 {
	if m.runtimes == nil {
		m.runtimes = make(map[string]*runtimeRecord)
	}
	m.pruneRuntimeRecordsLocked(time.Now(), runtimeID)
	record := m.runtimes[runtimeID]
	if record == nil {
		record = &runtimeRecord{}
		m.runtimes[runtimeID] = record
	}
	record.generation++
	record.currentSession = sessionID
	record.state = RuntimeConnecting
	record.updatedAt = time.Now()
	return record.generation
}

// updateRuntimeState changes the node state only when session is still the
// current generation. Late cleanup from an older session must never overwrite
// the state of a newer connection.
func (m *Manager) updateRuntimeState(session *Session, state RuntimeState) {
	if session == nil {
		return
	}
	session.mu.RLock()
	runtimeID := session.info.RuntimeID
	generation := session.info.Generation
	sessionID := session.info.ID
	session.mu.RUnlock()
	if runtimeID == "" || generation == 0 {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	record := m.runtimes[runtimeID]
	if record == nil || record.generation != generation {
		return
	}
	record.state = state
	record.updatedAt = time.Now()
	if state == RuntimeDisconnected || state == RuntimeError {
		if record.currentSession == sessionID {
			record.currentSession = ""
		}
	} else {
		record.currentSession = sessionID
	}
}

func (m *Manager) runtimeSnapshot(runtimeID string) (RuntimeSnapshot, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	record := m.runtimes[runtimeID]
	if record == nil {
		return RuntimeSnapshot{}, false
	}
	return RuntimeSnapshot{
		RuntimeID:  runtimeID,
		Generation: record.generation,
		SessionID:  record.currentSession,
		State:      record.state,
		UpdatedAt:  record.updatedAt,
	}, true
}

// RuntimeSnapshot returns the current state for a stable runtime identity.
func (m *Manager) RuntimeSnapshot(runtimeID string) (RuntimeSnapshot, bool) {
	return m.runtimeSnapshot(runtimeID)
}

// SessionSnapshot returns an additive view of an SSH session and its runtime
// envelope. Unlike Get, this method is intended for consumers that need to
// fence asynchronous work by generation.
func (m *Manager) SessionSnapshot(sessionID string) (SessionSnapshot, error) {
	session, err := m.get(sessionID)
	if err != nil {
		return SessionSnapshot{}, err
	}
	session.mu.RLock()
	defer session.mu.RUnlock()
	return SessionSnapshot{
		EventEnvelope: EventEnvelope{
			SessionID:  session.info.ID,
			RuntimeID:  session.info.RuntimeID,
			Generation: session.info.Generation,
			State:      runtimeStateForSession(session.info.State),
		},
		ProfileID: session.info.ProfileID,
		Name:      session.info.Name,
		Error:     session.info.Error,
		Cols:      session.info.Cols,
		Rows:      session.info.Rows,
		StartedAt: session.info.StartedAt,
	}, nil
}

// SessionRuntime returns the node-level snapshot associated with a session.
// It is useful to hand a consumer a stable identity without exposing SSH
// pointers or requiring it to understand the session map.
func (m *Manager) SessionRuntime(sessionID string) (RuntimeSnapshot, error) {
	session, err := m.get(sessionID)
	if err != nil {
		return RuntimeSnapshot{}, err
	}
	session.mu.RLock()
	runtimeID := session.info.RuntimeID
	session.mu.RUnlock()
	if snapshot, ok := m.runtimeSnapshot(runtimeID); ok {
		return snapshot, nil
	}
	return RuntimeSnapshot{}, errors.New("runtime not found")
}

// IsCurrentGeneration reports whether a runtime generation is still the latest
// one. It does not require the runtime to be connected, so consumers can use it
// as a stale-event fence during teardown and reconnect.
func (m *Manager) IsCurrentGeneration(runtimeID string, generation uint64) bool {
	if runtimeID == "" || generation == 0 {
		return false
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	record := m.runtimes[runtimeID]
	return record != nil && record.generation == generation
}

// IsCurrent reports whether a session still owns the latest generation for its
// runtime. A session that has been removed from the manager is never current.
func (m *Manager) IsCurrent(sessionID string, generation uint64) bool {
	m.mu.RLock()
	session := m.sessions[sessionID]
	if session == nil {
		m.mu.RUnlock()
		return false
	}
	m.mu.RUnlock()
	session.mu.RLock()
	runtimeID := session.info.RuntimeID
	sessionGeneration := session.info.Generation
	session.mu.RUnlock()
	m.mu.RLock()
	record := m.runtimes[runtimeID]
	current := m.sessions[sessionID] == session && record != nil && record.currentSession == sessionID && record.generation == sessionGeneration
	m.mu.RUnlock()
	return current && generation == sessionGeneration
}

func (s *Session) eventEnvelope() EventEnvelope {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return EventEnvelope{
		SessionID:  s.info.ID,
		RuntimeID:  s.info.RuntimeID,
		Generation: s.info.Generation,
		State:      runtimeStateForSession(s.info.State),
	}
}

// emitSession augments an existing payload without changing its legacy fields.
// New consumers can inspect the envelope; old consumers continue to read their
// existing sessionId/data/error fields unchanged.
func (m *Manager) emitSession(event string, session *Session, payload map[string]any) {
	if payload == nil {
		payload = make(map[string]any)
	}
	if session != nil {
		for key, value := range session.eventEnvelope().Fields() {
			payload[key] = value
		}
	}
	if m.emit != nil {
		m.emit(event, payload)
	}
}
