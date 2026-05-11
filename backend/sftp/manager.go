package sftpmanager

import (
	"io"
	"os"
	"path"
	"sort"

	"gxShell/backend/types"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type SSHClientProvider interface {
	Client(sessionID string) (*ssh.Client, error)
}

type Manager struct {
	sessions SSHClientProvider
	emit     func(event string, data any)
}

func NewManager(sessions SSHClientProvider, emit func(event string, data any)) *Manager {
	return &Manager{sessions: sessions, emit: emit}
}

func (m *Manager) withClient(sessionID string) (*sftp.Client, error) {
	client, err := m.sessions.Client(sessionID)
	if err != nil {
		return nil, err
	}
	return sftp.NewClient(client)
}

func (m *Manager) ListRemoteDir(sessionID string, remotePath string) ([]types.RemoteFile, error) {
	if remotePath == "" {
		remotePath = "."
	}
	client, err := m.withClient(sessionID)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	entries, err := client.ReadDir(remotePath)
	if err != nil {
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
	client, err := m.withClient(sessionID)
	if err != nil {
		return err
	}
	defer client.Close()

	src, err := os.Open(localPath)
	if err != nil {
		return err
	}
	defer src.Close()
	stat, _ := src.Stat()

	dst, err := client.Create(remotePath)
	if err != nil {
		return err
	}
	defer dst.Close()

	written, err := copyWithProgress(dst, src, func(n int64) {
		m.emit("sftp:progress", map[string]any{"sessionId": sessionID, "path": remotePath, "done": n, "total": stat.Size(), "direction": "upload"})
	})
	if err == nil {
		m.emit("sftp:progress", map[string]any{"sessionId": sessionID, "path": remotePath, "done": written, "total": stat.Size(), "direction": "upload", "finished": true})
	}
	return err
}

func (m *Manager) DownloadFile(sessionID, remotePath, localPath string) error {
	client, err := m.withClient(sessionID)
	if err != nil {
		return err
	}
	defer client.Close()

	src, err := client.Open(remotePath)
	if err != nil {
		return err
	}
	defer src.Close()
	stat, _ := src.Stat()

	dst, err := os.Create(localPath)
	if err != nil {
		return err
	}
	defer dst.Close()

	written, err := copyWithProgress(dst, src, func(n int64) {
		total := int64(0)
		if stat != nil {
			total = stat.Size()
		}
		m.emit("sftp:progress", map[string]any{"sessionId": sessionID, "path": remotePath, "done": n, "total": total, "direction": "download"})
	})
	if err == nil {
		total := written
		if stat != nil {
			total = stat.Size()
		}
		m.emit("sftp:progress", map[string]any{"sessionId": sessionID, "path": remotePath, "done": written, "total": total, "direction": "download", "finished": true})
	}
	return err
}

func (m *Manager) DeleteRemoteFile(sessionID, remotePath string) error {
	client, err := m.withClient(sessionID)
	if err != nil {
		return err
	}
	defer client.Close()
	return client.Remove(remotePath)
}

func (m *Manager) RenameRemoteFile(sessionID, oldPath, newPath string) error {
	client, err := m.withClient(sessionID)
	if err != nil {
		return err
	}
	defer client.Close()
	return client.Rename(oldPath, newPath)
}

func (m *Manager) CreateRemoteDir(sessionID, remotePath string) error {
	client, err := m.withClient(sessionID)
	if err != nil {
		return err
	}
	defer client.Close()
	return client.MkdirAll(remotePath)
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
