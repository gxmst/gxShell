package sftpmanager

// Resumable transfers.
//
// A partial transfer is only safe to continue if the *source* has not changed
// since the bytes on disk were written. Rather than keep a sidecar metadata file
// (which then needs its own lifecycle, cleanup and corruption handling), a
// source metadata fingerprint is encoded into the part file's name:
//
//	report.csv.gxshell-r1-4a3f2e00-18d1c2b3f40.part
//	                     ^size    ^modtime
//
// If the source's size or modification time changes, the computed name changes
// too and the transfer starts over. A metadata-preserving rewrite is outside
// this scheme's guarantee; detecting that would require content hashing and a
// sidecar or server-side hash support.

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/pkg/sftp"
)

// partSuffix is the marker shared by every part file gxShell writes. The "r1"
// generation is part of the name so a future change to the resume format cannot
// be mistaken for a resumable part written by this version.
const partSuffix = ".part"
const partMarker = ".gxshell-r1-"

// minResumeBytes is the smallest partial worth continuing. Below this, the
// round trips to stat and seek cost more than just re-sending the data.
const minResumeBytes = 256 * 1024

// resumeKey fingerprints one source version by the metadata available locally
// or through SFTP.
type resumeKey struct {
	size    int64
	modTime time.Time
}

// partName renders the part-file name for a destination and source version at
// the supplied timestamp precision.
func partName(destination string, size, modTime int64) string {
	return fmt.Sprintf("%s%s%x-%x%s", destination, partMarker, size, modTime, partSuffix)
}

// isPartPath reports whether name is one of our part files, so directory
// listings and cleanup can recognise them without re-deriving a key.
func isPartPath(name string) bool {
	return strings.Contains(name, partMarker) && strings.HasSuffix(name, partSuffix)
}

// resumeOffset decides where a transfer should start.
//
// existing is the size of the part file already on the destination, or -1 when
// there is none. The returned offset is 0 for "start from the beginning", in
// which case the caller truncates. total is the source size.
//
// A part file larger than the source means the name collided with a stale file
// from a different version, or the source shrank without its recorded size
// changing; either way the bytes cannot be trusted, so the transfer restarts.
func resumeOffset(existing, total int64, sourceKnown bool) int64 {
	switch {
	case !sourceKnown:
		return 0
	case existing < minResumeBytes:
		return 0
	case total > 0 && existing >= total:
		// Already as long as the source. Nothing can be appended, and treating
		// this as complete would skip verification, so start over.
		return 0
	default:
		return existing
	}
}

// localPartPath is the part path for a download, alongside the final file.
func localPartPath(localPath string, key resumeKey) string {
	// SFTP exposes remote mtimes at whole-second precision, so a download cannot
	// safely use sub-second data that will not be present on the next attempt.
	return partName(localPath, key.size, key.modTime.Unix())
}

// remotePartPath is the part path for an upload, alongside the final file.
// Remote paths are always forward-slash, so this must not use filepath.
func remotePartPath(remotePath string, key resumeKey) string {
	// Upload sources are local files. Preserve their full timestamp precision so
	// an equal-sized rewrite within one second invalidates the old partial.
	return partName(remotePath, key.size, key.modTime.UnixNano())
}

// staleParts lists part files in dir whose names do not match keep.
//
// Part files are only left behind by a transfer that died without cleanup (a
// crash, or a disconnect mid-write). Removing the ones that can no longer be
// resumed keeps a download directory from silently accumulating them, while the
// one part file the current transfer is about to resume is preserved.
func staleParts(entries []string, base string, keep string) []string {
	var stale []string
	prefix := base + partMarker
	for _, name := range entries {
		if name == keep || !isPartPath(name) {
			continue
		}
		if strings.HasPrefix(name, prefix) {
			stale = append(stale, name)
		}
	}
	return stale
}

// localStaleParts finds abandoned part files for one local destination.
func localStaleParts(localPath string, keep string) []string {
	dir := filepath.Dir(localPath)
	handle, err := os.Open(dir)
	if err != nil {
		return nil
	}
	defer handle.Close()
	names, err := handle.Readdirnames(-1)
	if err != nil {
		return nil
	}
	full := make([]string, 0, len(names))
	for _, name := range names {
		full = append(full, filepath.Join(dir, name))
	}
	return staleParts(full, localPath, keep)
}

// remoteBase returns the directory of a remote path, using remote (slash)
// semantics rather than the local OS's.
func remoteBase(remotePath string) string {
	return path.Dir(remotePath)
}

// remoteStaleParts finds abandoned part files for one remote destination.
//
// Listing a directory costs a round trip, so this runs once per transfer rather
// than per chunk. A listing failure returns nothing: cleanup is housekeeping and
// must never be the reason an upload fails.
func (m *Manager) remoteStaleParts(client *sftp.Client, remotePath string, keep string) []string {
	entries, err := client.ReadDir(remoteBase(remotePath))
	if err != nil {
		return nil
	}
	dir := remoteBase(remotePath)
	full := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		full = append(full, path.Join(dir, entry.Name()))
	}
	return staleParts(full, remotePath, keep)
}
