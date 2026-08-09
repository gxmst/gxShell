package sftpmanager

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
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
	// stopEvict ends the evictLoop goroutine on Shutdown.
	stopEvict chan struct{}
	stopOnce  sync.Once

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

	// partPath is the temp file this job is currently writing, published so
	// concurrent transfers into the same directory do not clean it up as an
	// orphan. Empty until the job has decided on a name. Guarded by the
	// Manager's transferMu rather than a field mutex, because it is only ever
	// written by the owning job and read while walking the job map.
	partPath string

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

type RemoteCopyResult struct {
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

// ErrOverwriteRequired is returned when a transfer would replace an existing
// regular file without an explicit overwrite decision. Callers should use
// IsOverwriteRequired (or errors.Is with this sentinel) instead of matching the
// human-readable error text.
var ErrOverwriteRequired = errors.New("overwrite required")

// OverwriteRequiredError identifies the destination that prevented a
// no-overwrite transfer from being promoted.
type OverwriteRequiredError struct {
	Path   string
	Remote bool
}

func (e *OverwriteRequiredError) Error() string {
	if e == nil {
		return ErrOverwriteRequired.Error()
	}
	label := "download destination"
	if e.Remote {
		label = "remote destination"
	}
	return fmt.Sprintf("%s already exists: %s", label, e.Path)
}

func (e *OverwriteRequiredError) Unwrap() error {
	return ErrOverwriteRequired
}

// IsOverwriteRequired reports whether err is a destination conflict that can
// be resolved by retrying with an explicit overwrite policy.
func IsOverwriteRequired(err error) bool {
	return errors.Is(err, ErrOverwriteRequired)
}

func NewManager(sessions SSHClientProvider, emit func(event string, data any)) *Manager {
	m := &Manager{
		sessions:  sessions,
		emit:      emit,
		cache:     map[string]*cachedClient{},
		createMu:  map[string]*sync.Mutex{},
		stopEvict: make(chan struct{}),
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
	// InvalidateClient drops the createMu entry, so a creator that raced it can
	// land here alongside us under a different creation lock. Detach whatever
	// entry we displace; otherwise its client would leak with no path left to
	// close it.
	displaced := m.cache[sessionID]
	if displaced != nil {
		displaced.closing = true
	}
	m.cache[sessionID] = cc
	shouldCloseDisplaced := displaced != nil && displaced.refs == 0
	m.mu.Unlock()
	if shouldCloseDisplaced {
		_ = displaced.client.Close()
	}
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
// closed once any in-flight operations release it. The per-session creation
// mutex is dropped as well: session IDs are never reused, so without this the
// createMu map grows by one entry per connection for the life of the process.
func (m *Manager) InvalidateClient(sessionID string) {
	m.mu.Lock()
	cc, ok := m.cache[sessionID]
	if ok {
		cc.closing = true
		delete(m.cache, sessionID)
	}
	delete(m.createMu, sessionID)
	shouldClose := ok && cc.refs == 0
	m.mu.Unlock()
	if shouldClose {
		_ = cc.client.Close()
	}
}

func (m *Manager) evictLoop() {
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-m.stopEvict:
			return
		case <-ticker.C:
		}
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

// Shutdown stops the background eviction goroutine. The cached clients
// themselves are closed through InvalidateClient as their sessions disconnect
// (ssh.Manager.Shutdown tears every session down), so only the ticker loop
// needs stopping here.
func (m *Manager) Shutdown() {
	m.stopOnce.Do(func() { close(m.stopEvict) })
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

// claimPart publishes the temp file a job is about to write, so part cleanup in
// a concurrent transfer treats it as live rather than abandoned. Call it before
// opening the file: the window between opening and claiming is exactly the race
// this closes.
func (m *Manager) claimPart(job *transferJob, partPath string) {
	m.transferMu.Lock()
	job.partPath = partPath
	m.transferMu.Unlock()
}

// partsInUse is the set of temp files live transfers are writing. Callers use it
// to exempt those paths from cleanup.
func (m *Manager) partsInUse() map[string]bool {
	m.transferMu.Lock()
	defer m.transferMu.Unlock()
	inUse := make(map[string]bool, len(m.transfers))
	for _, job := range m.transfers {
		if job.partPath != "" {
			inUse[job.partPath] = true
		}
	}
	return inUse
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

// emitResumed announces that a transfer is continuing from a partial file
// rather than starting over. It is a distinct status so the UI can say
// "resuming at 40%" instead of appearing to have lost the earlier progress.
func (m *Manager) emitResumed(job *transferJob, offset, total int64) {
	if m.emit == nil {
		return
	}
	m.emit("sftp:progress", map[string]any{
		"jobId":     job.id,
		"sessionId": job.sessionID,
		"path":      job.path,
		"done":      offset,
		"total":     total,
		"direction": job.direction,
		"status":    "resumed",
		"resumedAt": offset,
	})
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
		// gxShell's own in-progress and abandoned transfer files are plumbing, not
		// the user's data. A part file now outlives a failed transfer so it can be
		// resumed, so without this the browser shows names nobody asked for and
		// invites deleting one out from under a running transfer.
		if IsTransferArtifact(entry.Name()) {
			continue
		}
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

// RemoteFileExists checks whether a remote path is an existing regular file.
// A missing path returns false without error; directories and other special
// entries are rejected because file transfers must never replace them.
func (m *Manager) RemoteFileExists(sessionID, remotePath string) (bool, error) {
	remotePath = cleanRemotePath(remotePath)
	client, release, err := m.acquire(sessionID)
	if err != nil {
		return false, err
	}
	defer release()
	info, err := client.Lstat(remotePath)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		m.invalidateOnConnErr(sessionID, err)
		return false, err
	}
	if !info.Mode().IsRegular() {
		return true, fmt.Errorf("remote destination is not a regular file: %s", remotePath)
	}
	return true, nil
}

func (m *Manager) UploadFile(sessionID, localPath, remotePath string) error {
	return m.UploadFileWithPolicy(sessionID, localPath, remotePath, false)
}

// UploadFileWithPolicy uploads a file and atomically applies the caller's
// overwrite decision when the completed temporary file is promoted.
func (m *Manager) UploadFileWithPolicy(sessionID, localPath, remotePath string, overwrite bool) (err error) {
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
	var key resumeKey
	if statErr == nil {
		totalSize = stat.Size()
		key = resumeKey{size: stat.Size(), modTime: stat.ModTime()}
	}

	client, release, err := m.acquire(sessionID)
	if err != nil {
		return err
	}
	defer release()

	// As with downloads, the part name carries the local source's size and mtime,
	// so editing the file locally invalidates the partial rather than appending
	// new bytes onto old ones.
	tmpPath := remotePartPath(remotePath, key)
	m.claimPart(job, tmpPath)
	for _, orphan := range m.remoteRemovableParts(client, remotePath, tmpPath) {
		_ = client.Remove(orphan)
	}

	var offset int64
	// Without source metadata there is no identity to compare across attempts.
	// Transfer from byte zero rather than trusting a zero-key partial.
	if statErr == nil {
		if info, statPartErr := client.Stat(tmpPath); statPartErr == nil && info.Mode().IsRegular() {
			offset = resumeOffset(info.Size(), totalSize, true)
		}
	}

	flags := os.O_WRONLY | os.O_CREATE
	if offset == 0 {
		flags |= os.O_TRUNC
	}
	dst, err := client.OpenFile(tmpPath, flags)
	if err != nil {
		return err
	}
	dstClosed := false
	defer func() {
		if !dstClosed {
			_ = dst.Close()
		}
		// The part file survives a failure so the next attempt can resume from it.
		// It is removed only on success (by the rename) or when a later attempt
		// finds it unusable.
	}()

	if offset > 0 {
		if _, err = src.Seek(offset, io.SeekStart); err != nil {
			return err
		}
		if _, err = dst.Seek(offset, io.SeekStart); err != nil {
			return err
		}
		m.emitResumed(job, offset, totalSize)
	}

	clearInterrupt := job.setInterrupt(func() {
		_ = src.Close()
		_ = dst.Close()
	})
	defer clearInterrupt()

	progress := throttled(func(n int64) {
		m.emitTransfer(job, "progress", offset+n, totalSize, nil)
	})
	// ReadFrom writes from the handle's current offset, so the seek above is what
	// makes a resumed upload append.
	//
	// It writes sequentially, one packet per round trip: pkg/sftp only switches
	// to concurrent offset-addressed writes when the reader advertises a length,
	// and progressReader deliberately does not (see resume.go's
	// contiguous-prefix invariant — that mode can leave a part file longer than
	// its last contiguous byte, which is precisely what resuming at the part's
	// length must be able to trust). Downloads get the concurrency for free
	// because WriteTo orders its writes; matching it here would mean giving up
	// length-based resume for content verification.
	var copied int64
	copied, err = dst.ReadFrom(&progressReader{ctx: job.ctx, r: src, fn: progress})
	done = offset + copied
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
	if statErr == nil && done != totalSize {
		return fmt.Errorf("upload source size changed during transfer: copied %d of expected %d bytes", done, totalSize)
	}
	if err = checkTransferContext(job.ctx); err != nil {
		return err
	}
	if err = replaceRemoteTemp(client, tmpPath, remotePath, overwrite); err != nil {
		return err
	}
	return nil
}

// CopyRemoteFile streams one remote file through gxShell to another SSH
// session. The destination is verified and atomically renamed into place, so a
// disconnect or checksum failure cannot leave a partial final file.
func (m *Manager) CopyRemoteFile(ctx context.Context, sourceSessionID, sourcePath, destinationSessionID, destinationPath string, progress func(done, total int64)) (result RemoteCopyResult, err error) {
	if ctx == nil {
		ctx = context.Background()
	}
	sourcePath = cleanRemotePath(sourcePath)
	destinationPath = cleanRemotePath(destinationPath)

	sourceClient, releaseSource, err := m.acquire(sourceSessionID)
	if err != nil {
		return result, err
	}
	defer releaseSource()
	destinationClient, releaseDestination, err := m.acquire(destinationSessionID)
	if err != nil {
		return result, err
	}
	defer releaseDestination()

	source, err := sourceClient.Open(sourcePath)
	if err != nil {
		return result, err
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil {
		return result, err
	}
	if info.IsDir() {
		return result, fmt.Errorf("remote copy currently supports files only")
	}

	tmpPath := destinationPath + artifactMarker + "copy-" + randomSuffix() + partSuffix
	destination, err := destinationClient.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return result, err
	}
	removeTemp := true
	defer func() {
		_ = destination.Close()
		if removeTemp {
			_ = destinationClient.Remove(tmpPath)
		}
	}()

	sourceHash := sha256.New()
	reader := &progressReader{ctx: ctx, r: source, fn: func(done int64) {
		if progress != nil {
			progress(done, info.Size())
		}
	}}
	result.Bytes, err = io.CopyBuffer(io.MultiWriter(destination, sourceHash), reader, make([]byte, 256*1024))
	if closeErr := destination.Close(); err == nil && closeErr != nil {
		err = closeErr
	}
	if err != nil {
		return result, err
	}
	if err = checkTransferContext(ctx); err != nil {
		return result, err
	}
	if result.Bytes != info.Size() {
		return result, fmt.Errorf("remote copy size mismatch: copied %d of %d bytes", result.Bytes, info.Size())
	}
	if err = destinationClient.Chmod(tmpPath, info.Mode().Perm()); err != nil {
		return result, fmt.Errorf("preserve destination mode: %w", err)
	}

	verify, err := destinationClient.Open(tmpPath)
	if err != nil {
		return result, err
	}
	destinationHash := sha256.New()
	_, copyErr := io.CopyBuffer(destinationHash, &progressReader{ctx: ctx, r: verify, fn: func(int64) {}}, make([]byte, 256*1024))
	closeErr := verify.Close()
	if copyErr != nil {
		return result, copyErr
	}
	if closeErr != nil {
		return result, closeErr
	}
	sourceSum := sourceHash.Sum(nil)
	if !bytes.Equal(sourceSum, destinationHash.Sum(nil)) {
		return result, fmt.Errorf("remote copy checksum verification failed")
	}
	result.SHA256 = hex.EncodeToString(sourceSum)
	if err = replaceRemoteTemp(destinationClient, tmpPath, destinationPath, true); err != nil {
		return result, err
	}
	removeTemp = false
	return result, nil
}

func (m *Manager) DownloadFile(sessionID, remotePath, localPath string) error {
	return m.DownloadFileWithPolicy(sessionID, remotePath, localPath, false)
}

// DownloadFileWithPolicy downloads a file and atomically applies the caller's
// overwrite decision when the completed part file is promoted.
func (m *Manager) DownloadFileWithPolicy(sessionID, remotePath, localPath string, overwrite bool) (err error) {
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
	var key resumeKey
	if statErr == nil {
		totalSize = stat.Size()
		key = resumeKey{size: stat.Size(), modTime: stat.ModTime()}
	}

	// The part file's name encodes the source's size and mtime, so a metadata
	// change invalidates the old partial and starts a clean transfer.
	partPath := localPartPath(localPath, key)
	m.claimPart(job, partPath)
	// Part files from abandoned transfers of this same destination can no longer
	// be resumed once the source metadata changes; drop them rather than
	// accumulate, and sweep long-abandoned parts for other destinations too.
	for _, orphan := range m.localRemovableParts(localPath, partPath) {
		_ = os.Remove(orphan)
	}

	var offset int64
	// A failed remote Stat means the source version is unknown. Never resume a
	// partial in that case, even if a previous zero-key file happens to exist.
	if statErr == nil {
		if info, statPartErr := os.Stat(partPath); statPartErr == nil && info.Mode().IsRegular() {
			offset = resumeOffset(info.Size(), totalSize, true)
		}
	}

	// O_EXCL is deliberately absent: the whole point is to reopen an existing
	// part file. When offset is 0 the file is truncated, so a partial that failed
	// the resume checks above cannot contribute stale bytes.
	flags := os.O_WRONLY | os.O_CREATE
	if offset == 0 {
		flags |= os.O_TRUNC
	}
	dst, err := os.OpenFile(partPath, flags, 0644)
	if err != nil {
		return err
	}
	dstClosed := false
	defer func() {
		if !dstClosed {
			_ = dst.Close()
		}
		// A failed transfer keeps its part file: that is what the next attempt
		// resumes from. Cancellation keeps it too, since the user may retry.
		// Only a corrupt-looking partial is discarded, above.
	}()

	if offset > 0 {
		// Both sides must agree on the position. Seek the remote handle so the
		// server sends only the remainder, and the local handle so the bytes land
		// after what is already there.
		if _, err = src.Seek(offset, io.SeekStart); err != nil {
			return err
		}
		if _, err = dst.Seek(offset, io.SeekStart); err != nil {
			return err
		}
		m.emitResumed(job, offset, totalSize)
	}

	clearInterrupt := job.setInterrupt(func() {
		_ = src.Close()
		_ = dst.Close()
	})
	defer clearInterrupt()

	// Progress is reported against the whole file, not this attempt, so a resumed
	// transfer's bar continues from where it stopped rather than restarting at 0.
	progress := throttled(func(n int64) {
		m.emitTransfer(job, "progress", offset+n, totalSize, nil)
	})
	// WriteTo lets the sftp client issue concurrent read-ahead requests.
	var copied int64
	copied, err = src.WriteTo(&progressWriter{ctx: job.ctx, w: dst, fn: progress})
	done = offset + copied
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
	if statErr == nil && done != totalSize {
		return fmt.Errorf("download source size changed during transfer: copied %d of expected %d bytes", done, totalSize)
	}
	if err = checkTransferContext(job.ctx); err != nil {
		return err
	}
	if err = replaceLocalTemp(partPath, localPath, overwrite); err != nil {
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

// promoteRemoteNoReplace installs a fully written sibling temp file without
// replacing an existing destination. SFTP Rename is not a no-replace
// primitive: many servers overwrite the destination, so the hardlink extension
// is required for the atomic no-overwrite operation. If the server does not
// support it, fail closed rather than silently weakening the policy.
func promoteRemoteNoReplace(client *sftp.Client, tmpPath, remotePath string) error {
	if err := client.Link(tmpPath, remotePath); err != nil {
		return err
	}
	if err := client.Remove(tmpPath); err != nil {
		// The final link is already installed. Keep the successful transfer result
		// rather than reporting a false failure; the orphaned temp file is hidden
		// from listings and can be cleaned up on a later transfer sweep.
		return nil
	}
	return nil
}

// replaceRemoteTemp promotes a fully written sibling temp file without first
// deleting the destination. If the server cannot overwrite with plain Rename
// and does not support posix-rename, the existing file is left intact.
func replaceRemoteTemp(client *sftp.Client, tmpPath, remotePath string, overwrite bool) error {
	info, statErr := client.Lstat(remotePath)
	if os.IsNotExist(statErr) {
		if overwrite {
			// Even an overwrite-approved transfer had no target at promotion time.
			// Plain Rename is sufficient here because replacing a destination that
			// appears after this check is explicitly allowed.
			return client.Rename(tmpPath, remotePath)
		}
		if err := promoteRemoteNoReplace(client, tmpPath, remotePath); err != nil {
			// A destination created before the link is the same policy conflict as
			// one observed before the transfer. Re-check so the CLI can return a
			// stable overwrite_required outcome instead of a server-specific error.
			if raced, raceErr := client.Lstat(remotePath); raceErr == nil && raced.Mode().IsRegular() {
				return &OverwriteRequiredError{Path: remotePath, Remote: true}
			}
			return fmt.Errorf("promote remote file without replacing a new destination: %w", err)
		}
		return nil
	}
	if statErr == nil {
		if !info.Mode().IsRegular() {
			return fmt.Errorf("remote destination is not a regular file: %s", remotePath)
		}
		if !overwrite {
			return &OverwriteRequiredError{Path: remotePath, Remote: true}
		}
	} else if !os.IsNotExist(statErr) {
		// Do not attempt a no-overwrite rename when the destination could not be
		// inspected. A permission or transport error must fail closed rather than
		// relying on server-specific rename semantics.
		return fmt.Errorf("inspect remote destination: %w", statErr)
	}

	// The no-overwrite case with an existing regular target returned above.
	// Keep the guard explicit so future changes cannot accidentally fall through
	// to the overwrite path without a policy decision.
	if !overwrite {
		return &OverwriteRequiredError{Path: remotePath, Remote: true}
	}

	if err := client.PosixRename(tmpPath, remotePath); err != nil {
		if fallbackErr := client.Rename(tmpPath, remotePath); fallbackErr != nil {
			return fmt.Errorf("replace remote file: posix rename failed (%v); fallback rename failed without deleting original: %w", err, fallbackErr)
		}
	}
	return nil
}

func transferPartPath(localPath, jobID string) string {
	return localPath + artifactMarker + jobID + partSuffix
}

func promoteLocalNoReplace(sourcePath, targetPath string) error {
	if err := os.Link(sourcePath, targetPath); err != nil {
		return err
	}
	_ = os.Remove(sourcePath)
	return nil
}

func checkLocalNoReplaceSupport(sourcePath, targetPath string) error {
	probePath := targetPath + artifactMarker + randomSuffix() + ".link-check"
	if err := os.Link(sourcePath, probePath); err != nil {
		return err
	}
	if err := os.Remove(probePath); err != nil {
		return fmt.Errorf("remove link check %s: %w", probePath, err)
	}
	return nil
}

// replaceLocalTemp promotes a completed .part file. Existing regular files are
// moved aside first, then a hard link atomically installs the completed bytes
// only if the destination is still absent. This preserves both sides if another
// process creates a new destination during promotion.
func replaceLocalTemp(tmpPath, localPath string, overwrite bool) error {
	info, statErr := os.Lstat(localPath)
	if os.IsNotExist(statErr) {
		if err := promoteLocalNoReplace(tmpPath, localPath); err != nil {
			if !overwrite {
				if raced, raceErr := os.Lstat(localPath); raceErr == nil && raced.Mode().IsRegular() {
					return &OverwriteRequiredError{Path: localPath}
				}
			}
			return fmt.Errorf("promote completed download without replacing a new destination: %w", err)
		}
		return nil
	}
	if statErr != nil {
		return fmt.Errorf("inspect download destination: %w", statErr)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("download destination is not a regular file: %s", localPath)
	}
	if !overwrite {
		return &OverwriteRequiredError{Path: localPath}
	}
	// Confirm the filesystem supports the atomic promotion primitive before
	// moving the user's original file out of the way.
	if err := checkLocalNoReplaceSupport(tmpPath, localPath); err != nil {
		return fmt.Errorf("download filesystem does not support safe replacement: %w", err)
	}

	// Moving the old regular file aside gives every platform a rollback path and
	// lets promotion use the same atomic no-replace operation as the
	// non-conflict case.
	backupPath := localPath + artifactMarker + randomSuffix() + backupSuffix
	if err := os.Rename(localPath, backupPath); err != nil {
		return fmt.Errorf("prepare existing download target: %w", err)
	}
	backupInfo, backupStatErr := os.Lstat(backupPath)
	if backupStatErr != nil || !backupInfo.Mode().IsRegular() {
		restoreErr := os.Rename(backupPath, localPath)
		if backupStatErr != nil {
			return fmt.Errorf("verify existing download target: %v; restore original: %v", backupStatErr, restoreErr)
		}
		return fmt.Errorf("download destination changed to a non-regular file; restore original: %v", restoreErr)
	}
	if err := promoteLocalNoReplace(tmpPath, localPath); err != nil {
		if restoreErr := promoteLocalNoReplace(backupPath, localPath); restoreErr != nil {
			return fmt.Errorf("promote completed download: %v; restore original from %s: %w", err, backupPath, restoreErr)
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

	// A directory download names its parts after the job rather than the source
	// version: it never resumes (the whole tree is walked again), so there is
	// nothing to match across attempts, and a per-job name keeps the files of a
	// tree being fetched twice from colliding. Claiming it still matters, so a
	// single-file transfer sweeping the same directory leaves it alone.
	partPath := transferPartPath(localPath, job.id)
	m.claimPart(job, partPath)
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
	if err = replaceLocalTemp(partPath, localPath, true); err != nil {
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
	// A destination conflict is a policy outcome on a healthy connection, not
	// evidence that the SSH/SFTP transport needs to be recycled.
	if errors.Is(err, ErrOverwriteRequired) {
		return
	}
	// Local open/write/rename failures do not say anything about the cached
	// SFTP transport and must not disconnect concurrent remote operations.
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		return
	}
	var linkErr *os.LinkError
	if errors.As(err, &linkErr) {
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
