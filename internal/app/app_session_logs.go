package app

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gxShell/backend/types"
)

func (a *App) ListSessionLogFiles() ([]types.LogFile, error) {
	dir := filepath.Join(a.store.DataDir(), "session-logs")
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return []types.LogFile{}, nil
	}
	if err != nil {
		return nil, err
	}
	files := []types.LogFile{}
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !strings.HasSuffix(entry.Name(), ".log") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		files = append(files, types.LogFile{Name: entry.Name(), Size: info.Size(), ModTime: info.ModTime()})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].ModTime.After(files[j].ModTime) })
	return files, nil
}

func (a *App) ReadSessionLogFile(name string) (string, error) {
	if name == "" || strings.ContainsAny(name, `/\:`) || filepath.Base(name) != name || !strings.HasSuffix(name, ".log") {
		return "", fmt.Errorf("invalid session log name")
	}
	root, err := os.OpenRoot(filepath.Join(a.store.DataDir(), "session-logs"))
	if err != nil {
		return "", err
	}
	defer root.Close()
	f, err := root.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("not a regular log file")
	}
	start := max(int64(0), info.Size()-logViewerTailBytes)
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return "", err
	}
	data, err := io.ReadAll(io.LimitReader(f, logViewerTailBytes))
	if err != nil {
		return "", err
	}
	if start > 0 {
		if i := bytes.IndexByte(data, '\n'); i >= 0 {
			data = data[i+1:]
		}
		return logViewerTruncationNotice + strings.ToValidUTF8(string(data), "\uFFFD"), nil
	}
	return string(data), nil
}
