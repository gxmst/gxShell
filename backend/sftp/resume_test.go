package sftpmanager

import (
	"context"
	"io"
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

// The file browsers hide every temp file gxShell writes beside a destination,
// which is a wider set than the resumable parts: directory downloads name parts
// after the job, remote copies stage through their own name, and pre-1.5 builds
// wrote a third format that can still be sitting on disk.
func TestIsTransferArtifactCoversEveryTempName(t *testing.T) {
	artifacts := []string{
		localPartPath("/data/report.csv", resumeKey{size: 10, modTime: time.Unix(1700000000, 0)}),
		remotePartPath("/srv/report.csv", resumeKey{size: 10, modTime: time.Unix(1700000000, 0)}),
		transferPartPath("/data/tree.bin", "18d1c2b3-ab12cd34"),
		"/data/report.csv.gxshell-copy-ab12cd34.part",
		"/data/report.csv.gxshell-ab12cd34.bak",
	}
	for _, name := range artifacts {
		if !IsTransferArtifact(name) {
			t.Errorf("IsTransferArtifact(%q) = false, want true", name)
		}
	}

	for _, name := range []string{
		"/data/report.csv",
		"/data/report.csv.part",                   // not ours
		"/data/report.csv.bak",                    // a user's own backup
		"/data/gxshell-notes.md",                  // mentions gxshell, not a temp file
		"/data/report.csv.partial",                // neither suffix
		"/data/report.gxshell-manual.bak",         // marker, but not our generated suffix
		"/data/report.gxshell-copy-my-notes.part", // copy marker, but not our random ID
		"/data/project.gxshell-work/database.bak", // marker belongs to the directory
		"/data/project.gxshell-work/chunk.part",   // marker belongs to the directory
	} {
		if IsTransferArtifact(name) {
			t.Errorf("IsTransferArtifact(%q) = true, want false", name)
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

func TestRemovablePartsKeepsTheResumableOneAndIgnoresOtherFiles(t *testing.T) {
	base := "/data/report.csv"
	now := time.Unix(1700000000, 0)
	keep := localPartPath(base, resumeKey{size: 100, modTime: now})
	orphan := localPartPath(base, resumeKey{size: 999, modTime: time.Unix(1600000000, 0)})
	otherTarget := localPartPath("/data/other.csv", resumeKey{size: 1, modTime: time.Unix(1, 0)})

	// Everything is fresh, so only the unresumable partial for this very
	// destination may go; the other destination's is none of our business yet.
	entries := []partEntry{
		{path: base, modTime: now},
		{path: keep, modTime: now},
		{path: orphan, modTime: now},
		{path: "/data/other.csv", modTime: now},
		{path: otherTarget, modTime: now},
		{path: "/data/report.csv.bak", modTime: now}, // a user's own backup
	}

	remove := removableParts(entries, base, keep, nil, now)
	if len(remove) != 1 || remove[0] != orphan {
		t.Fatalf("removableParts = %#v, want just %q", remove, orphan)
	}
}

func TestRemovablePartsNeverDeletesSimilarlyNamedUserFiles(t *testing.T) {
	now := time.Unix(1700000000, 0)
	base := "/data/report.csv"
	keep := localPartPath(base, resumeKey{size: 100, modTime: now})
	old := now.Add(-partSweepAge - time.Hour)
	userFiles := []partEntry{
		{path: "/data/report.csv.gxshell-manual.bak", modTime: now},
		{path: "/data/other.gxshell-notes.part", modTime: old},
		{path: "/data/project.gxshell-work/database.bak", modTime: old},
		{path: "/data/project.gxshell-work/chunk.part", modTime: old},
	}

	if remove := removableParts(userFiles, base, keep, nil, now); len(remove) != 0 {
		t.Fatalf("similarly named user files must never be removed, got %#v", remove)
	}
}

// A part file for another destination is swept only once it is old enough that
// no one could still be intending to resume it.
func TestRemovablePartsSweepsOnlyAgedForeignParts(t *testing.T) {
	now := time.Unix(1700000000, 0)
	base := "/data/report.csv"
	keep := localPartPath(base, resumeKey{size: 100, modTime: now})
	foreign := localPartPath("/data/other.csv", resumeKey{size: 5, modTime: now})

	fresh := removableParts([]partEntry{{path: foreign, modTime: now.Add(-partSweepAge + time.Hour)}}, base, keep, nil, now)
	if len(fresh) != 0 {
		t.Errorf("a recent foreign part must be left alone, got %#v", fresh)
	}

	aged := removableParts([]partEntry{{path: foreign, modTime: now.Add(-partSweepAge - time.Hour)}}, base, keep, nil, now)
	if len(aged) != 1 || aged[0] != foreign {
		t.Errorf("an abandoned foreign part should be swept, got %#v", aged)
	}
}

// Two transfers into one directory must not delete each other's work. Both the
// same-destination rule and the age sweep have to respect the live set.
func TestRemovablePartsNeverTouchesLivePartFiles(t *testing.T) {
	now := time.Unix(1700000000, 0)
	base := "/data/report.csv"
	keep := localPartPath(base, resumeKey{size: 100, modTime: now})
	// Another upload of a different local file to the same remote name: its part
	// name differs, so without the live set it looks like an orphan of `base`.
	sibling := localPartPath(base, resumeKey{size: 4242, modTime: now})
	agedForeign := localPartPath("/data/other.csv", resumeKey{size: 5, modTime: now})

	entries := []partEntry{
		{path: sibling, modTime: now},
		{path: agedForeign, modTime: now.Add(-partSweepAge - time.Hour)},
	}
	inUse := map[string]bool{sibling: true, agedForeign: true}

	if remove := removableParts(entries, base, keep, inUse, now); len(remove) != 0 {
		t.Fatalf("live part files must never be removed, got %#v", remove)
	}
	// Sanity: without the live set both would have gone, so the test is really
	// exercising the exemption rather than some other rule.
	if remove := removableParts(entries, base, keep, nil, now); len(remove) != 2 {
		t.Fatalf("expected both to be removable when not in use, got %#v", remove)
	}
}

func TestLocalRemovablePartsRemovesOnlyMatchingOrphans(t *testing.T) {
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

	m := &Manager{}
	stale := m.localRemovableParts(target, keep)
	if len(stale) != 1 || stale[0] != orphan {
		t.Fatalf("localRemovableParts = %#v, want just %q", stale, orphan)
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

// The live set comes from the job map, so a claimed part must survive a sweep
// driven by a real Manager rather than only the pure helper.
func TestLocalRemovablePartsExemptsClaimedParts(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "archive.tar")
	keep := localPartPath(target, resumeKey{size: 500, modTime: time.Unix(1700000000, 0)})
	sibling := localPartPath(target, resumeKey{size: 12, modTime: time.Unix(1600000000, 0)})

	for _, name := range []string{keep, sibling} {
		if err := os.WriteFile(name, []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
	}

	m := &Manager{}
	live := &transferJob{id: "live"}
	m.transfers = map[string]*transferJob{live.id: live}
	m.claimPart(live, sibling)

	if got := m.localRemovableParts(target, keep); len(got) != 0 {
		t.Fatalf("a claimed part must not be swept, got %#v", got)
	}
}

func TestLocalRemovablePartsToleratesMissingDirectory(t *testing.T) {
	// Cleanup is housekeeping; an unreadable directory must not surface as an
	// error to the transfer.
	m := &Manager{}
	if got := m.localRemovableParts(filepath.Join(t.TempDir(), "nope", "file.bin"), ""); got != nil {
		t.Errorf("expected nil for a missing directory, got %#v", got)
	}
}

func TestRemoteBaseUsesSlashSemantics(t *testing.T) {
	// Remote paths are always forward-slash, even though the app runs on Windows.
	if got := remoteBase("/srv/app/report.csv"); got != "/srv/app" {
		t.Errorf("remoteBase = %q, want /srv/app", got)
	}
}

// Guards the contiguous-prefix invariant documented in resume.go.
//
// pkg/sftp's File.ReadFrom switches from sequential writes to concurrent writes
// at explicit offsets when the reader it receives advertises a length, via any
// of Len() / Size() / Stat(), or by being an *io.LimitedReader. That mode
// documents that an error can leave the file longer than its last contiguous
// byte — at which point resuming an upload at the part file's length would
// append after a hole and silently produce a corrupt file, because the size
// check at the end of UploadFile still adds up.
//
// progressReader wraps the *os.File source and must not forward those methods.
// This is easy to undo by accident: embedding io.Reader instead of naming the
// field, or "helpfully" adding a Size() so progress can report a total, both
// re-enable concurrency and break resume with no other visible change. Fail
// here rather than in a user's corrupted upload.
func TestProgressReaderHidesSourceLengthFromSftp(t *testing.T) {
	// An *os.File has Stat(); the wrapper is what must not expose it.
	file, err := os.CreateTemp(t.TempDir(), "src")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()

	var reader io.Reader = &progressReader{ctx: context.Background(), r: file, fn: func(int64) {}}

	if _, ok := reader.(interface{ Len() int }); ok {
		t.Error("progressReader must not expose Len(): it enables concurrent offset writes")
	}
	if _, ok := reader.(interface{ Size() int64 }); ok {
		t.Error("progressReader must not expose Size(): it enables concurrent offset writes")
	}
	if _, ok := reader.(interface {
		Stat() (os.FileInfo, error)
	}); ok {
		t.Error("progressReader must not expose Stat(): it enables concurrent offset writes")
	}
	if _, ok := reader.(*io.LimitedReader); ok {
		t.Error("progressReader must not be an *io.LimitedReader: it enables concurrent offset writes")
	}
}
