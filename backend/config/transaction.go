package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func migrationFile(name string) bool {
	if name == "profiles.json" || name == "settings.json" || name == "commands.json" || name == "known_hosts" {
		return true
	}
	return strings.HasPrefix(name, "imported-keys/") && strings.HasSuffix(name, ".key") && !strings.ContainsAny(strings.TrimPrefix(name, "imported-keys/"), "/\\:") && !strings.Contains(name, "..")
}

func readOptionalFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxConfigFileSize {
		return nil, errors.New("migration file is not regular or is too large")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxConfigFileSize+1))
	if len(data) > maxConfigFileSize {
		return nil, errors.New("migration file is too large")
	}
	return data, err
}

// SnapshotFiles reads disk under the same lock used by all config writers.
// A nil value denotes a missing file, distinct from an existing empty file.
func (s *Store) SnapshotFiles(names ...string) (map[string][]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make(map[string][]byte, len(names))
	for _, name := range names {
		if !migrationFile(name) {
			return nil, errors.New("invalid migration file")
		}
		data, err := readOptionalFile(filepath.Join(s.dir, name))
		if err != nil {
			return nil, err
		}
		result[name] = data
	}
	return result, nil
}

// ApplyMigration rejects edits made after preview. Files are staged before any
// replacement; a failed replacement restores every earlier file and its cache.
// This provides rollback for I/O failures, not a cross-file crash transaction.
func (s *Store) ApplyMigration(before, after map[string][]byte) error {
	return s.applyMigration(before, after, os.Rename)
}

func (s *Store) applyMigration(before, after map[string][]byte, replace func(string, string) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	names := make([]string, 0, len(after))
	staged := map[string]string{}
	defer func() {
		for _, path := range staged {
			_ = os.Remove(path)
		}
	}()
	for name, data := range after {
		prior, ok := before[name]
		if !ok || !migrationFile(name) || len(data) > maxConfigFileSize {
			return errors.New("invalid migration file or size")
		}
		path := filepath.Join(s.dir, name)
		current, err := readOptionalFile(path)
		if err != nil {
			return err
		}
		if (current == nil) != (prior == nil) || !bytes.Equal(current, prior) {
			return errors.New("data changed since backup preview; preview again")
		}
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		file, err := os.CreateTemp(filepath.Dir(path), ".migration-*")
		if err != nil {
			return err
		}
		staged[name] = file.Name()
		if err := file.Chmod(0600); err != nil {
			_ = file.Close()
			return err
		}
		_, writeErr := file.Write(data)
		syncErr := file.Sync()
		closeErr := file.Close()
		if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
			return err
		}
		names = append(names, name)
	}
	sort.Strings(names)
	var applied []string
	for _, name := range names {
		if err := replace(staged[name], filepath.Join(s.dir, name)); err != nil {
			var rollbackErrors []error
			for i := len(applied) - 1; i >= 0; i-- {
				previous := applied[i]
				path := filepath.Join(s.dir, previous)
				var restoreErr error
				if before[previous] == nil {
					restoreErr = os.Remove(path)
				} else {
					restoreErr = os.WriteFile(path, before[previous], 0600)
				}
				if restoreErr != nil {
					rollbackErrors = append(rollbackErrors, fmt.Errorf("rollback %s: %w", previous, restoreErr))
				}
				// A failed rollback may have left different bytes on disk. Do not
				// continue serving the old cached configuration as if it succeeded.
				delete(s.cache, previous)
			}
			return errors.Join(append([]error{fmt.Errorf("import %s: %w", name, err)}, rollbackErrors...)...)
		}
		applied = append(applied, name)
	}
	for name, data := range after {
		s.storeCacheLocked(name, data)
	}
	return nil
}
