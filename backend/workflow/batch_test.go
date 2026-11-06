package workflow

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"gxShell/backend/ai"
)

func batchTargets() []BatchTarget {
	return []BatchTarget{{SessionID: "host-a", ProfileID: "a", Target: "Host A"}, {SessionID: "host-b", ProfileID: "b", Target: "Host B"}, {SessionID: "host-c", ProfileID: "c", Target: "Host C"}}
}

func TestBatchConcurrencyContextIsolationAndHistory(t *testing.T) {
	entered, release := make(chan string, 3), make(chan struct{})
	var mu sync.Mutex
	active, maximum := 0, 0
	m, err := NewManager(t.TempDir(), func(ctx context.Context, session string, query Query) Evidence {
		if query.Check == "system" {
			mu.Lock()
			active++
			if active > maximum {
				maximum = active
			}
			mu.Unlock()
			entered <- session
			select {
			case <-release:
			case <-ctx.Done():
			}
			mu.Lock()
			active--
			mu.Unlock()
		}
		return Evidence{Status: "collected", Output: "source=" + session + " example"}
	}, func(_ context.Context, cfg ai.Config, req ai.ChatRequest, emit func(ai.ChatResponse)) error {
		if cfg.Model != "original" {
			t.Error("batch model configuration changed")
		}
		sources := 0
		for _, target := range batchTargets() {
			if strings.Contains(req.Messages[0].Content, "source="+target.SessionID) {
				sources++
			}
		}
		if sources != 1 {
			t.Errorf("cross-host model context: %d sources", sources)
		}
		emit(submission(testReportJSON("en", Checks)))
		return nil
	}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	started, err := m.StartBatch(context.Background(), batchTargets(), "en", ai.Config{Model: "original"}, 2)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("parallel workers did not start")
		}
	}
	select {
	case <-entered:
		t.Fatal("concurrency limit exceeded")
	case <-time.After(25 * time.Millisecond):
	}
	current, _ := m.GetBatch(started.ID)
	queued := 0
	for _, run := range current.Runs {
		if run.State == "queued" {
			queued++
		}
	}
	if queued != 1 {
		t.Fatalf("expected one queued worker: %+v", current)
	}
	close(release)
	for _, run := range started.Runs {
		if finished := awaitRun(t, m, run.ID); finished.State != "completed" {
			t.Fatalf("host %s did not complete: state=%s error=%s", finished.Target, finished.State, finished.Error)
		}
	}
	current, _ = m.GetBatch(started.ID)
	mu.Lock()
	gotMax := maximum
	mu.Unlock()
	if gotMax != 2 || current.Completed != 3 || current.PromptTokens != 36 || current.CompletionTokens != 12 {
		t.Fatalf("batch summary/concurrency: %+v max=%d", current, gotMax)
	}
	reopened, err := NewManager(m.dir, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if got := reopened.ListBatches(); len(got) != 1 || got[0].ID != started.ID || got[0].Completed != 3 {
		t.Fatalf("batch history lost: %+v", got)
	}
}

