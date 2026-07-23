package termio

import (
	"errors"
	"sync/atomic"
)

// ErrWriteQueueFull is returned when terminal input is arriving faster than the
// underlying PTY can consume it. Keeping this queue bounded is important: a
// stalled remote can otherwise accumulate one Wails call and one goroutine per
// key press until the whole app becomes unresponsive.
var ErrWriteQueueFull = errors.New("terminal input queue is full (the session may be unresponsive)")

// WriteQueue serializes terminal input through one writer goroutine. It bounds
// both queued messages and queued bytes, while Disconnect remains free to close
// the underlying PTY/transport and unblock a stalled Write call.
type WriteQueue struct {
	stop       <-chan struct{}
	queue      chan []byte
	maxPending int64
	pending    atomic.Int64
	write      func([]byte) error
	onError    func(error)
	closed     atomic.Bool
}

// NewWriteQueue starts a bounded single-writer queue. maxPending is measured in
// bytes; non-positive values use a conservative 1 MiB default.
func NewWriteQueue(stop <-chan struct{}, maxPending int64, write func([]byte) error, onError func(error)) *WriteQueue {
	if maxPending <= 0 {
		maxPending = 1024 * 1024
	}
	q := &WriteQueue{
		stop:       stop,
		queue:      make(chan []byte, 256),
		maxPending: maxPending,
		write:      write,
		onError:    onError,
	}
	go q.run()
	return q
}

// Enqueue copies data before returning so callers may safely reuse their
// buffer. It is deliberately non-blocking: once the bounded queue is full the
// UI receives an actionable error instead of silently growing memory.
func (q *WriteQueue) Enqueue(data []byte) error {
	if len(data) == 0 {
		return nil
	}
	if q.closed.Load() {
		return errors.New("terminal input queue is closed")
	}
	n := int64(len(data))
	for {
		current := q.pending.Load()
		if n > q.maxPending || current > q.maxPending-n {
			return ErrWriteQueueFull
		}
		if q.pending.CompareAndSwap(current, current+n) {
			break
		}
	}

	copyOfData := append([]byte(nil), data...)
	select {
	case <-q.stop:
		q.pending.Add(-n)
		q.closed.Store(true)
		return errors.New("terminal session is closed")
	case q.queue <- copyOfData:
		return nil
	default:
		q.pending.Add(-n)
		return ErrWriteQueueFull
	}
}

func (q *WriteQueue) run() {
	defer q.closed.Store(true)
	for {
		select {
		case <-q.stop:
			return
		case data := <-q.queue:
			err := q.write(data)
			q.pending.Add(-int64(len(data)))
			if err != nil {
				select {
				case <-q.stop:
					return
				default:
				}
				if q.onError != nil {
					q.onError(err)
				}
				return
			}
		}
	}
}
