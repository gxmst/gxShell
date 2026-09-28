package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func requestWithID(id, body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/cli/exec", strings.NewReader(body))
	r.Header.Set("X-GxShell-Request-ID", id)
	return r
}

func TestCliRequestReplayAndConflict(t *testing.T) {
	a := &App{}
	calls := 0
	handler := a.deduplicateCliExec(func(w http.ResponseWriter, r *http.Request) {
		calls++
		writeCliJSON(w, http.StatusOK, map[string]string{"outcome": "succeeded"})
	})
	first, replay, conflict := httptest.NewRecorder(), httptest.NewRecorder(), httptest.NewRecorder()
	handler(first, requestWithID("deploy-1", `{"command":"deploy"}`))
	handler(replay, requestWithID("deploy-1", `{"command":"deploy"}`))
	handler(conflict, requestWithID("deploy-1", `{"command":"delete"}`))
	if calls != 1 || first.Body.String() != replay.Body.String() || replay.Header().Get("X-GxShell-Request-Replayed") != "true" || conflict.Code != http.StatusConflict {
		t.Fatalf("calls=%d first=%s replay=%s conflict=%d", calls, first.Body, replay.Body, conflict.Code)
	}
	// A fresh ID deliberately executes the same command again.
	handler(httptest.NewRecorder(), requestWithID("deploy-2", `{"command":"deploy"}`))
	if calls != 2 {
		t.Fatal("new ID did not execute")
	}
}

func TestCliConcurrentDuplicateCancellationDoesNotCancelOriginal(t *testing.T) {
	a := &App{}
	var calls atomic.Int32
	started, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	handler := a.deduplicateCliExec(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		close(started)
		<-release
		writeCliJSON(w, http.StatusOK, map[string]string{"outcome": "succeeded"})
	})
	go func() { defer close(finished); handler(httptest.NewRecorder(), requestWithID("same", "{}")) }()
	<-started
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	handler(httptest.NewRecorder(), requestWithID("same", "{}").WithContext(ctx))
	close(release)
	<-finished
	replay := httptest.NewRecorder()
	handler(replay, requestWithID("same", "{}"))
	if calls.Load() != 1 || replay.Header().Get("X-GxShell-Request-Replayed") != "true" {
		t.Fatal("duplicate executed")
	}
}

func TestCliRequestRetentionAndLargeResultTombstone(t *testing.T) {
	a := &App{}
	calls := 0
	handler := a.deduplicateCliExec(func(w http.ResponseWriter, r *http.Request) {
		calls++
		_, _ = w.Write([]byte(strings.Repeat("x", cliRequestResultLimit+1)))
	})
	handler(httptest.NewRecorder(), requestWithID("large", "{}"))
	replay := httptest.NewRecorder()
	handler(replay, requestWithID("large", "{}"))
	if calls != 1 || replay.Code != http.StatusConflict {
		t.Fatal("large response lost duplicate protection")
	}
	a.cliRequests.entries["large"].finished = time.Now().Add(-cliRequestRetention - time.Second)
	handler(httptest.NewRecorder(), requestWithID("large", "{}"))
	if calls != 2 {
		t.Fatal("expired entry was not pruned")
	}
}

func TestCliRequestRequiresAuthentication(t *testing.T) {
	a := &App{}
	calls := 0
	handler := a.requireCliAuth("secret-token", a.deduplicateCliExec(func(w http.ResponseWriter, r *http.Request) {
		calls++
		writeCliJSON(w, 200, map[string]bool{"ok": true})
	}))
	r := requestWithID("private", "{}")
	r.Header.Set("Authorization", "Bearer secret-token")
	handler(httptest.NewRecorder(), r)
	unauthorized := httptest.NewRecorder()
	handler(unauthorized, requestWithID("private", "{}"))
	if unauthorized.Code != http.StatusUnauthorized || calls != 1 {
		t.Fatal("unauthenticated cached response exposed")
	}
}
