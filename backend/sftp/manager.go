package sftpmanager

import (
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
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
}

const maxSFTPCache = 10

func NewManager(sessions SSHClientProvider, emit func(event string, data any)) *Manager {
	m := &Manager{
		sessions: sessions,
		emit:     emit,
		cache:    map[string]*cachedClient{},
		createMu: map[string]*sync.Mutex{},
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
		m.mu.Unlock()
		if _, err := client.Getwd(); err != nil {
			// Health check failed: detach it and retry via the slow path.
			m.release(sessionID, cc, true)
			return m.acquireSlow(sessionID)
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
	client, err := sftp.NewClient(sshClient)
	if err != nil {
		return nil, nil, err
	}

	m.mu.Lock()
	cc := &cachedClient{client: client, lastUsed: time.Now(), refs: 1}
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
		m.InvalidateClient(sessionID)
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

func (m *Manager) UploadFile(sessionID, localPath, remotePath string) error {
	remotePath = cleanRemotePath(remotePath)
	client, release, err := m.acquire(sessionID)
	if err != nil {
		return err
	}
	defer release()

	src, err := os.Open(localPath)
	if err != nil {
		return err
	}
	defer src.Close()
	stat, statErr := src.Stat()
	var totalSize int64
	if statErr == nil {
		totalSize = stat.Size()
	}

	dst, err := client.Create(remotePath)
	if err != nil {
		m.InvalidateClient(sessionID)
		return err
	}

	written, err := copyWithProgress(dst, src, func(n int64) {
		m.emit("sftp:progress", map[string]any{"sessionId": sessionID, "path": remotePath, "done": n, "total": totalSize, "direction": "upload"})
	})
	closeErr := dst.Close()
	if err == nil && closeErr != nil {
		err = closeErr
	}
	if err == nil {
		m.emit("sftp:progress", map[string]any{"sessionId": sessionID, "path": remotePath, "done": written, "total": totalSize, "direction": "upload", "finished": true})
	}
	return err
}

func (m *Manager) DownloadFile(sessionID, remotePath, localPath string) error {
	remotePath = cleanRemotePath(remotePath)
	client, release, err := m.acquire(sessionID)
	if err != nil {
		return err
	}
	defer release()

	src, err := client.Open(remotePath)
	if err != nil {
		m.InvalidateClient(sessionID)
		return err
	}
	defer src.Close()
	stat, statErr := src.Stat()

	dst, err := os.Create(localPath)
	if err != nil {
		return err
	}
	defer dst.Close()

	written, err := copyWithProgress(dst, src, func(n int64) {
		total := int64(0)
		if statErr == nil {
			total = stat.Size()
		}
		m.emit("sftp:progress", map[string]any{"sessionId": sessionID, "path": remotePath, "done": n, "total": total, "direction": "download"})
	})
	if err == nil {
		total := written
		if statErr == nil {
			total = stat.Size()
		}
		m.emit("sftp:progress", map[string]any{"sessionId": sessionID, "path": remotePath, "done": written, "total": total, "direction": "download", "finished": true})
	}
	return err
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
		m.InvalidateClient(sessionID)
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
		m.InvalidateClient(sessionID)
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
		m.InvalidateClient(sessionID)
	}
	return err
}

func (m *Manager) DownloadFolder(sessionID, remotePath, localDir string) error {
	remotePath = cleanRemotePath(remotePath)
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
		if err := walker.Err(); err != nil {
			m.InvalidateClient(sessionID)
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
		}
	}

	for i, f := range files {
		if f.isDir {
			continue
		}
		localPath := f.localPath
		m.emit("sftp:progress", map[string]any{
			"sessionId": sessionID,
			"path":      f.remotePath,
			"done":      int64(i + 1),
			"total":     int64(len(files)),
			"direction": "download",
		})
		if err := m.downloadFileOnly(client, f.remotePath, localPath); err != nil {
			m.InvalidateClient(sessionID)
			return err
		}
	}

	m.emit("sftp:progress", map[string]any{
		"sessionId": sessionID,
		"path":      remotePath,
		"done":      int64(len(files)),
		"total":     int64(len(files)),
		"direction": "download",
		"finished":  true,
	})
	return nil
}

func (m *Manager) downloadFileOnly(client *sftp.Client, remotePath, localPath string) error {
	src, err := client.Open(remotePath)
	if err != nil {
		return err
	}
	defer src.Close()

	dst, err := os.Create(localPath)
	if err != nil {
		return err
	}

	_, copyErr := io.Copy(dst, src)
	closeErr := dst.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func copyWithProgress(dst io.Writer, src io.Reader, progress func(int64)) (int64, error) {
	buf := make([]byte, 64*1024)
	var total int64
	for {
		n, readErr := src.Read(buf)
		if n > 0 {
			w, writeErr := dst.Write(buf[:n])
			total += int64(w)
			progress(total)
			if writeErr != nil {
				return total, writeErr
			}
			if w != n {
				return total, io.ErrShortWrite
			}
		}
		if readErr == io.EOF {
			return total, nil
		}
		if readErr != nil {
			return total, readErr
		}
	}
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
