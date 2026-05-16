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
	client  *sftp.Client
	lastUsed time.Time
}

type Manager struct {
	sessions SSHClientProvider
	emit     func(event string, data any)
	mu       sync.Mutex
	cache    map[string]*cachedClient
}

const maxSFTPCache = 10

func NewManager(sessions SSHClientProvider, emit func(event string, data any)) *Manager {
	m := &Manager{
		sessions: sessions,
		emit:     emit,
		cache:    map[string]*cachedClient{},
	}
	go m.evictLoop()
	return m
}

func (m *Manager) withClient(sessionID string) (*sftp.Client, error) {
	m.mu.Lock()
	if cc, ok := m.cache[sessionID]; ok {
		client := cc.client
		cc.lastUsed = time.Now()
		m.mu.Unlock()
		if _, err := client.Getwd(); err != nil {
			m.InvalidateClient(sessionID)
		} else {
			return client, nil
		}
	}
	if len(m.cache) >= maxSFTPCache {
		var oldestID string
		var oldestTime time.Time
		for id, cc := range m.cache {
			if oldestID == "" || cc.lastUsed.Before(oldestTime) {
				oldestID = id
				oldestTime = cc.lastUsed
			}
		}
		if oldestID != "" {
			_ = m.cache[oldestID].client.Close()
			delete(m.cache, oldestID)
		}
	}
	m.mu.Unlock()

	sshClient, err := m.sessions.Client(sessionID)
	if err != nil {
		return nil, err
	}
	client, err := sftp.NewClient(sshClient)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	if old, ok := m.cache[sessionID]; ok {
		_ = old.client.Close()
	}
	m.cache[sessionID] = &cachedClient{client: client, lastUsed: time.Now()}
	m.mu.Unlock()
	return client, nil
}

func (m *Manager) InvalidateClient(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if cc, ok := m.cache[sessionID]; ok {
		_ = cc.client.Close()
		delete(m.cache, sessionID)
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
				_ = cc.client.Close()
				delete(m.cache, id)
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
	client, err := m.withClient(sessionID)
	if err != nil {
		return nil, err
	}
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
	client, err := m.withClient(sessionID)
	if err != nil {
		return err
	}

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
	client, err := m.withClient(sessionID)
	if err != nil {
		return err
	}

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
	client, err := m.withClient(sessionID)
	if err != nil {
		return err
	}
	err = client.Remove(remotePath)
	if err != nil {
		m.InvalidateClient(sessionID)
	}
	return err
}

func (m *Manager) RenameRemoteFile(sessionID, oldPath, newPath string) error {
	oldPath = cleanRemotePath(oldPath)
	newPath = cleanRemotePath(newPath)
	client, err := m.withClient(sessionID)
	if err != nil {
		return err
	}
	err = client.Rename(oldPath, newPath)
	if err != nil {
		m.InvalidateClient(sessionID)
	}
	return err
}

func (m *Manager) CreateRemoteDir(sessionID, remotePath string) error {
	remotePath = cleanRemotePath(remotePath)
	client, err := m.withClient(sessionID)
	if err != nil {
		return err
	}
	err = client.MkdirAll(remotePath)
	if err != nil {
		m.InvalidateClient(sessionID)
	}
	return err
}

func (m *Manager) DownloadFolder(sessionID, remotePath, localDir string) error {
	remotePath = cleanRemotePath(remotePath)
	client, err := m.withClient(sessionID)
	if err != nil {
		return err
	}

	cleanRemote := path.Clean(remotePath)
	if err := os.MkdirAll(localDir, 0755); err != nil {
		return err
	}

	var files []struct {
		remotePath string
		localRel   string
		isDir      bool
		size       int64
	}
	walker := client.Walk(remotePath)
	for walker.Step() {
		if err := walker.Err(); err != nil {
			m.InvalidateClient(sessionID)
			return err
		}
		rp := walker.Path()
		rel, relErr := filepath.Rel(cleanRemote, rp)
		if relErr != nil {
			return fmt.Errorf("invalid path: %w", relErr)
		}
		isDir := walker.Stat().IsDir()
		files = append(files, struct {
			remotePath string
			localRel   string
			isDir      bool
			size       int64
		}{remotePath: rp, localRel: rel, isDir: isDir})
		if isDir {
			localSub := filepath.Join(localDir, rel)
			if err := os.MkdirAll(localSub, 0755); err != nil {
				return err
			}
		}
	}

	for i, f := range files {
		if f.isDir {
			continue
		}
		localPath := filepath.Join(localDir, f.localRel)
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
