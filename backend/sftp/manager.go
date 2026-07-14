package sftpmanager

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"gxShell/backend/types"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type SSHClientProvider interface {
	Client(sessionID string) (*ssh.Client, error)
}

type cachedClient struct {
	client   *sftp.Client
	lastUsed time.Time
	// lastCheck is when the client last proved healthy (creation, or a Getwd
	// probe). The probe costs a full round trip, so acquire only re-probes
	// after healthCheckInterval instead of on every operation.
	lastCheck time.Time
	// refs counts in-flight operations holding this client. closing marks the
	// client as removed from the cache (evicted or invalidated); the underlying
	// handle is only Closed once the last in-flight operation releases it, so we
	// never close a client another goroutine is mid-transfer on.
	refs    int
	closing bool
}

type Manager struct {
	sessions SSHClientProvider
	emit     func(event string, data any)
	mu       sync.Mutex
	cache    map[string]*cachedClient
	// createMu serializes client creation per session so concurrent cache
	// misses don't each open a client and close one another's in-use handle.
	createMu map[string]*sync.Mutex

	transferMu sync.Mutex
	transfers  map[string]*transferJob
}

type transferJob struct {
	id        string
	sessionID string
	path      string
	direction string
	ctx       context.Context
	cancel    context.CancelFunc
	once      sync.Once
	cancelled atomic.Bool

	interruptMu sync.Mutex
	interrupt   func()
	interruptID uint64
}

const maxSFTPCache = 10

// healthCheckInterval bounds how often acquire spends a round trip probing a
// cached client. Between probes, a broken client surfaces through the
// operation's own error and invalidateOnConnErr.
const healthCheckInterval = 30 * time.Second

// progressEmitInterval throttles sftp:progress events. Emitting per 64KB chunk
// floods the IPC bridge (a 1GB transfer would be ~16k events) and slows the
// transfer itself.
const progressEmitInterval = 100 * time.Millisecond

func NewManager(sessions SSHClientProvider, emit func(event string, data any)) *Manager {
	m := &Manager{
		sessions:  sessions,
		emit:      emit,
		cache:     map[string]*cachedClient{},
		createMu:  map[string]*sync.Mutex{},
		transfers: map[string]*transferJob{},
	}
	go m.evictLoop()
	return m
}

// sessionCreateLock returns the per-session creation mutex, allocating it on
// first use.
func (m *Manager) sessionCreateLock(sessionID string) *sync.Mutex {
	m.mu.Lock()
	defer m.mu.Unlock()
	lock, ok := m.createMu[sessionID]
	if !ok {
		lock = &sync.Mutex{}
		m.createMu[sessionID] = lock
	}
	return lock
}

// acquire returns a healthy SFTP client for the session together with a release
// function the caller MUST invoke (defer) when done. The client is reference
// counted: eviction and invalidation only detach it from the cache; the actual
// Close happens when the last holder releases it, so an in-flight transfer is
// never cut off under it.
func (m *Manager) acquire(sessionID string) (*sftp.Client, func(), error) {
	// Fast path: a healthy cached client.
	m.mu.Lock()
	if cc, ok := m.cache[sessionID]; ok && !cc.closing {
		cc.lastUsed = time.Now()
		cc.refs++
		client := cc.client
		needProbe := time.Since(cc.lastCheck) > healthCheckInterval
		m.mu.Unlock()
		if needProbe {
			if _, err := client.Getwd(); err != nil {
				// Health check failed: detach it and retry via the slow path.
				m.release(sessionID, cc, true)
				return m.acquireSlow(sessionID)
			}
			m.mu.Lock()
			cc.lastCheck = time.Now()
			m.mu.Unlock()
		}
		return client, func() { m.release(sessionID, cc, false) }, nil
	}
	m.mu.Unlock()
	return m.acquireSlow(sessionID)
}

