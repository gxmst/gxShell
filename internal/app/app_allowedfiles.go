package app

import (
	"path/filepath"
	"sync"
)

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
	mu    sync.Mutex
	paths map[string]bool
}

func newAllowedFileSet() *allowedFileSet {
	return &allowedFileSet{paths: map[string]bool{}}
}

// allow records that the user has genuinely chosen to open path, returning the
// cleaned absolute path that subsequent reads/writes must use. It returns ""
// when the path cannot be made absolute, in which case nothing is authorized.
func (s *allowedFileSet) allow(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return ""
	}
	abs = filepath.Clean(abs)
	s.mu.Lock()
	s.paths[abs] = true
	s.mu.Unlock()
	return abs
}

// contains reports whether absPath was previously authorized via allow. The
// argument must already be cleaned-and-absolute.
func (s *allowedFileSet) contains(absPath string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.paths[absPath]
}