func TestBatchCancellationIncludesQueuedWorkers(t *testing.T) {
	entered := make(chan string, 3)
	m, _ := NewManager(t.TempDir(), func(ctx context.Context, session string, _ Query) Evidence {
		entered <- session
		<-ctx.Done()
		return Evidence{Status: "unavailable"}
	}, func(context.Context, ai.Config, ai.ChatRequest, func(ai.ChatResponse)) error {
		t.Error("cancelled batch reached model")
		return nil
	}, nil, nil)
	defer m.Close()
	started, err := m.StartBatch(context.Background(), batchTargets(), "en", ai.Config{Model: "test"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("worker did not start")
	}
	current, _ := m.GetBatch(started.ID)
	queuedID := ""
	for _, run := range current.Runs {
		if run.State == "queued" {
			queuedID = run.ID
			break
		}
	}
	if !m.Cancel(queuedID) || awaitRun(t, m, queuedID).State != "cancelled" {
		t.Fatal("cannot cancel queued member independently")
	}
	if !m.CancelBatch(started.ID) {
		t.Fatal("cannot cancel batch")
	}
	for _, run := range started.Runs {
		if awaitRun(t, m, run.ID).State != "cancelled" {
			t.Fatal("batch cancellation missed a worker")
		}
	}
	select {
	case <-entered:
		t.Fatal("cancelled queue executed a query")
	default:
	}
}

func TestBatchFailureDoesNotStopOtherHosts(t *testing.T) {
	m, _ := NewManager(t.TempDir(), func(_ context.Context, session string, _ Query) Evidence {
		return Evidence{Status: "collected", Output: session}
	}, func(_ context.Context, _ ai.Config, req ai.ChatRequest, emit func(ai.ChatResponse)) error {
		if strings.Contains(req.Messages[0].Content, "host-b") {
			return fmt.Errorf("model failed for host b")
		}
		emit(submission(testReportJSON("en", Checks)))
		return nil
	}, nil, nil)
	defer m.Close()
	batch, err := m.StartBatch(context.Background(), batchTargets(), "en", ai.Config{Model: "test"}, 3)
	if err != nil {
		t.Fatal(err)
	}
	for _, run := range batch.Runs {
		awaitRun(t, m, run.ID)
	}
	got, _ := m.GetBatch(batch.ID)
	if got.State != "partial" || got.Completed != 2 || len(got.Runs[1].Evidence) != 7 {
		for _, run := range got.Runs {
			t.Logf("host=%s state=%s evidence=%d error=%s", run.Target, run.State, len(run.Evidence), run.Error)
		}
		t.Fatalf("batch state=%s completed=%d, want partial/2", got.State, got.Completed)
	}
}

func TestBatchReservationRejectsBusyAndDuplicateTargets(t *testing.T) {
	m, _ := NewManager(t.TempDir(), nil, nil, nil, nil)
	defer m.Close()
	m.runs["busy"] = &Run{ProfileID: "b"}
	m.active["busy"] = func() {}
	if _, err := m.StartBatch(context.Background(), batchTargets(), "en", ai.Config{Model: "test"}, 2); err == nil {
		t.Fatal("busy target accepted")
	}
	if len(m.runs) != 1 {
		t.Fatal("failed reservation created partial batch")
	}
	delete(m.active, "busy")
	duplicate := batchTargets()
	duplicate[1].ProfileID = duplicate[0].ProfileID
	if _, err := m.StartBatch(context.Background(), duplicate, "en", ai.Config{Model: "test"}, 2); err == nil {
		t.Fatal("duplicate host accepted")
	}
}

func TestBatchReplacedSessionIsNeverQueried(t *testing.T) {
	m, _ := NewManager(t.TempDir(), func(context.Context, string, Query) Evidence {
		t.Error("replaced session executed a query")
		return Evidence{}
	}, nil, nil, nil, func(string, uint64) error { return fmt.Errorf("session was replaced") })
	defer m.Close()
	targets := batchTargets()
	for i := range targets {
		targets[i].Generation = 1
	}
	batch, err := m.StartBatch(context.Background(), targets, "en", ai.Config{Model: "test"}, 2)
	if err != nil {
		t.Fatal(err)
	}
	for _, run := range batch.Runs {
		got := awaitRun(t, m, run.ID)
		if got.State == "completed" || len(got.Evidence) != 0 {
			t.Fatal("replaced transport was used")
		}
	}
}

func TestBatchQueueWaitDoesNotConsumeExecutionDeadline(t *testing.T) {
	entered, release := make(chan string, 1), make(chan struct{})
	secondDeadline := make(chan time.Time, 1)
	firstWorker := ""
	m, _ := NewManager(t.TempDir(), func(ctx context.Context, session string, query Query) Evidence {
		if query.Check == "system" && firstWorker == "" {
			firstWorker = session
			entered <- session
			<-release
		} else if query.Check == "system" {
			deadline, _ := ctx.Deadline()
			secondDeadline <- deadline
		}
		return Evidence{Status: "collected", Output: "example"}
	}, func(_ context.Context, _ ai.Config, _ ai.ChatRequest, emit func(ai.ChatResponse)) error {
		emit(submission(testReportJSON("en", Checks)))
		return nil
	}, nil, nil)
	defer m.Close()
	m.timeout = time.Second
	batch, err := m.StartBatch(context.Background(), batchTargets()[:2], "en", ai.Config{Model: "test"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	var blocked string
	select {
	case blocked = <-entered:
	case <-time.After(time.Second):
		t.Fatal("worker did not start")
	}
	time.Sleep(1100 * time.Millisecond)
	releasedAt := time.Now()
	close(release)
	for _, run := range batch.Runs {
		finished := awaitRun(t, m, run.ID)
		if finished.SessionID != blocked && !finished.StartedAt.After(releasedAt) {
			t.Fatal("queued worker started its budget before it acquired a slot")
		}
	}
	select {
	case deadline := <-secondDeadline:
		if !deadline.After(releasedAt) {
			t.Fatal("queue consumed execution deadline")
		}
	default:
		t.Fatal("queued worker did not receive a fresh execution context")
	}
}

func TestEmptyBatchIDCannotCancelIndividualInspections(t *testing.T) {
	m, _ := NewManager(t.TempDir(), nil, nil, nil, nil)
	cancelled := false
	m.runs["single"] = &Run{ID: "single"}
	m.active["single"] = func() { cancelled = true }
	if m.CancelBatch("") || cancelled {
		t.Fatal("empty batch ID cancelled unrelated inspections")
	}
	if _, err := m.GetBatch(""); err == nil {
		t.Fatal("empty batch ID collected individual history")
	}
	m.Close()
}