// acquireSlow opens a new client under the per-session creation lock.
func (m *Manager) acquireSlow(sessionID string) (*sftp.Client, func(), error) {
	createLock := m.sessionCreateLock(sessionID)
	createLock.Lock()
	defer createLock.Unlock()

	// Re-check: another goroutine may have created one while we waited.
	m.mu.Lock()
	if cc, ok := m.cache[sessionID]; ok && !cc.closing {
		cc.lastUsed = time.Now()
		cc.refs++
		client := cc.client
		m.mu.Unlock()
		return client, func() { m.release(sessionID, cc, false) }, nil
	}
	m.evictLRULocked()
	m.mu.Unlock()

	sshClient, err := m.sessions.Client(sessionID)
	if err != nil {
		return nil, nil, err
	}
	// Concurrent reads/writes pipeline multiple outstanding packets per
	// transfer instead of one 32KB request per round trip; on a high-latency
	// link this is the difference between ~1MB/s and saturating the pipe.
	client, err := sftp.NewClient(sshClient,
		sftp.UseConcurrentReads(true),
		sftp.UseConcurrentWrites(true),
	)
	if err != nil {
		return nil, nil, err
	}

	m.mu.Lock()
	cc := &cachedClient{client: client, lastUsed: time.Now(), lastCheck: time.Now(), refs: 1}
	m.cache[sessionID] = cc
	m.mu.Unlock()
	return client, func() { m.release(sessionID, cc, false) }, nil
}

// release drops one reference. If detach is true (or the entry was already
// detached) and no references remain, the underlying client is closed.
func (m *Manager) release(sessionID string, cc *cachedClient, detach bool) {
	m.mu.Lock()
	if detach && !cc.closing {
		// Detach from the cache so no new caller can acquire it.
		if cur, ok := m.cache[sessionID]; ok && cur == cc {
			delete(m.cache, sessionID)
		}
		cc.closing = true
	}
	if cc.refs > 0 {
		cc.refs--
	}
	shouldClose := cc.closing && cc.refs == 0
	m.mu.Unlock()
	if shouldClose {
		_ = cc.client.Close()
	}
}

// evictLRULocked removes the least-recently-used entry when the cache is full.
// Must hold m.mu. The evicted client is detached and closed lazily by release.
func (m *Manager) evictLRULocked() {
	if len(m.cache) < maxSFTPCache {
		return
	}
	var oldestID string
	var oldest *cachedClient
	for id, cc := range m.cache {
		if oldest == nil || cc.lastUsed.Before(oldest.lastUsed) {
			oldestID = id
			oldest = cc
		}
	}
	if oldest != nil {
		oldest.closing = true
		delete(m.cache, oldestID)
		if oldest.refs == 0 {
			_ = oldest.client.Close()
		}
	}
}

// InvalidateClient detaches a session's client from the cache. The handle is
// closed once any in-flight operations release it.
func (m *Manager) InvalidateClient(sessionID string) {
	m.mu.Lock()
	cc, ok := m.cache[sessionID]
	if ok {
		cc.closing = true
		delete(m.cache, sessionID)
	}
	shouldClose := ok && cc.refs == 0
	m.mu.Unlock()
	if shouldClose {
		_ = cc.client.Close()
	}
}

func (m *Manager) evictLoop() {
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		m.mu.Lock()
		now := time.Now()
		for id, cc := range m.cache {
			if now.Sub(cc.lastUsed) > 5*time.Minute {
				cc.closing = true
				delete(m.cache, id)
				if cc.refs == 0 {
					_ = cc.client.Close()
				}
			}
		}
		m.mu.Unlock()
	}
}

