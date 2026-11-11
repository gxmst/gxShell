package sftpmanager

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pkg/sftp"
)

// Queue server replies for a fixed latency without serializing that latency
// across replies. This models requests in flight, rather than a slow disk.
type delayedTransferReply struct {
	data   []byte
	ready  time.Time
	status bool
}
type delayedTransferConn struct {
	net.Conn
	delay        time.Duration
	queue        chan delayedTransferReply
	done         chan struct{}
	stop         sync.Once
	statuses     atomic.Int64
	peakStatuses atomic.Int64
}

func newDelayedTransferConn(conn net.Conn, delay time.Duration) *delayedTransferConn {
	c := &delayedTransferConn{Conn: conn, delay: delay, queue: make(chan delayedTransferReply, 1024), done: make(chan struct{})}
	go func() {
		for {
			select {
			case <-c.done:
				return
			case reply := <-c.queue:
				timer := time.NewTimer(max(time.Until(reply.ready), 0))
				select {
				case <-c.done:
					timer.Stop()
					return
				case <-timer.C:
				}
				if _, err := c.Conn.Write(reply.data); err != nil {
					_ = c.Close()
					return
				}
				if reply.status {
					c.statuses.Add(-1)
				}
			}
		}
	}()
	return c
}
func (c *delayedTransferConn) Write(data []byte) (int, error) {
	status := len(data) > 4 && data[4] == 101 // SSH_FXP_STATUS response
	if status {
		n := c.statuses.Add(1)
		for peak := c.peakStatuses.Load(); n > peak; peak = c.peakStatuses.Load() {
			if c.peakStatuses.CompareAndSwap(peak, n) {
				break
			}
		}
	}
	select {
	case <-c.done:
		return 0, net.ErrClosed
	case c.queue <- delayedTransferReply{bytes.Clone(data), time.Now().Add(c.delay), status}:
		return len(data), nil
	}
}
func (c *delayedTransferConn) Close() error {
	c.stop.Do(func() { close(c.done); _ = c.Conn.Close() })
	return nil
}

func newLatencyTransferManager(t testing.TB, handlers sftp.Handlers, latency time.Duration) (*Manager, *sftp.Client, *delayedTransferConn) {
	t.Helper()
	serverConn, clientConn := net.Pipe()
	_ = serverConn.SetDeadline(time.Now().Add(30 * time.Second))
	_ = clientConn.SetDeadline(time.Now().Add(30 * time.Second))
	delayed := newDelayedTransferConn(serverConn, latency)
	server := sftp.NewRequestServer(delayed, handlers)
	finished := make(chan struct{})
	go func() { defer close(finished); _ = server.Serve() }()
	client, err := sftp.NewClientPipe(clientConn, clientConn)
	if err != nil {
		_ = delayed.Close()
		_ = clientConn.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close(); _ = server.Close(); <-finished })
	m := &Manager{cache: map[string]*cachedClient{"test": {client: client, lastCheck: time.Now(), lastUsed: time.Now()}}, emit: func(string, any) {}}
	return m, client, delayed
}

type uploadFailureTrace struct {
	active     atomic.Bool
	denyTrim   atomic.Bool
	failOffset int64
	highest    atomic.Int64
}
type failingUploadHandler struct {
	sftp.FileWriter
	trace *uploadFailureTrace
}

func (h failingUploadHandler) OpenFile(r *sftp.Request) (sftp.WriterAtReaderAt, error) {
	base, err := h.FileWriter.(sftp.OpenFileWriter).OpenFile(r)
	if err != nil {
		return nil, err
	}
	return failingUploadHandle{base, h.trace}, nil
}

func (h failingUploadHandler) Filewrite(r *sftp.Request) (io.WriterAt, error) {
	base, err := h.FileWriter.Filewrite(r)
	if err != nil {
		return nil, err
	}
	return failingUploadHandle{base, h.trace}, nil
}

type failingUploadHandle struct {
	io.WriterAt
	trace *uploadFailureTrace
}

func (h failingUploadHandle) WriteAt(data []byte, offset int64) (int, error) {
	if h.trace.active.Load() {
		for highest := h.trace.highest.Load(); offset > highest; highest = h.trace.highest.Load() {
			if h.trace.highest.CompareAndSwap(highest, offset) {
				break
			}
		}
		if offset == h.trace.failOffset {
			return 0, sftp.ErrSSHFxFailure
		}
	}
	return h.WriterAt.WriteAt(data, offset)
}
func (h failingUploadHandle) ReadAt(data []byte, offset int64) (int, error) {
	return h.WriterAt.(io.ReaderAt).ReadAt(data, offset)
}
func (h failingUploadHandle) Close() error {
	if closer, ok := h.WriterAt.(io.Closer); ok {
		return closer.Close()
	}
	return nil
}

type failingUploadCommands struct {
	sftp.FileCmder
	trace *uploadFailureTrace
}

