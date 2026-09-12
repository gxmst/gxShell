package sessionlog

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"sort"
	"sync"
	"time"

	"gxShell/backend/config"
	"gxShell/backend/types"
)

// Only names produced by Writer belong to retention. Other files, directories
// and symbolic links in the log directory are never cleanup candidates.
var managedLogName = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}-([A-Za-z0-9_-]{0,48}-log-\d+-[0-9a-f]{16})-\d{4,}\.log$`)

type Manager struct {
	mu      sync.Mutex
	dir     string
	active  map[string]bool
	policy  types.SessionLogRetentionSettings
	now     func() time.Time
	onError func(error)
}

func NewManager(dir string, onError func(error)) *Manager {
	return &Manager{dir: dir, active: map[string]bool{}, now: time.Now, onError: onError}
}

// UpdateRetention applies an explicit local policy. The zero value is disabled.
func (m *Manager) UpdateRetention(policy types.SessionLogRetentionSettings) error {
	if err := config.ValidateSessionLogRetention(policy); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.policy = config.NormalizeSessionLogRetention(policy)
	return m.pruneLocked()
}

func (m *Manager) New(name string, settings types.SessionLogSettings, onError func(error)) (*Writer, error) {
	m.mu.Lock()
	cleanupErr := m.pruneLocked()
	w, err := newWriter(m.dir, name, settings, onError, m.release)
	if err == nil {
		// Creation and registration share the cleanup lock, so a new writer
		// cannot be mistaken for a closed session before its first write.
		m.active[w.prefix] = true
	}
	m.mu.Unlock()
	m.report(cleanupErr)
	return w, err
}

func (m *Manager) release(w *Writer) {
	m.mu.Lock()
	delete(m.active, w.prefix)
	err := m.pruneLocked()
	m.mu.Unlock()
	m.report(err)
}

func (m *Manager) report(err error) {
	if err != nil && m.onError != nil {
		m.onError(fmt.Errorf("session log cleanup failed: %w", err))
	}
}

func (m *Manager) pruneLocked() error {
	if !m.policy.Enabled {
		return nil
	}
	root, err := os.OpenRoot(m.dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer root.Close()
	dir, err := root.Open(".")
	if err != nil {
		return err
	}
	entries, err := dir.ReadDir(-1)
	_ = dir.Close()
	if err != nil {
		return err
	}
	type candidate struct {
		name string
		info os.FileInfo
	}
	var closed []candidate
	var total int64
	for _, entry := range entries {
		match := managedLogName.FindStringSubmatch(entry.Name())
		if len(match) != 2 || !entry.Type().IsRegular() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			continue
		}
		total += info.Size()
		if !m.active[match[1]] {
			closed = append(closed, candidate{entry.Name(), info})
		}
	}
	sort.Slice(closed, func(i, j int) bool {
		if closed[i].info.ModTime().Equal(closed[j].info.ModTime()) {
			return closed[i].name < closed[j].name
		}
		return closed[i].info.ModTime().Before(closed[j].info.ModTime())
	})
	cutoff := m.now().Add(-time.Duration(m.policy.MaxAgeDays) * 24 * time.Hour)
	limit := int64(m.policy.MaxTotalMB) * 1024 * 1024
	var failures []error
	for _, file := range closed {
		if !file.info.ModTime().Before(cutoff) && total <= limit {
			continue
		}
		// Recheck identity without following links before removing a file. A
		// changed/replaced file will be reconsidered on a later cleanup pass.
		current, err := root.Lstat(file.name)
		if errors.Is(err, os.ErrNotExist) {
			total -= file.info.Size()
			continue
		}
		if err == nil && (!current.Mode().IsRegular() || !os.SameFile(file.info, current) || current.Size() != file.info.Size() || !current.ModTime().Equal(file.info.ModTime())) {
			continue
		}
		if err == nil {
			err = root.Remove(file.name)
		}
		if err != nil {
			failures = append(failures, fmt.Errorf("%s: %w", file.name, err))
			continue
		}
		total -= file.info.Size()
	}
	return errors.Join(failures...)
}