// beginTransfer registers an in-flight transfer before any filesystem or
// network work starts. Every registered job is paired with exactly one
// terminal event by finishTransfer, including failures that happen before the
// first byte is copied.
func (m *Manager) beginTransfer(sessionID, transferPath, direction string) *transferJob {
	ctx, cancel := context.WithCancel(context.Background())
	job := &transferJob{
		id:        fmt.Sprintf("%x-%s", time.Now().UnixNano(), randomSuffix()),
		sessionID: sessionID,
		path:      transferPath,
		direction: direction,
		ctx:       ctx,
		cancel:    cancel,
	}
	m.transferMu.Lock()
	if m.transfers == nil {
		m.transfers = make(map[string]*transferJob)
	}
	m.transfers[job.id] = job
	m.transferMu.Unlock()
	m.emitTransfer(job, "started", 0, 0, nil)
	return job
}

func (m *Manager) emitTransfer(job *transferJob, status string, done, total int64, err error) {
	if m.emit == nil {
		return
	}
	event := map[string]any{
		"jobId":     job.id,
		"sessionId": job.sessionID,
		"path":      job.path,
		"done":      done,
		"total":     total,
		"direction": job.direction,
		"status":    status,
	}
	if status == "succeeded" || status == "failed" || status == "cancelled" {
		// Keep finished for compatibility with older frontend builds while the
		// richer status field carries the actual terminal outcome.
		event["finished"] = true
	}
	if err != nil {
		event["error"] = err.Error()
	}
	m.emit("sftp:progress", event)
}

func (m *Manager) finishTransfer(job *transferJob, err error, done, total int64) {
	job.once.Do(func() {
		job.cancel()
		job.interruptMu.Lock()
		job.interrupt = nil
		job.interruptMu.Unlock()

		status := "succeeded"
		if err != nil {
			if job.cancelled.Load() || errors.Is(err, context.Canceled) {
				status = "cancelled"
			} else {
				status = "failed"
			}
		}
		m.transferMu.Lock()
		delete(m.transfers, job.id)
		m.transferMu.Unlock()
		m.emitTransfer(job, status, done, total, err)
	})
}

// CancelTransfer requests cancellation of an active job. Closing the current
// file handles unblocks most pending SFTP reads/writes; the context check in
// the copy pipeline covers the normal path without tearing down the shared
// cached SFTP client or disrupting unrelated transfers.
func (m *Manager) CancelTransfer(jobID string) bool {
	m.transferMu.Lock()
	job, ok := m.transfers[jobID]
	if ok {
		job.cancelled.Store(true)
		job.cancel()
	}
	m.transferMu.Unlock()
	if !ok {
		return false
	}
	job.interruptMu.Lock()
	interrupt := job.interrupt
	job.interruptMu.Unlock()
	if interrupt != nil {
		interrupt()
	}
	return true
}

// setInterrupt installs the operation that can unblock the job's current copy
// call. The returned cleanup only clears the same generation, so a completed
// file in a folder transfer cannot erase the next file's interrupt handler.
func (j *transferJob) setInterrupt(interrupt func()) func() {
	j.interruptMu.Lock()
	j.interruptID++
	id := j.interruptID
	j.interrupt = interrupt
	alreadyCancelled := j.cancelled.Load()
	j.interruptMu.Unlock()
	if alreadyCancelled && interrupt != nil {
		interrupt()
	}
	return func() {
		j.interruptMu.Lock()
		if j.interruptID == id {
			j.interrupt = nil
		}
		j.interruptMu.Unlock()
	}
}

func checkTransferContext(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	select {
	case <-ctx.Done():
		return context.Canceled
	default:
		return nil
	}
}

