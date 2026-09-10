package secrets

import (
	"errors"
	"fmt"
	"strings"

	"github.com/zalando/go-keyring"
)

type Value struct {
	ID       string
	Kind     string
	Text     string
	Expected *string
}

// NamedValues enumerates indexed names and the legacy Windows credential names.
// Values are only used inside encrypted export and never sent to the renderer.
func (s *Store) NamedValues(namespace string) (map[string]string, error) {
	s.operationMu.Lock()
	defer s.operationMu.Unlock()
	names, err := s.credentials().NamedNames(namespace)
	if err != nil {
		return nil, err
	}
	prefix := "named:" + namespace + ":"
	s.mu.Lock()
	data := s.fallbackData()
	degraded := s.fallbackDegraded
	for id := range data {
		if strings.HasPrefix(id, prefix) {
			names = append(names, strings.TrimPrefix(id, prefix))
		}
	}
	s.mu.Unlock()
	if degraded {
		return nil, errors.New("cannot read encrypted secret storage")
	}
	result := map[string]string{}
	for _, name := range names {
		value, err := s.migrationValue(prefix+name, "value")
		if err != nil {
			return nil, err
		}
		if value != "" {
			result[name] = value
		}
	}
	return result, nil
}

func (s *Store) migrationValue(id, kind string) (string, error) {
	value, err := s.credentials().Get(key(id, kind))
	if err == nil {
		return value, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	data := s.fallbackData()
	if s.fallbackDegraded {
		return "", errors.New("cannot read encrypted secret storage")
	}
	if value := data[id][kind]; value != "" {
		return value, nil
	}
	if errors.Is(err, keyring.ErrNotFound) {
		return "", nil
	}
	return "", err
}

func (s *Store) putMigrationValue(value Value) error {
	if value.Text != "" {
		if value.Kind == "value" {
			if err := s.saveFallback(value.ID, "indexed", "1"); err != nil {
				return err
			}
		}
		if err := s.credentials().Set(key(value.ID, value.Kind), value.Text); err != nil {
			return s.saveFallback(value.ID, value.Kind, value.Text)
		}
	} else {
		if err := s.credentials().Delete(key(value.ID, value.Kind)); err != nil && !errors.Is(err, keyring.ErrNotFound) {
			return err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.fallbackData()
	if s.fallbackDegraded {
		return errors.New("cannot update encrypted secret storage")
	}
	next := cloneFallback(current)
	delete(next[value.ID], value.Kind)
	if value.Text == "" && value.Kind == "value" {
		delete(next[value.ID], "indexed")
	}
	if len(next[value.ID]) == 0 {
		delete(next, value.ID)
	}
	return s.writeFallback(next)
}

// A failed disk write must not mutate the fallback cache.
func cloneFallback(current map[string]map[string]string) map[string]map[string]string {
	next := make(map[string]map[string]string, len(current))
	for id, entry := range current {
		next[id] = make(map[string]string, len(entry))
		for kind, text := range entry {
			next[id][kind] = text
		}
	}
	return next
}

// ApplyMigration restores previous credentials when any secret or config write
// fails. It holds the operation lock through commit so concurrent secret edits
// cannot be mistaken for values owned by this migration.
func (s *Store) ApplyMigration(updates []Value, commit func() error) error {
	s.operationMu.Lock()
	defer s.operationMu.Unlock()
	previous := make([]Value, len(updates))
	seen := map[string]bool{}
	for i, update := range updates {
		if update.ID == "" || (update.Kind != "password" && update.Kind != "passphrase" && update.Kind != "value") || seen[key(update.ID, update.Kind)] {
			return errors.New("invalid secret update")
		}
		seen[key(update.ID, update.Kind)] = true
		text, err := s.migrationValue(update.ID, update.Kind)
		if err != nil {
			return err
		}
		if update.Expected != nil && text != *update.Expected {
			return errors.New("credentials changed since preview; preview again")
		}
		previous[i] = Value{ID: update.ID, Kind: update.Kind, Text: text}
	}
	rollback := func(cause error, count int) error {
		failures := []error{cause}
		for i := count - 1; i >= 0; i-- {
			if err := s.putMigrationValue(previous[i]); err != nil {
				failures = append(failures, fmt.Errorf("credential rollback failed for %s: %w", previous[i].ID, err))
			}
		}
		return errors.Join(failures...)
	}
	for i, update := range updates {
		if err := s.putMigrationValue(update); err != nil {
			return rollback(err, i+1)
		}
	}
	if err := commit(); err != nil {
		return rollback(err, len(updates))
	}
	return nil
}
