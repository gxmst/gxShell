package sftpmanager

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPartNameEncodesSourceVersion(t *testing.T) {
	base := resumeKey{size: 1000, modTime: time.Unix(1700000000, 0)}
	name := localPartPath("/tmp/report.csv", base)

	if !strings.HasPrefix(name, "/tmp/report.csv") {
		t.Errorf("part name %q should sit alongside its destination", name)
	}
	if !isPartPath(name) {
		t.Errorf("part name %q not recognised by isPartPath", name)
	}

	// The point of the scheme: a different source version yields a different
	// name, so the old partial is simply not found.
	if other := localPartPath("/tmp/report.csv", resumeKey{size: 1001, modTime: base.modTime}); other == name {
		t.Error("a changed source size must change the part name")
	}
	if other := localPartPath("/tmp/report.csv", resumeKey{size: base.size, modTime: base.modTime.Add(time.Second)}); other == name {
		t.Error("a changed source mtime must change the part name")
	}
	// Same version, same name — otherwise resume could never find anything.
	if again := localPartPath("/tmp/report.csv", base); again != name {
		t.Errorf("part name is not stable: %q then %q", name, again)
	}
}

// Sub-second mtime changes must not invalidate a partial: SFTP servers report
// whole seconds, so a local nanosecond difference would make an upload's part
// name never match on the second attempt.
func TestPartNameIgnoresSubSecondMtime(t *testing.T) {
	at := time.Unix(1700000000, 0)
	a := localPartPath("/tmp/f", resumeKey{size: 10, modTime: at})
	b := localPartPath("/tmp/f", resumeKey{size: 10, modTime: at.Add(400 * time.Millisecond)})
	if a != b {
		t.Errorf("sub-second mtime changed the part name:\n%q\n%q", a, b)
	}
}

func TestUploadPartNamePreservesSubSecondMtime(t *testing.T) {
	at := time.Unix(1700000000, 0)
	a := remotePartPath("/tmp/f", resumeKey{size: 10, modTime: at})
	b := remotePartPath("/tmp/f", resumeKey{size: 10, modTime: at.Add(time.Nanosecond)})
	if a == b {
		t.Fatal("an equal-sized local rewrite with a different sub-second mtime must invalidate an upload partial")
	}
}

func TestIsPartPathRejectsOrdinaryFiles(t *testing.T) {
	for _, name := range []string{
		"/tmp/report.csv",
		"/tmp/report.csv.part",           // no gxshell marker
		"/tmp/report.csv.gxshell-r1-a-b", // no .part suffix
		"/tmp/notes.partial",
	} {
		if isPartPath(name) {
			t.Errorf("isPartPath(%q) = true, want false", name)
		}
	}
}

func TestResumeOffsetDecisions(t *testing.T) {
	const total = 10 * 1024 * 1024

	cases := []struct {
		name     string
		existing int64
		total    int64
		known    bool
		want     int64
	}{
		{"no partial", -1, total, true, 0},
		{"empty partial", 0, total, true, 0},
		// Below the floor the round trips cost more than resending.
		{"tiny partial is not worth resuming", minResumeBytes - 1, total, true, 0},
		{"partial at the floor resumes", minResumeBytes, total, true, minResumeBytes},
		{"large partial resumes", 4 * 1024 * 1024, total, true, 4 * 1024 * 1024},
		// A partial as long as the source cannot be appended to, and treating it
		// as done would skip the rename/verification path.
		{"partial equal to source restarts", total, total, true, 0},
		// Longer than the source means the bytes are not from this version.
		{"partial longer than source restarts", total + 1, total, true, 0},
		// Without a successful source Stat the zero-value key cannot identify a
		// source version, so an existing partial must never be trusted.
		{"unknown source never resumes", 4 * 1024 * 1024, 0, false, 0},
	}

	for _, c := range cases {
		if got := resumeOffset(c.existing, c.total, c.known); got != c.want {
			t.Errorf("%s: resumeOffset(%d, %d, %v) = %d, want %d", c.name, c.existing, c.total, c.known, got, c.want)
		}
	}
}

func TestStalePartsKeepsTheResumableOneAndIgnoresOtherFiles(t *testing.T) {
	base := "/data/report.csv"
	keep := localPartPath(base, resumeKey{size: 100, modTime: time.Unix(1700000000, 0)})
	orphan := localPartPath(base, resumeKey{size: 999, modTime: time.Unix(1600000000, 0)})

	entries := []string{
		base,              // the real file
		keep,              // the partial we are about to resume
		orphan,            // an abandoned partial for the same target
		"/data/other.csv", // unrelated file
		localPartPath("/data/other.csv", resumeKey{size: 1, modTime: time.Unix(1, 0)}), // another target's partial
		"/data/report.csv.bak", // not a part file
	}

	stale := staleParts(entries, base, keep)

	if len(stale) != 1 || stale[0] != orphan {
		t.Fatalf("staleParts = %#v, want just %q", stale, orphan)
	}
}

func TestLocalStalePartsRemovesOnlyMatchingOrphans(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "archive.tar")
	keep := localPartPath(target, resumeKey{size: 500, modTime: time.Unix(1700000000, 0)})
	orphan := localPartPath(target, resumeKey{size: 12, modTime: time.Unix(1600000000, 0)})
	unrelated := filepath.Join(dir, "other.bin")

	for _, name := range []string{target, keep, orphan, unrelated} {
		if err := os.WriteFile(name, []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
	}

	stale := localStaleParts(target, keep)
	if len(stale) != 1 || stale[0] != orphan {
		t.Fatalf("localStaleParts = %#v, want just %q", stale, orphan)
	}

	// The caller removes what it reports; nothing else may disappear.
	for _, name := range stale {
		if err := os.Remove(name); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{target, keep, unrelated} {
		if _, err := os.Stat(name); err != nil {
			t.Errorf("%s should still exist: %v", filepath.Base(name), err)
		}
	}
}

func TestLocalStalePartsToleratesMissingDirectory(t *testing.T) {
	// Cleanup is housekeeping; an unreadable directory must not surface as an
	// error to the transfer.
	if got := localStaleParts(filepath.Join(t.TempDir(), "nope", "file.bin"), ""); got != nil {
		t.Errorf("expected nil for a missing directory, got %#v", got)
	}
}

func TestRemoteBaseUsesSlashSemantics(t *testing.T) {
	// Remote paths are always forward-slash, even though the app runs on Windows.
	if got := remoteBase("/srv/app/report.csv"); got != "/srv/app" {
		t.Errorf("remoteBase = %q, want /srv/app", got)
	}
}