func (m *Manager) ListRemoteDir(sessionID string, remotePath string) ([]types.RemoteFile, error) {
	if remotePath == "" {
		remotePath = "."
	}
	remotePath = cleanRemotePath(remotePath)
	client, release, err := m.acquire(sessionID)
	if err != nil {
		return nil, err
	}
	defer release()
	entries, err := client.ReadDir(remotePath)
	if err != nil {
		m.invalidateOnConnErr(sessionID, err)
		return nil, err
	}
	files := make([]types.RemoteFile, 0, len(entries))
	for _, entry := range entries {
		files = append(files, types.RemoteFile{
			Name:        entry.Name(),
			Path:        path.Join(remotePath, entry.Name()),
			Size:        entry.Size(),
			IsDir:       entry.IsDir(),
			Mode:        entry.Mode().String(),
			ModTime:     entry.ModTime(),
			Permissions: entry.Mode().Perm().String(),
		})
	}
	sort.SliceStable(files, func(i, j int) bool {
		if files[i].IsDir != files[j].IsDir {
			return files[i].IsDir
		}
		return files[i].Name < files[j].Name
	})
	return files, nil
}

func (m *Manager) UploadFile(sessionID, localPath, remotePath string) (err error) {
	remotePath = cleanRemotePath(remotePath)
	job := m.beginTransfer(sessionID, remotePath, "upload")
	var done, totalSize int64
	defer func() {
		m.finishTransfer(job, err, done, totalSize)
		if !job.cancelled.Load() {
			m.invalidateOnTransferErr(sessionID, err)
		}
	}()

	src, err := os.Open(localPath)
	if err != nil {
		return err
	}
	srcClosed := false
	defer func() {
		if !srcClosed {
			_ = src.Close()
		}
	}()
	stat, statErr := src.Stat()
	if statErr == nil {
		totalSize = stat.Size()
	}

	client, release, err := m.acquire(sessionID)
	if err != nil {
		return err
	}
	defer release()

	tmpPath := remotePath + ".gxshell-" + job.id + ".part"
	dst, err := client.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return err
	}
	dstClosed := false
	defer func() {
		if !dstClosed {
			_ = dst.Close()
		}
		if err != nil {
			_ = client.Remove(tmpPath)
		}
	}()
	clearInterrupt := job.setInterrupt(func() {
		_ = src.Close()
		_ = dst.Close()
	})
	defer clearInterrupt()

	progress := throttled(func(n int64) {
		m.emitTransfer(job, "progress", n, totalSize, nil)
	})
	// ReadFrom lets the sftp client pipeline concurrent write packets (see
	// acquireSlow); a manual read/write loop would fall back to one packet per
	// round trip.
	done, err = dst.ReadFrom(&progressReader{ctx: job.ctx, r: src, fn: progress})
	closeErr := dst.Close()
	dstClosed = true
	if err == nil && closeErr != nil {
		err = closeErr
	}
	closeErr = src.Close()
	srcClosed = true
	if err == nil && closeErr != nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = checkTransferContext(job.ctx); err != nil {
		return err
	}
	if err = replaceRemoteTemp(client, tmpPath, remotePath); err != nil {
		return err
	}
	return nil
}

func (m *Manager) DownloadFile(sessionID, remotePath, localPath string) (err error) {
	remotePath = cleanRemotePath(remotePath)
	job := m.beginTransfer(sessionID, remotePath, "download")
	var done, totalSize int64
	defer func() {
		m.finishTransfer(job, err, done, totalSize)
		if !job.cancelled.Load() {
			m.invalidateOnTransferErr(sessionID, err)
		}
	}()

	client, release, err := m.acquire(sessionID)
	if err != nil {
		return err
	}
	defer release()

	src, err := client.Open(remotePath)
	if err != nil {
		return err
	}
	srcClosed := false
	defer func() {
		if !srcClosed {
			_ = src.Close()
		}
	}()
	stat, statErr := src.Stat()
	if statErr == nil {
		totalSize = stat.Size()
	}

	partPath := transferPartPath(localPath, job.id)
	dst, err := os.OpenFile(partPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return err
	}
	dstClosed := false
	defer func() {
		if !dstClosed {
			_ = dst.Close()
		}
		if err != nil {
			_ = os.Remove(partPath)
		}
	}()
	clearInterrupt := job.setInterrupt(func() {
		_ = src.Close()
		_ = dst.Close()
	})
	defer clearInterrupt()

	progress := throttled(func(n int64) {
		m.emitTransfer(job, "progress", n, totalSize, nil)
	})
	// WriteTo lets the sftp client issue concurrent read-ahead requests.
	done, err = src.WriteTo(&progressWriter{ctx: job.ctx, w: dst, fn: progress})
	closeErr := dst.Close()
	dstClosed = true
	if err == nil && closeErr != nil {
		err = closeErr
	}
	closeErr = src.Close()
	srcClosed = true
	if err == nil && closeErr != nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = checkTransferContext(job.ctx); err != nil {
		return err
	}
	if err = replaceLocalTemp(partPath, localPath); err != nil {
		return err
	}
	return nil
}

