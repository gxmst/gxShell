package main

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The CLI approval gate coalesces concurrent exec requests for the same server
// into a single native confirmation dialog within a short window, so a burst of
// commands does not spam the user with one dialog each. These tests exercise the
// batching logic through the injectable seams (cliApprovalDelay + the batch
// confirm function) rather than the real GUI dialog.

// TestCliApprovalBatchCoalescesConcurrentRequests fires several concurrent
// confirmCliExecution calls for the same server and asserts they are confirmed
// by a single batch call, and that every caller observes the batch's decision.
func TestCliApprovalBatchCoalescesConcurrentRequests(t *testing.T) {
	app := NewApp()
	app.ctx = context.Background()
	app.cliApprovalDelay = 40 * time.Millisecond

	var batchCalls int32
	var seenCommands int32
	app.cliConfirmBatchFn = func(serverName string, commands []string) bool {
		atomic.AddInt32(&batchCalls, 1)
		atomic.AddInt32(&seenCommands, int32(len(commands)))
		return true
	}

	const n = 8
	var wg sync.WaitGroup
	results := make([]bool, n)
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(idx int) {
			defer wg.Done()
			results[idx] = app.confirmCliExecution("prod-web", "uptime")
		}(i)
	}
	wg.Wait()

	if got := atomic.LoadInt32(&batchCalls); got != 1 {
		t.Fatalf("batch confirm called %d times, want exactly 1 (requests should coalesce)", got)
	}
	if got := atomic.LoadInt32(&seenCommands); got != n {
		t.Fatalf("batch saw %d commands, want %d", got, n)
	}
	for i, ok := range results {
		if !ok {
			t.Fatalf("request %d did not receive the batch approval", i)
		}
	}
}

// TestCliApprovalBatchDecisionPropagatesToAll ensures a denied batch denies
// every waiter, not just the leader.
func TestCliApprovalBatchDecisionPropagatesToAll(t *testing.T) {
	app := NewApp()
	app.ctx = context.Background()
	app.cliApprovalDelay = 40 * time.Millisecond
	app.cliConfirmBatchFn = func(serverName string, commands []string) bool {
		return false
	}

	const n = 5
	var wg sync.WaitGroup
	results := make([]bool, n)
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(idx int) {
			defer wg.Done()
			results[idx] = app.confirmCliExecution("prod-web", "systemctl restart nginx")
		}(i)
	}
	wg.Wait()

	for i, ok := range results {
		if ok {
			t.Fatalf("request %d was approved despite a denied batch", i)
		}
	}
}

// TestCliApprovalSeparateServersDoNotShareBatch ensures requests to different
// servers are batched independently: each server gets its own confirmation.
func TestCliApprovalSeparateServersDoNotShareBatch(t *testing.T) {
	app := NewApp()
	app.ctx = context.Background()
	app.cliApprovalDelay = 40 * time.Millisecond

	var mu sync.Mutex
	seenServers := map[string]int{}
	app.cliConfirmBatchFn = func(serverName string, commands []string) bool {
		mu.Lock()
		seenServers[serverName]++
		mu.Unlock()
		return true
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); app.confirmCliExecution("prod-web", "uptime") }()
	go func() { defer wg.Done(); app.confirmCliExecution("dev-box", "uptime") }()
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if len(seenServers) != 2 {
		t.Fatalf("expected 2 distinct server batches, got %#v", seenServers)
	}
	for server, count := range seenServers {
		if count != 1 {
			t.Fatalf("server %q confirmed %d times, want 1", server, count)
		}
	}
}

// TestCliApprovalKeyIsCaseInsensitive ensures the batch key folds case, so
// "Prod-Web" and "prod-web" coalesce into one dialog rather than two.
func TestCliApprovalKeyIsCaseInsensitive(t *testing.T) {
	app := NewApp()
	app.ctx = context.Background()
	app.cliApprovalDelay = 40 * time.Millisecond

	var batchCalls int32
	app.cliConfirmBatchFn = func(serverName string, commands []string) bool {
		atomic.AddInt32(&batchCalls, 1)
		return true
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); app.confirmCliExecution("prod-web", "uptime") }()
	go func() { defer wg.Done(); app.confirmCliExecution("PROD-WEB", "uptime") }()
	wg.Wait()

	if got := atomic.LoadInt32(&batchCalls); got != 1 {
		t.Fatalf("case-differing server names produced %d batches, want 1", got)
	}
}

// TestCliApprovalSequentialBatchesReopen ensures that after one batch flushes, a
// later request opens a fresh batch (the map entry is cleared, not leaked).
func TestCliApprovalSequentialBatchesReopen(t *testing.T) {
	app := NewApp()
	app.ctx = context.Background()
	app.cliApprovalDelay = 20 * time.Millisecond

	var batchCalls int32
	app.cliConfirmBatchFn = func(serverName string, commands []string) bool {
		atomic.AddInt32(&batchCalls, 1)
		return true
	}

	if !app.confirmCliExecution("prod-web", "uptime") {
		t.Fatal("first request should be approved")
	}
	if !app.confirmCliExecution("prod-web", "uptime") {
		t.Fatal("second request should be approved")
	}

	if got := atomic.LoadInt32(&batchCalls); got != 2 {
		t.Fatalf("sequential requests produced %d batches, want 2", got)
	}
}