func (c failingUploadCommands) Filecmd(r *sftp.Request) error {
	if c.trace.active.Load() && c.trace.denyTrim.Load() && r.Method == "Setstat" && r.AttrFlags().Size {
		return sftp.ErrSSHFxFailure
	}
	return c.FileCmder.Filecmd(r)
}

func TestUploadPipelinesAndSafelyRetriesFailedWrites(t *testing.T) {
	for _, denyTrim := range []bool{false, true} {
		t.Run(map[bool]string{false: "trim-confirmed-prefix", true: "untrimmed-hole"}[denyTrim], func(t *testing.T) {
			trace := &uploadFailureTrace{failOffset: minResumeBytes}
			trace.active.Store(true)
			trace.denyTrim.Store(denyTrim)
			handlers := sftp.InMemHandler()
			handlers.FilePut = failingUploadHandler{handlers.FilePut, trace}
			handlers.FileCmd = failingUploadCommands{handlers.FileCmd, trace}
			m, client, network := newLatencyTransferManager(t, handlers, 20*time.Millisecond)
			contents := bytes.Repeat([]byte("source-data"), 200000)
			source := filepath.Join(t.TempDir(), "package.bin")
			if err := os.WriteFile(source, contents, 0600); err != nil {
				t.Fatal(err)
			}
			var failedDone int64 = -1
			var resumed bool
			m.emit = func(_ string, payload any) {
				event, ok := payload.(map[string]any)
				if !ok {
					return
				}
				if event["status"] == "failed" {
					failedDone, _ = event["done"].(int64)
				}
				if event["status"] == "resumed" {
					resumed = true
				}
			}
			if err := m.UploadFileWithPolicy("test", source, "/package.bin", false); err == nil {
				t.Fatal("failed write reported success")
			}
			if network.peakStatuses.Load() < 4 || trace.highest.Load() <= trace.failOffset {
				t.Fatal("upload waited for each acknowledgement instead of pipelining")
			}
			if failedDone != trace.failOffset {
				t.Fatalf("reported read-ahead as confirmed bytes: %d", failedDone)
			}
			info, err := os.Stat(source)
			if err != nil {
				t.Fatal(err)
			}
			identity, err := localSourceIdentity(source)
			if err != nil {
				t.Fatal(err)
			}
			part := remotePartPath("/package.bin", resumeKey{source: identity, size: info.Size(), modTime: info.ModTime()})
			partInfo, err := client.Stat(part)
			if err != nil {
				t.Fatal(err)
			}
			if !denyTrim && partInfo.Size() != trace.failOffset {
				t.Fatalf("unconfirmed tail survived trim: %d", partInfo.Size())
			}
			if denyTrim && partInfo.Size() <= trace.failOffset {
				t.Fatal("test failed to retain a hole followed by later writes")
			}
			if _, err := client.Stat("/package.bin"); !os.IsNotExist(err) {
				t.Fatal("failed temporary upload was promoted")
			}
			trace.active.Store(false)
			if err := m.UploadFileWithPolicy("test", source, "/package.bin", false); err != nil {
				t.Fatal(err)
			}
			if resumed == denyTrim {
				t.Fatalf("resumed=%v with denyTrim=%v", resumed, denyTrim)
			}
			got := readTransferTestFile(t, client, "/package.bin")
			if sha256.Sum256(got) != sha256.Sum256(contents) {
				t.Fatal("retried upload corrupt or contains an unfilled hole")
			}
		})
	}
}