func (m *Manager) ReadRemoteFile(sessionID string, remotePath string, maxSize int64) ([]byte, error) {
	remotePath = cleanRemotePath(remotePath)
	client, release, err := m.acquire(sessionID)
	if err != nil {
		return nil, err
	}
	defer release()

	src, err := client.Open(remotePath)
	if err != nil {
		m.invalidateOnConnErr(sessionID, err)
		return nil, err
	}
	defer src.Close()

	stat, err := src.Stat()
	if err != nil {
		m.invalidateOnConnErr(sessionID, err)
		return nil, err
	}
	if stat.IsDir() {
		return nil, fmt.Errorf("remote path is a directory, not a file")
	}
	if maxSize > 0 && stat.Size() > maxSize {
		return nil, fmt.Errorf("remote file too large")
	}

	limit := maxSize
	if limit <= 0 {
		limit = stat.Size()
	}
	data, err := io.ReadAll(io.LimitReader(src, limit+1))
	if err != nil {
		m.invalidateOnConnErr(sessionID, err)
		return nil, err
	}
	if maxSize > 0 && int64(len(data)) > maxSize {
		return nil, fmt.Errorf("remote file too large")
	}
	return data, nil
}

func (m *Manager) WriteRemoteFile(sessionID string, remotePath string, data []byte) error {
	remotePath = cleanRemotePath(remotePath)
	client, release, err := m.acquire(sessionID)
	if err != nil {
		return err
	}
	defer release()

	var mode os.FileMode
	if stat, statErr := client.Stat(remotePath); statErr == nil {
		if stat.IsDir() {
			return fmt.Errorf("remote path is a directory, not a file")
		}
		mode = stat.Mode().Perm()
	}

	// This is the remote editor's save path: write a sibling temp file and
	// rename it over the target. An in-place O_TRUNC write would destroy the
	// original if the connection drops mid-write.
	tmpPath := remotePath + ".gxshell-" + randomSuffix() + ".tmp"
	if err := writeRemoteFileAt(client, tmpPath, data, mode); err != nil {
		_ = client.Remove(tmpPath)
		if isPermissionErr(err) {
			// Directory not writable but the file itself may be (e.g. sticky
			// shared dirs): fall back to the old in-place write.
			if fallbackErr := writeRemoteFileAt(client, remotePath, data, mode); fallbackErr == nil {
				return nil
			}
		}
		m.invalidateOnConnErr(sessionID, err)
		return err
	}
	if err := client.PosixRename(tmpPath, remotePath); err != nil {
		// posix-rename@openssh.com may be unsupported. Plain SFTP Rename is a
		// safe fallback only when the server can complete it without deleting an
		// existing target. If it refuses to overwrite, preserve the original file
		// and report the save failure instead of removing remotePath first.
		if err2 := client.Rename(tmpPath, remotePath); err2 != nil {
			_ = client.Remove(tmpPath)
			m.invalidateOnConnErr(sessionID, err2)
			return fmt.Errorf("replace remote file: posix rename failed (%v); fallback rename failed without deleting original: %w", err, err2)
		}
	}
	return nil
}

