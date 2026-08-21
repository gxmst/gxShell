package sshmanager

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"gxShell/backend/types"
)

func TestRuntimeConnectReusesHealthySession(t *testing.T) {
	manager := NewManager("", nil, nil)
	session := &Session{info: types.SessionInfo{
		ID: "session-1", RuntimeID: "profile:test", Generation: 3,
		State: types.SessionConnected,
	}}
	manager.sessions[session.info.ID] = session
	manager.runtimes[session.info.RuntimeID] = &runtimeRecord{
		generation: 3, currentSession: session.info.ID, state: RuntimeActive, updatedAt: time.Now(),
	}

	info, call, owner := manager.beginRuntimeConnect(session.info.RuntimeID)
	if owner || call != nil || info.ID != session.info.ID {
		t.Fatalf("healthy session was not reused: info=%#v call=%#v owner=%v", info, call, owner)
	}
}

func TestRuntimeConnectFollowersReceiveOwnerResult(t *testing.T) {
	manager := NewManager("", nil, nil)
	_, ownerCall, owner := manager.beginRuntimeConnect("profile:test")
	if !owner {
		t.Fatal("first caller did not become owner")
	}
	_, followerCall, followerOwner := manager.beginRuntimeConnect("profile:test")
	if followerOwner || followerCall != ownerCall {
		t.Fatal("second caller did not join the in-flight connection")
	}

	wantInfo := types.SessionInfo{ID: "session-1", RuntimeID: "profile:test", Generation: 1}
	wantErr := errors.New("handshake failed")
	manager.finishRuntimeConnect("profile:test", ownerCall, wantInfo, wantErr)
	select {
	case <-followerCall.done:
		if followerCall.info.ID != wantInfo.ID || !errors.Is(followerCall.err, wantErr) {
			t.Fatalf("follower received the wrong result: %#v %v", followerCall.info, followerCall.err)
		}
	case <-time.After(time.Second):
		t.Fatal("follower was not released")
	}
}

func TestRuntimeRecordsAreBounded(t *testing.T) {
	manager := NewManager("", nil, nil)
	now := time.Now()
	for i := 0; i < maxRuntimeRecords+20; i++ {
		id := fmt.Sprintf("profile:%d", i)
		manager.runtimes[id] = &runtimeRecord{updatedAt: now.Add(time.Duration(i) * time.Second)}
	}
	manager.mu.Lock()
	manager.pruneRuntimeRecordsLocked(now.Add(time.Hour), "profile:keep")
	got := len(manager.runtimes)
	manager.mu.Unlock()
	if got >= maxRuntimeRecords {
		t.Fatalf("runtime registry was not pruned before insertion: %d", got)
	}
}

func TestRuntimeIDForProfileUsesStableProfileIdentity(t *testing.T) {
	profile := types.Profile{ID: "prod-web", Host: "example.com", Port: 22, Username: "root"}
	first := RuntimeIDForProfile(profile)
	profile.Host = "new.example.com"
	if second := RuntimeIDForProfile(profile); second != first {
		t.Fatalf("saved profile runtime id changed: %q != %q", second, first)
	}
}

func TestRuntimeGenerationFencesStaleSessionState(t *testing.T) {
	manager := NewManager("", nil, nil)
	runtimeID := "profile:test"
	firstGeneration := manager.reserveRuntime(runtimeID, "session-1")
	secondGeneration := manager.reserveRuntime(runtimeID, "session-2")
	if secondGeneration != firstGeneration+1 {
		t.Fatalf("generation did not increase: %d -> %d", firstGeneration, secondGeneration)
	}

	stale := &Session{info: types.SessionInfo{ID: "session-1", RuntimeID: runtimeID, Generation: firstGeneration}}
	manager.updateRuntimeState(stale, RuntimeError)
	snapshot, ok := manager.RuntimeSnapshot(runtimeID)
	if !ok {
		t.Fatal("runtime snapshot missing")
	}
	if snapshot.Generation != secondGeneration || snapshot.SessionID != "session-2" || snapshot.State != RuntimeConnecting {
		t.Fatalf("stale session changed current runtime: %#v", snapshot)
	}
}

func TestEmitSessionIncludesLegacyAndGenerationFields(t *testing.T) {
	var payload map[string]any
	manager := NewManager("", func(event string, data any) {
		if event == "terminal:data" {
			payload = data.(map[string]any)
		}
	}, nil)
	session := &Session{info: types.SessionInfo{ID: "session-1", RuntimeID: "profile:test", Generation: 4, State: types.SessionConnected}}
	manager.emitSession("terminal:data", session, map[string]any{"data": "hello"})
	if payload["sessionId"] != "session-1" || payload["runtimeId"] != "profile:test" || payload["generation"] != uint64(4) || payload["data"] != "hello" {
		t.Fatalf("unexpected event envelope: %#v", payload)
	}
}

func TestPanicHandlerKeepsEnvelopeAfterSessionLeavesManager(t *testing.T) {
	var payload map[string]any
	manager := NewManager("", func(event string, data any) {
		if event == "terminal:error" {
			payload, _ = data.(map[string]any)
		}
	}, nil)
	session := &Session{info: types.SessionInfo{
		ID: "session-gone", RuntimeID: "profile:test", Generation: 7,
		State: types.SessionConnected,
	}}
	func() {
		defer panicHandler(session, manager)
		panic("boom")
	}()
	if payload["sessionId"] != "session-gone" || payload["runtimeId"] != "profile:test" || payload["generation"] != uint64(7) {
		t.Fatalf("panic event lost its generation envelope: %#v", payload)
	}
}
