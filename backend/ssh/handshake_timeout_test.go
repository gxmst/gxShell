package sshmanager

import (
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

// fakeConn records whether it was closed, and can refuse deadlines the way a
// connection handed back by a jump host does.
type fakeConn struct {
	mu            sync.Mutex
	closed        bool
	deadlineCalls int
	rejectsSets   bool
}

func (c *fakeConn) Read([]byte) (int, error)    { return 0, io.EOF }
func (c *fakeConn) Write(b []byte) (int, error) { return len(b), nil }

func (c *fakeConn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	return nil
}

func (c *fakeConn) LocalAddr() net.Addr  { return nil }
func (c *fakeConn) RemoteAddr() net.Addr { return nil }

func (c *fakeConn) SetDeadline(time.Time) error      { return c.noteDeadline() }
func (c *fakeConn) SetReadDeadline(time.Time) error  { return c.noteDeadline() }
func (c *fakeConn) SetWriteDeadline(time.Time) error { return c.noteDeadline() }

func (c *fakeConn) noteDeadline() error {
	c.mu.Lock()
	c.deadlineCalls++
	rejects := c.rejectsSets
	c.mu.Unlock()
	if rejects {
		return errors.New("deadline not supported")
	}
	return nil
}

func (c *fakeConn) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

// The connection a jump host returns reports "deadline not supported" from
// SetDeadline, and that error used to be discarded — leaving the target
// handshake behind a jump host with no timeout at all, so a peer that accepted
// the channel and then stayed silent blocked Connect forever.
func TestDeadlineConnClosesAConnectionThatCannotHoldADeadline(t *testing.T) {
	conn := &fakeConn{rejectsSets: true}
	guarded := withDeadline(conn)

	if err := guarded.SetDeadline(time.Now().Add(20 * time.Millisecond)); err == nil {
		t.Fatal("the underlying error should still be reported")
	}
	if conn.isClosed() {
		t.Fatal("the connection was closed before the deadline passed")
	}
	time.Sleep(120 * time.Millisecond)
	if !conn.isClosed() {
		t.Fatal("a silent peer was left connected past the deadline")
	}
	if !guarded.timedOut() {
		t.Fatal("the timeout was not recorded, so the error cannot say so")
	}
}

// Clearing the deadline has to disarm the timer, or a successful handshake
// would have its socket closed moments later.
func TestDeadlineConnStopsWhenTheDeadlineIsCleared(t *testing.T) {
	conn := &fakeConn{rejectsSets: true}
	guarded := withDeadline(conn)

	// The wrapper passes the underlying result through rather than swallowing
	// it, so this still reports "not supported" even though it now is.
	if err := guarded.SetDeadline(time.Now().Add(20 * time.Millisecond)); err == nil {
		t.Fatal("the underlying error should still be reported")
	}
	_ = guarded.SetDeadline(time.Time{})
	time.Sleep(120 * time.Millisecond)
	if conn.isClosed() {
		t.Fatal("the connection was closed after its deadline was cleared")
	}
	if guarded.timedOut() {
		t.Fatal("a cleared deadline was reported as a timeout")
	}
}

// The handshake timeout bounds a handshake that has stopped progressing on the
// network. Time the user spends reading a fingerprint prompt or typing a
// one-time code is not that, and charging it to the timeout made a slow user
// look exactly like an unreachable host.
func TestHandshakePauseSuspendsAndRestartsTheDeadline(t *testing.T) {
	conn := &fakeConn{}
	pause := &handshakePause{}
	pause.attach(conn, 50*time.Millisecond)

	// A prompt is on screen: the deadline must be cleared for its duration.
	resume := pause.prompt()
	if conn.isClosed() {
		t.Fatal("sanity: the fake connection starts open")
	}
	// Long past the original budget, but the user is still deciding.
	time.Sleep(120 * time.Millisecond)
	conn.mu.Lock()
	clearedWhilePrompting := conn.deadlineCalls
	conn.mu.Unlock()
	if clearedWhilePrompting == 0 {
		t.Fatal("the deadline was never cleared for the prompt")
	}

	// Answering re-arms the timeout from that moment.
	resume()
	time.Sleep(120 * time.Millisecond)
	conn.mu.Lock()
	calls := conn.deadlineCalls
	conn.mu.Unlock()
	if calls < 2 {
		t.Fatalf("the deadline was not re-armed after the prompt (%d calls)", calls)
	}
}

// A pause with no connection attached (a config built but never dialled) must
// not panic.
func TestHandshakePauseWithoutAConnectionIsInert(t *testing.T) {
	pause := &handshakePause{}
	resume := pause.prompt()
	resume()
	askUserYesNo(pause, func() bool { return true })
	if _, err := askUserAnswers(pause, func() ([]string, error) { return []string{"otp"}, nil }); err != nil {
		t.Fatal(err)
	}
}