func writeRemoteFileAt(client *sftp.Client, remotePath string, data []byte, mode os.FileMode) error {
	dst, err := client.OpenFile(remotePath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return err
	}
	_, writeErr := io.Copy(dst, bytes.NewReader(data))
	closeErr := dst.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	if mode != 0 {
		_ = client.Chmod(remotePath, mode)
	}
	return nil
}

// replaceRemoteTemp promotes a fully written sibling temp file without first
// deleting the destination. If the server cannot overwrite with plain Rename
// and does not support posix-rename, the existing file is left intact.
func replaceRemoteTemp(client *sftp.Client, tmpPath, remotePath string) error {
	if err := client.PosixRename(tmpPath, remotePath); err != nil {
		if fallbackErr := client.Rename(tmpPath, remotePath); fallbackErr != nil {
			return fmt.Errorf("replace remote file: posix rename failed (%v); fallback rename failed without deleting original: %w", err, fallbackErr)
		}
	}
	return nil
}

func transferPartPath(localPath, jobID string) string {
	return localPath + ".gxshell-" + jobID + ".part"
}

// replaceLocalTemp promotes a completed .part file. os.Rename is atomic when
// the platform supports replacing the destination. On platforms where it does
// not (notably Windows), move the old destination aside and restore it if the
// promotion fails, so a failed download never leaves a truncated target.
func replaceLocalTemp(tmpPath, localPath string) error {
	if err := os.Rename(tmpPath, localPath); err == nil {
		return nil
	} else if _, statErr := os.Stat(localPath); statErr != nil {
		return err
	}

	backupPath := localPath + ".gxshell-" + randomSuffix() + ".bak"
	if err := os.Rename(localPath, backupPath); err != nil {
		return fmt.Errorf("prepare existing download target: %w", err)
	}
	if err := os.Rename(tmpPath, localPath); err != nil {
		if restoreErr := os.Rename(backupPath, localPath); restoreErr != nil {
			return fmt.Errorf("promote completed download: %v; restore original: %w", err, restoreErr)
		}
		return fmt.Errorf("promote completed download: %w", err)
	}
	_ = os.Remove(backupPath)
	return nil
}

func (m *Manager) DeleteRemoteFile(sessionID, remotePath string) error {
	remotePath = cleanRemotePath(remotePath)
	client, release, err := m.acquire(sessionID)
	if err != nil {
		return err
	}
	defer release()
	err = client.Remove(remotePath)
	if err != nil {
		m.invalidateOnConnErr(sessionID, err)
	}
	return err
}

func (m *Manager) RenameRemoteFile(sessionID, oldPath, newPath string) error {
	oldPath = cleanRemotePath(oldPath)
	newPath = cleanRemotePath(newPath)
	client, release, err := m.acquire(sessionID)
	if err != nil {
		return err
	}
	defer release()
	err = client.Rename(oldPath, newPath)
	if err != nil {
		m.invalidateOnConnErr(sessionID, err)
	}
	return err
}

func (m *Manager) CreateRemoteDir(sessionID, remotePath string) error {
	remotePath = cleanRemotePath(remotePath)
	client, release, err := m.acquire(sessionID)
	if err != nil {
		return err
	}
	defer release()
	err = client.MkdirAll(remotePath)
	if err != nil {
		m.invalidateOnConnErr(sessionID, err)
	}
	return err
}

