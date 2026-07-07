package config

import (
	"encoding/json"
	"testing"
	"time"

	"gxShell/backend/types"
)

// The byte cache must never change observable behaviour: a read after a write
// returns the written value, and each caller gets a private copy it can mutate
// without corrupting the next read.

func TestReadAfterWriteReflectsLatestValue(t *testing.T) {
	s := newTestStore(t)
	if err := s.SaveProfiles([]types.Profile{{ID: "a", CliAlias: "one"}}); err != nil {
		t.Fatal(err)
	}
	// Warm the cache.
	if _, err := s.ListProfiles(); err != nil {
		t.Fatal(err)
	}
	// A subsequent write must be visible to the next read, not shadowed by the
	// cached bytes.
	if err := s.SaveProfiles([]types.Profile{{ID: "b", CliAlias: "two"}}); err != nil {
		t.Fatal(err)
	}
	got, err := s.ListProfiles()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "b" || got[0].CliAlias != "two" {
		t.Fatalf("read after write = %#v, want single profile b/two", got)
	}
}

func TestCachedReadsReturnIndependentCopies(t *testing.T) {
	s := newTestStore(t)
	if err := s.SaveProfiles([]types.Profile{{ID: "a", CliAlias: "one"}}); err != nil {
		t.Fatal(err)
	}
	first, err := s.ListProfiles()
	if err != nil {
		t.Fatal(err)
	}
	// Mutate the returned slice; the cache must be unaffected.
	first[0].CliAlias = "mutated"
	second, err := s.ListProfiles()
	if err != nil {
		t.Fatal(err)
	}
	if second[0].CliAlias != "one" {
		t.Fatalf("cache corrupted by caller mutation: got %q, want one", second[0].CliAlias)
	}
}

func TestCachedReadWaitsForInFlightWrite(t *testing.T) {
	s := newTestStore(t)
	if err := s.SaveProfiles([]types.Profile{{ID: "a", CliAlias: "one"}}); err != nil {
		t.Fatal(err)
	}
	// Warm the cache with the original value.
	if _, err := s.ListProfiles(); err != nil {
		t.Fatal(err)
	}

	s.mu.Lock()
	done := make(chan []types.Profile, 1)
	errs := make(chan error, 1)
	go func() {
		got, err := s.ListProfiles()
		if err != nil {
			errs <- err
			return
		}
		done <- got
	}()

	select {
	case got := <-done:
		s.mu.Unlock()
		t.Fatalf("cached read completed while write lock was held: %#v", got)
	case err := <-errs:
		s.mu.Unlock()
		t.Fatalf("cached read errored while write lock was held: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	data, err := json.Marshal([]types.Profile{{ID: "b", CliAlias: "two"}})
	if err != nil {
		s.mu.Unlock()
		t.Fatal(err)
	}
	s.storeCacheLocked("profiles.json", data)
	s.mu.Unlock()

	select {
	case err := <-errs:
		t.Fatal(err)
	case got := <-done:
		if len(got) != 1 || got[0].ID != "b" || got[0].CliAlias != "two" {
			t.Fatalf("read after in-flight write = %#v, want single profile b/two", got)
		}
	case <-time.After(time.Second):
		t.Fatal("cached read did not resume after write lock released")
	}
}
