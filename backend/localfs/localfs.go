package localfs

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gxShell/backend/types"
)

func ListDir(dir string) ([]types.LocalFile, error) {
	if dir == "" {
		dir, _ = os.UserHomeDir()
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	files := make([]types.LocalFile, 0, len(entries))
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, types.LocalFile{
			Name:    entry.Name(),
			Path:    filepath.Join(dir, entry.Name()),
			Size:    info.Size(),
			IsDir:   entry.IsDir(),
			ModTime: info.ModTime(),
		})
	}
	sort.SliceStable(files, func(i, j int) bool {
		if files[i].IsDir != files[j].IsDir {
			return files[i].IsDir
		}
		return strings.ToLower(files[i].Name) < strings.ToLower(files[j].Name)
	})
	return files, nil
}

func HomeDir() string {
	dir, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return dir
}