func (m *Manager) DownloadFolder(sessionID, remotePath, localDir string) (err error) {
	remotePath = cleanRemotePath(remotePath)
	job := m.beginTransfer(sessionID, remotePath, "download")
	var done, totalSize int64
	defer func() {
		m.finishTransfer(job, err, done, totalSize)
		if !job.cancelled.Load() {
			m.invalidateOnTransferErr(sessionID, err)
		}
	}()

	client, release, err := m.acquire(sessionID)
	if err != nil {
		return err
	}
	defer release()

	cleanRemote := path.Clean(remotePath)
	if err := os.MkdirAll(localDir, 0755); err != nil {
		return err
	}
	// Resolve the local root once so we can confine every extracted entry to it.
	localRoot, err := filepath.Abs(localDir)
	if err != nil {
		return fmt.Errorf("invalid local directory: %w", err)
	}
	localRoot = filepath.Clean(localRoot)
	rootPrefix := localRoot + string(os.PathSeparator)

	var files []struct {
		remotePath string
		localPath  string
		isDir      bool
		size       int64
	}
	walker := client.Walk(remotePath)
	for walker.Step() {
		if err = checkTransferContext(job.ctx); err != nil {
			return err
		}
		if err := walker.Err(); err != nil {
			return err
		}
		stat := walker.Stat()
		// Skip symlinks: a malicious server could use them to escape localDir or
		// to make the walk follow links outside the requested tree.
		if stat.Mode()&os.ModeSymlink != 0 {
			continue
		}
		rp := walker.Path()
		// Remote paths are forward-slash; compute the relative segment with the
		// remote-path package, then convert to OS separators for local use.
		rel, relErr := relRemote(cleanRemote, rp)
		if relErr != nil {
			return fmt.Errorf("invalid path: %w", relErr)
		}
		localPath := filepath.Join(localRoot, filepath.FromSlash(rel))
		// Containment check (zip-slip guard): the resolved path must stay within
		// localRoot. localRoot itself (rel == ".") is allowed.
		if localPath != localRoot && !strings.HasPrefix(localPath, rootPrefix) {
			return fmt.Errorf("refusing to write outside destination: %s", rel)
		}
		isDir := stat.IsDir()
		files = append(files, struct {
			remotePath string
			localPath  string
			isDir      bool
			size       int64
		}{remotePath: rp, localPath: localPath, isDir: isDir})
		if isDir {
			if err := os.MkdirAll(localPath, 0755); err != nil {
				return err
			}
		} else {
			totalSize += stat.Size()
		}
	}
	if walkErr := walker.Err(); walkErr != nil {
		return walkErr
	}
	if err = checkTransferContext(job.ctx); err != nil {
		return err
	}

	progress := throttled(func(n int64) {
		m.emitTransfer(job, "progress", n, totalSize, nil)
	})
	for _, f := range files {
		if f.isDir {
			continue
		}
		if err = checkTransferContext(job.ctx); err != nil {
			return err
		}
		baseDone := done
		var fileDone int64
		fileDone, err = m.downloadFileOnly(client, job, f.remotePath, f.localPath, func(n int64) {
			progress(baseDone + n)
		})
		done = baseDone + fileDone
		if err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) downloadFileOnly(client *sftp.Client, job *transferJob, remotePath, localPath string, progress func(int64)) (written int64, err error) {
	src, err := client.Open(remotePath)
	if err != nil {
		return 0, err
	}
	srcClosed := false
	defer func() {
		if !srcClosed {
			_ = src.Close()
		}
	}()

	partPath := transferPartPath(localPath, job.id)
	dst, err := os.OpenFile(partPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return 0, err
	}
	dstClosed := false
	defer func() {
		if !dstClosed {
			_ = dst.Close()
		}
		if err != nil {
			_ = os.Remove(partPath)
		}
	}()
	clearInterrupt := job.setInterrupt(func() {
		_ = src.Close()
		_ = dst.Close()
	})
	defer clearInterrupt()

	written, err = src.WriteTo(&progressWriter{ctx: job.ctx, w: dst, fn: progress})
	closeErr := dst.Close()
	dstClosed = true
	if err == nil && closeErr != nil {
		err = closeErr
	}
	closeErr = src.Close()
	srcClosed = true
	if err == nil && closeErr != nil {
		err = closeErr
	}
	if err != nil {
		return written, err
	}
	if err = checkTransferContext(job.ctx); err != nil {
		return written, err
	}
	if err = replaceLocalTemp(partPath, localPath); err != nil {
		return written, err
	}
	return written, nil
}

// invalidateOnConnErr drops the cached client only for transport-level
// failures. A StatusError is the server answering over a healthy link
// (permission denied, no such file, ...); recycling the client for those would
// tear down an SFTP subsystem that concurrent operations are still using and
// force a pointless reconnect.
func (m *Manager) invalidateOnConnErr(sessionID string, err error) {
	if err == nil {
		return
	}
	var status *sftp.StatusError
	if errors.As(err, &status) {
		return
	}
	m.InvalidateClient(sessionID)
}

func (m *Manager) invalidateOnTransferErr(sessionID string, err error) {
	if err == nil || errors.Is(err, context.Canceled) {
		return
	}
	// Local open/write/rename failures do not say anything about the cached
	// SFTP transport and must not disconnect concurrent remote operations.
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		return
	}
	m.invalidateOnConnErr(sessionID, err)
}

