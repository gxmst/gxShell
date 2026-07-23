package termio

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestWriteQueuePreservesOrder(t *testing.T) {
	stop := make(chan struct{})
	defer close(stop)
	var mu sync.Mutex
	var writes []string
	done := make(chan struct{})
	q := NewWriteQueue(stop, 1024, func(data []byte) error {
		mu.Lock()
		writes = append(writes, string(data))
		if len(writes) == 3 {
			close(done)
		}
		mu.Unlock()
		return nil
	}, nil)

	for _, value := range []string{"a", "b", "c"} {
		if err := q.Enqueue([]byte(value)); err != nil {
			t.Fatalf("enqueue %q: %v", value, err)
		}
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for writes")
	}
	mu.Lock()
	defer mu.Unlock()
	if got := writes[0] + writes[1] + writes[2]; got != "abc" {
		t.Fatalf("writes out of order: %q", got)
	}
}

func TestWriteQueueRejectsBytesBeyondLimit(t *testing.T) {
	stop := make(chan struct{})
	block := make(chan struct{})
	defer func() { close(block); close(stop) }()
	q := NewWriteQueue(stop, 4, func(data []byte) error {
		<-block
		return nil
	}, nil)
	if err := q.Enqueue([]byte("1234")); err != nil {
		t.Fatalf("first enqueue: %v", err)
	}
	if err := q.Enqueue([]byte("5")); !errors.Is(err, ErrWriteQueueFull) {
		t.Fatalf("got %v, want ErrWriteQueueFull", err)
	}
}

func TestWriteQueueReportsWriterError(t *testing.T) {
	stop := make(chan struct{})
	defer close(stop)
	want := errors.New("write failed")
	reported := make(chan error, 1)
	q := NewWriteQueue(stop, 1024, func([]byte) error { return want }, func(err error) { reported <- err })
	if err := q.Enqueue([]byte("x")); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	select {
	case got := <-reported:
		if !errors.Is(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("writer error was not reported")
	}
}
