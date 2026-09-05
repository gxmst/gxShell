package app

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
)

const documentAuthorizationFilename = "document-access.dat"
const maxDocumentAuthorizationBytes = 1024 * 1024

// allowedFileSet is the set of local file paths the user has genuinely chosen
// to open (via the native file dialog, the startup file-open, or as a text
// sibling of an already-allowed file). Local file reads and writes only operate
// on paths in this set, so a compromised renderer cannot use them to read or
// overwrite arbitrary files on disk.
//
// It is a small, self-contained subsystem extracted from App so the
// authorization boundary can be reasoned about and tested in isolation. All
// paths are stored cleaned-and-absolute; callers pass the same normalized form
// to allow() and contains().
type allowedFileSet struct {
	mu          sync.Mutex
	paths       map[string]bool
	history     map[string]bool
	historyPath string
}

func newAllowedFileSet() *allowedFileSet {
	return &allowedFileSet{paths: map[string]bool{}, history: map[string]bool{}}
}

func allowedFileKey(path string) string {
	if runtime.GOOS == "windows" {
		return strings.ToLower(path)
	}
	return path
}

// Loading history never grants renderer access; restore must select a path
// from this backend-owned record before it enters the active set.
func (s *allowedFileSet) loadHistory(path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.historyPath = path
	file, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxDocumentAuthorizationBytes+1))
	if err != nil {
		return err
	}
	if len(data) > maxDocumentAuthorizationBytes {
		return fmt.Errorf("document authorization history is too large")
	}
	var paths []string
	if err := json.Unmarshal(data, &paths); err != nil {
		return err
	}
	for _, path := range paths {
		if filepath.IsAbs(path) {
			s.history[allowedFileKey(filepath.Clean(path))] = true
		}
	}
	return nil
}

func (s *allowedFileSet) saveHistoryLocked() error {
	if s.historyPath == "" {
		return nil
	}
	paths := make([]string, 0, len(s.history))
	for path := range s.history {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	data, err := json.Marshal(paths)
	if err != nil {
		return err
	}
	if len(data) > maxDocumentAuthorizationBytes {
		return fmt.Errorf("document authorization history is too large")
	}
	file, err := os.CreateTemp(filepath.Dir(s.historyPath), ".document-access-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), s.historyPath)
}

// allow records that the user has genuinely chosen to open path, returning the
// cleaned absolute path that subsequent reads/writes must use. It returns ""
// when the path cannot be made absolute, in which case nothing is authorized.
func (s *allowedFileSet) allow(path string) (string, error) {
	paths, err := s.allowMany([]string{path})
	if len(paths) == 0 {
		return "", err
	}
	return paths[0], err
}

// Directory listings authorize siblings together so they persist the history
// once, rather than rewriting and flushing it once per directory entry.
func (s *allowedFileSet) allowMany(paths []string) ([]string, error) {
	absPaths := make([]string, 0, len(paths))
	for _, path := range paths {
		abs, err := filepath.Abs(path)
		if err != nil {
			return nil, err
		}
		absPaths = append(absPaths, filepath.Clean(abs))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var added []string
	for _, abs := range absPaths {
		key := allowedFileKey(abs)
		s.paths[key] = true
		if !s.history[key] {
			s.history[key] = true
			added = append(added, key)
		}
	}
	if len(added) == 0 {
		return absPaths, nil
	}
	if err := s.saveHistoryLocked(); err != nil {
		for _, key := range added {
			delete(s.history, key)
		}
		return absPaths, err
	}
	return absPaths, nil
}

func (s *allowedFileSet) restore(absPath string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := allowedFileKey(absPath)
	if !s.history[key] && !s.paths[key] {
		return false
	}
	s.paths[key] = true
	return true
}

// contains reports whether absPath was previously authorized via allow. The
// argument must already be cleaned-and-absolute.
func (s *allowedFileSet) contains(absPath string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.paths[allowedFileKey(absPath)]
}