func isPermissionErr(err error) bool {
	var status *sftp.StatusError
	if errors.As(err, &status) {
		return status.FxCode() == sftp.ErrSSHFxPermissionDenied
	}
	return os.IsPermission(err)
}

func randomSuffix() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// throttled rate-limits a progress callback to one call per
// progressEmitInterval. The final "finished" event is emitted separately by
// the caller, so dropping intermediate ticks never loses the end state.
func throttled(fn func(int64)) func(int64) {
	var last time.Time
	return func(n int64) {
		now := time.Now()
		if now.Sub(last) < progressEmitInterval {
			return
		}
		last = now
		fn(n)
	}
}

// progressReader counts bytes as the sftp client drains the local file during
// an upload.
type progressReader struct {
	ctx context.Context
	r   io.Reader
	n   int64
	fn  func(int64)
}

func (p *progressReader) Read(b []byte) (int, error) {
	if err := checkTransferContext(p.ctx); err != nil {
		return 0, err
	}
	n, err := p.r.Read(b)
	if n > 0 {
		p.n += int64(n)
		p.fn(p.n)
	}
	return n, err
}

// progressWriter counts bytes as the sftp client fills the local file during a
// download.
type progressWriter struct {
	ctx context.Context
	w   io.Writer
	n   int64
	fn  func(int64)
}

func (p *progressWriter) Write(b []byte) (int, error) {
	if err := checkTransferContext(p.ctx); err != nil {
		return 0, err
	}
	n, err := p.w.Write(b)
	if n > 0 {
		p.n += int64(n)
		p.fn(p.n)
	}
	return n, err
}

// relRemote returns rp expressed relative to base, operating purely on
// forward-slash remote paths (never OS separators). It returns an error if rp
// is not within base, so callers can reject entries that escape the requested
// tree (e.g. a server returning paths above the download root).
func relRemote(base, rp string) (string, error) {
	base = path.Clean(base)
	rp = path.Clean(rp)
	if rp == base {
		return ".", nil
	}
	prefix := base
	if prefix != "/" {
		prefix += "/"
	}
	if !strings.HasPrefix(rp, prefix) {
		return "", fmt.Errorf("path %q is outside %q", rp, base)
	}
	rel := strings.TrimPrefix(rp, prefix)
	if rel == "" || strings.HasPrefix(rel, "/") || rel == ".." || strings.HasPrefix(rel, "../") {
		return "", fmt.Errorf("invalid relative path %q", rel)
	}
	return rel, nil
}

func cleanRemotePath(p string) string {
	cleaned := path.Clean(p)
	parts := strings.Split(cleaned, "/")
	var safe []string
	for _, part := range parts {
		if part == ".." {
			if len(safe) > 0 {
				safe = safe[:len(safe)-1]
			}
			continue
		}
		if part == "" || part == "." {
			continue
		}
		safe = append(safe, part)
	}
	result := strings.Join(safe, "/")
	if strings.HasPrefix(cleaned, "/") {
		return "/" + result
	}
	if result == "" {
		return "."
	}
	return result
}