func TestVerifiedUploadUsesPipelineAndRejectsWrongHash(t *testing.T) {
	handlers := sftp.InMemHandler()
	m, client, network := newLatencyTransferManager(t, handlers, 10*time.Millisecond)
	contents := bytes.Repeat([]byte("verified-source"), 150000)
	source := filepath.Join(t.TempDir(), "package.bin")
	if err := os.WriteFile(source, contents, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(contents)
	if err := m.UploadFileWithPolicyVerified("test", source, "/verified.bin", false, hex.EncodeToString(digest[:])); err != nil {
		t.Fatal(err)
	}
	if network.peakStatuses.Load() < 4 {
		t.Fatal("hashing wrapper disabled upload pipelining")
	}
	if sha256.Sum256(readTransferTestFile(t, client, "/verified.bin")) != digest {
		t.Fatal("verified upload corrupt")
	}
	if err := m.UploadFileWithPolicyVerified("test", source, "/wrong.bin", false, hex.EncodeToString(make([]byte, 32))); err == nil {
		t.Fatal("wrong approval hash accepted")
	}
	// A local hash rejection may invalidate the cached client. Observe the
	// server filesystem independently rather than mistaking a closed connection
	// for evidence that a destination exists.
	if _, err := handlers.FileList.Filelist(sftp.NewRequest("Stat", "/wrong.bin")); !os.IsNotExist(err) {
		t.Fatal("wrong-hash upload promoted")
	}
}

func TestPipelinedUploadPauseResumeAndCancel(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		t.Run(map[bool]string{false: "resume", true: "cancel"}[cancel], func(t *testing.T) {
			m, client, _ := newLatencyTransferManager(t, sftp.InMemHandler(), 10*time.Millisecond)
			contents := bytes.Repeat([]byte("pause-source"), 50000)
			source := filepath.Join(t.TempDir(), "package.bin")
			if err := os.WriteFile(source, contents, 0600); err != nil {
				t.Fatal(err)
			}
			paused := make(chan string, 1)
			var once sync.Once
			m.emit = func(_ string, payload any) {
				event, ok := payload.(map[string]any)
				if !ok || event["status"] != "progress" {
					return
				}
				once.Do(func() {
					id, _ := event["jobId"].(string)
					if m.PauseTransfer(id) {
						paused <- id
					}
				})
			}
			result := make(chan error, 1)
			go func() { result <- m.UploadFileWithPolicy("test", source, "/package.bin", false) }()
			var id string
			select {
			case id = <-paused:
			case <-time.After(3 * time.Second):
				t.Fatal("upload did not pause")
			}
			if cancel {
				cancellation := make(chan bool, 1)
				go func() { cancellation <- m.CancelTransfer(id) }()
				select {
				case ok := <-cancellation:
					if !ok {
						t.Fatal("cancel rejected")
					}
				case <-time.After(3 * time.Second):
					t.Fatal("cancel blocked on upload pipeline")
				}
			} else if !m.ResumeTransfer(id) {
				t.Fatal("resume rejected")
			}
			select {
			case err := <-result:
				if (err != nil) != cancel {
					t.Fatalf("copy result: %v, cancel=%v", err, cancel)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("upload did not finish after resume/cancel")
			}
			if cancel {
				if _, err := client.Stat("/package.bin"); !os.IsNotExist(err) {
					t.Fatal("cancelled upload promoted")
				}
			} else if sha256.Sum256(readTransferTestFile(t, client, "/package.bin")) != sha256.Sum256(contents) {
				t.Fatal("resumed upload corrupt")
			}
		})
	}
}

func TestUploadPrefixVerificationObservesCancellation(t *testing.T) {
	_, client := newTransferTestManager(t, sftp.InMemHandler())
	contents := bytes.Repeat([]byte("prefix"), minResumeBytes)
	putTransferTestFile(t, client, "/partial", contents)
	file, err := client.OpenFile("/partial", os.O_RDWR)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := verifyUploadPrefix(&transferJob{ctx: ctx}, bytes.NewReader(contents), file, int64(len(contents))); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
}

func TestPipelinedUploadWriteFailureEndsPausedTransfer(t *testing.T) {
	trace := &uploadFailureTrace{failOffset: 0}
	trace.active.Store(true)
	handlers := sftp.InMemHandler()
	handlers.FilePut = failingUploadHandler{handlers.FilePut, trace}
	m, client, _ := newLatencyTransferManager(t, handlers, 20*time.Millisecond)
	source := filepath.Join(t.TempDir(), "source.bin")
	if err := os.WriteFile(source, bytes.Repeat([]byte("X"), 512*1024), 0600); err != nil {
		t.Fatal(err)
	}
	paused := make(chan string, 1)
	var once sync.Once
	m.emit = func(_ string, payload any) {
		event, ok := payload.(map[string]any)
		if !ok || event["status"] != "progress" {
			return
		}
		once.Do(func() {
			id, _ := event["jobId"].(string)
			if m.PauseTransfer(id) {
				paused <- id
			}
		})
	}
	result := make(chan error, 1)
	go func() { result <- m.UploadFileWithPolicy("test", source, "/target.bin", false) }()
	var id string
	select {
	case id = <-paused:
	case <-time.After(3 * time.Second):
		t.Fatal("upload did not pause")
	}
	select {
	case err := <-result:
		if err == nil || errors.Is(err, context.Canceled) {
			t.Fatalf("write failure was lost: %v", err)
		}
	case <-time.After(3 * time.Second):
		m.CancelTransfer(id)
		t.Fatal("write failure waited for manual resume")
	}
	if _, err := client.Stat("/target.bin"); !os.IsNotExist(err) {
		t.Fatal("failed upload was promoted")
	}
}

func BenchmarkUploadHighLatency(b *testing.B) {
	contents := bytes.Repeat([]byte("B"), 4*1024*1024)
	for _, concurrent := range []bool{false, true} {
		b.Run(map[bool]string{false: "sequential", true: "pipelined"}[concurrent], func(b *testing.B) {
			_, client, _ := newLatencyTransferManager(b, sftp.InMemHandler(), 50*time.Millisecond)
			file, err := client.Create("/upload.bin")
			if err != nil {
				b.Fatal(err)
			}
			defer file.Close()
			b.SetBytes(int64(len(contents)))
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				reader := &progressReader{ctx: context.Background(), r: bytes.NewReader(contents), fn: func(int64) {}}
				var n int64
				if concurrent {
					n, err = copyUpload(file, reader, int64(i*len(contents)), nil)
				} else {
					n, err = file.ReadFrom(reader)
				}
				if err != nil || n != int64(len(contents)) {
					b.Fatalf("copy failed: %d, %v", n, err)
				}
			}
			b.StopTimer()
		})
	}
}
