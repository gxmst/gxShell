package sftpmanager

// Resumable transfers.
//
// A part name binds the destination to the source identity, size and mtime.
// Before appending, both directions compare the complete existing prefix
// against the source. Metadata-preserving rewrites therefore restart safely.
//
//	report.csv.gxshell-r2-<source-hash>-<size>-<mtime>.part
//
// # The contiguous-prefix invariant
//
// Resuming at the part file's length assumes the first N bytes of a part file
// are the first N bytes of the source — that is, that every attempt leaves
// behind a contiguous prefix and never a file with a hole in it. Nothing about
// a file's size proves this on its own, so both transfer directions have to
// keep it true by construction:
//
//   - Downloads: pkg/sftp reads ahead concurrently but serializes the results
//     into ordered local writes (its WriteTo "Reduce" phase), so the local file
//     is always a prefix.
//   - Uploads: pkg/sftp's ReadFrom writes sequentially at a monotonic offset
//     *unless* the reader it is handed advertises a length, which switches it to
//     writing chunks at explicit offsets from several goroutines. That mode
//     documents that an error can leave the file longer than its last
//     contiguous byte, which would make the length a lie. progressReader
//     therefore deliberately hides the source's size; see the invariant test in
//     resume_test.go.
//
// Anything that changes how bytes reach a part file has to preserve this, or
// resume has to stop trusting the length and start verifying content.

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/pkg/sftp"
)

// partSuffix is the marker shared by every part file gxShell writes. The "r2"
// generation is part of the name so a future change to the resume format cannot
// be mistaken for a resumable part written by this version.
const partSuffix = ".part"
const partMarker = ".gxshell-r2-"

var errTransferPartBusy = errors.New("another transfer is already writing this partial file")
var errInvalidTransferPart = errors.New("transfer partial is not a regular file")

// artifactMarker is common to every temporary file gxShell writes beside a
// transfer destination: resumable parts, the per-job parts that directory
// downloads use, the remote-copy staging file, and the backup replaceLocalTemp
// takes on platforms where rename cannot replace.
const artifactMarker = ".gxshell-"

// backupSuffix is the extension replaceLocalTemp gives that backup.
const backupSuffix = ".bak"

// minResumeBytes is the smallest partial worth continuing. Below this, the
// round trips to stat and seek cost more than just re-sending the data.
const minResumeBytes = 256 * 1024

// partSweepAge is how long a part file for some *other* destination is left
// alone before a transfer passing through the same directory removes it.
//
// Parts for the destination being retried are handled exactly (see
// removableParts): their source metadata changed, so they are unresumable and
// go immediately. Everything else belongs to a transfer this one knows nothing
// about — possibly one running in another window right now, or one the user
// intends to retry after lunch. Age is the only signal available without a
// registry that survives app restarts, so the window is deliberately generous:
// a week-old part is certainly abandoned, while a resume that matters happens
// within one sitting.
const partSweepAge = 7 * 24 * time.Hour

// resumeKey fingerprints one source version by the metadata available locally
// or through SFTP.
type resumeKey struct {
	source  string
	size    int64
	modTime time.Time
}

// partName renders the part-file name for a destination and source version at
// the supplied timestamp precision.
func partName(destination, source string, size, modTime int64) string {
	identity := sha256.Sum256([]byte(source))
	return fmt.Sprintf("%s%s%x-%x-%x%s", destination, partMarker, identity[:16], size, modTime, partSuffix)
}

// isPartPath reports whether name is a resumable part file in this version's
// format, so resume bookkeeping can recognise one without re-deriving a key.
func isPartPath(name string) bool {
	suffix, ok := transferArtifactSuffix(name)
	return ok && strings.HasPrefix(suffix, "r2-") && isResumePartSuffix(suffix)
}

// IsTransferArtifact reports whether name is any temporary file gxShell writes
// next to a transfer destination.
//
// It is broader than isPartPath on purpose. These files used to be deleted the
// moment a transfer failed, so they were never visible; now that a part file
// survives a failure in order to be resumed, the file browsers have to know
// which entries are gxShell's plumbing rather than the user's data. It also
// covers the pre-1.5 job-id part names, which no longer match the resume format
// but can still be sitting in a directory from an older build.
//
// Match only the exact suffixes gxShell generates. A loose contains/suffix
// check can hide and eventually delete a user's similarly named backup, and
// checking the full path can even mistake an ordinary .bak inside a directory
// whose name contains ".gxshell-" for a transfer artifact.
func IsTransferArtifact(name string) bool {
	suffix, ok := transferArtifactSuffix(name)
	if !ok {
		return false
	}

	if strings.HasSuffix(suffix, backupSuffix) {
		return isRandomSuffix(strings.TrimSuffix(suffix, backupSuffix))
	}
	if !strings.HasSuffix(suffix, partSuffix) {
		return false
	}

	partID := strings.TrimSuffix(suffix, partSuffix)
	if strings.HasPrefix(partID, "r1-") || strings.HasPrefix(partID, "r2-") {
		return isResumePartSuffix(suffix)
	}
	if strings.HasPrefix(partID, "copy-") {
		return isRandomSuffix(strings.TrimPrefix(partID, "copy-"))
	}

	// Directory downloads use the transfer job ID: a hexadecimal UnixNano
	// timestamp followed by the same eight-hex random suffix used elsewhere.
	timestamp, random, found := strings.Cut(partID, "-")
	return found && isHex(timestamp) && isRandomSuffix(random)
}

// transferArtifactSuffix returns the generated portion following the last
// marker in the filename. Strip both local and remote separators explicitly so
// this helper remains correct for slash-style SFTP paths on Windows and for
// local paths on every supported platform.
func transferArtifactSuffix(name string) (string, bool) {
	base := name
	if separator := strings.LastIndexAny(base, `/\`); separator >= 0 {
		base = base[separator+1:]
	}
	marker := strings.LastIndex(base, artifactMarker)
	if marker < 0 {
		return "", false
	}
	return base[marker+len(artifactMarker):], true
}

func isResumePartSuffix(suffix string) bool {
	if !strings.HasSuffix(suffix, partSuffix) {
		return false
	}
	version := strings.TrimSuffix(suffix, partSuffix)
	switch {
	case strings.HasPrefix(version, "r2-"):
		identity, rest, found := strings.Cut(strings.TrimPrefix(version, "r2-"), "-")
		if !found || len(identity) != 32 || !isHex(identity) {
			return false
		}
		version = rest
	case strings.HasPrefix(version, "r1-"):
		version = strings.TrimPrefix(version, "r1-")
	default:
		return false
	}
	size, modTime, found := strings.Cut(version, "-")
	return found && isHex(size) && isSignedHex(modTime)
}

func isRandomSuffix(value string) bool {
	return len(value) == 8 && isHex(value)
}

func isSignedHex(value string) bool {
	if strings.HasPrefix(value, "-") {
		value = strings.TrimPrefix(value, "-")
	}
	return isHex(value)
}

func isHex(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

// resumeOffset decides where a transfer should start.
//
// existing is the size of the part file already on the destination, or -1 when
// there is none. The returned offset is 0 for "start from the beginning", in
// which case the caller truncates. total is the source size.
//
// This trusts existing as a byte count of correct leading data, which holds only
// under the contiguous-prefix invariant documented at the top of this file.
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
	return partName(localPath, key.source, key.size, key.modTime.Unix())
}

// remotePartPath is the part path for an upload, alongside the final file.
// Remote paths are always forward-slash, so this must not use filepath.
func remotePartPath(remotePath string, key resumeKey) string {
	// Upload sources are local files. Preserve their full timestamp precision so
	// an equal-sized rewrite within one second invalidates the old partial.
	return partName(remotePath, key.source, key.size, key.modTime.UnixNano())
}

func localSourceIdentity(localPath string) (string, error) {
	abs, err := filepath.Abs(localPath)
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "windows" {
		abs = strings.ToLower(abs)
	}
	return "local\x00" + filepath.Clean(abs), nil
}

func transferPartKey(partPath, direction string) (string, error) {
	if direction == "download" {
		return localSourceIdentity(partPath)
	}
	return "remote\x00" + cleanRemotePath(partPath), nil
}

// The sweep's directory snapshot may be stale by the time it deletes a file.
// Reserve deletion under the claim lock, then do I/O without blocking transfer
// cancellation. A new writer cannot claim the path until deletion finishes.
func (m *Manager) removeUnusedPart(partPath, direction string, remove func(string) error) error {
	key, err := transferPartKey(partPath, direction)
	if err != nil {
		return err
	}
	m.transferMu.Lock()
	if m.partCleanups[key] {
		m.transferMu.Unlock()
		return nil
	}
	for _, job := range m.transfers {
		if job.partKey == key {
			m.transferMu.Unlock()
			return nil
		}
	}
	if m.partCleanups == nil {
		m.partCleanups = make(map[string]bool)
	}
	m.partCleanups[key] = true
	m.transferMu.Unlock()
	defer func() {
		m.transferMu.Lock()
		delete(m.partCleanups, key)
		m.transferMu.Unlock()
	}()
	return remove(partPath)
}

func (j *transferJob) remoteIdentity() string {
	if j.runtimeID != "" {
		return j.runtimeID
	}
	if j.profileID != "" {
		return "profile:" + j.profileID
	}
	return "session:" + j.sessionID
}

func (j *transferJob) remoteSourceIdentity(remotePath string) string {
	return "remote\x00" + j.remoteIdentity() + "\x00" + cleanRemotePath(remotePath)
}

// ReaderAt keeps transfer offsets intact. Verification is bounded in memory
// and observes the same pause/cancel gate as the subsequent copy.
func verifyResumePrefix(job *transferJob, source, partial io.ReaderAt, size int64) (bool, error) {
	sourceBuffer := make([]byte, 64*1024)
	partialBuffer := make([]byte, len(sourceBuffer))
	for offset := int64(0); offset < size; {
		if err := job.waitIfPaused(); err != nil {
			return false, err
		}
		length := int(min(int64(len(sourceBuffer)), size-offset))
		n, err := source.ReadAt(sourceBuffer[:length], offset)
		if err != nil && err != io.EOF {
			return false, fmt.Errorf("verify source prefix: %w", err)
		}
		if n != length {
			return false, nil
		}
		n, err = partial.ReadAt(partialBuffer[:length], offset)
		if err != nil && err != io.EOF {
			return false, fmt.Errorf("verify partial prefix: %w", err)
		}
		if n != length || !bytes.Equal(sourceBuffer[:length], partialBuffer[:length]) {
			return false, nil
		}
		offset += int64(length)
	}
	return true, nil
}

// partEntry is one directory entry with the metadata cleanup needs.
type partEntry struct {
	path    string
	modTime time.Time
}

// removableParts decides which of a directory's part files may be deleted.
//
// Two cases are folded together because one directory listing answers both:
//
//   - A part for base, the destination this transfer is about to write, other
//     than keep. Its name encodes a source version that no longer exists, so it
//     can never be resumed again and goes immediately.
//   - A part for any other destination. Not this transfer's business, except
//     that nobody will ever look at it again once its transfer is gone for good,
//     so it goes once older than partSweepAge.
//
// inUse holds the parts of transfers running right now, which are exempt from
// both cases. Without it, concurrent transfers into one directory delete each
// other's work in progress: two uploads of different local files to the same
// remote name produce different part names, so each sees the other's part as an
// orphan of its own destination.
func removableParts(entries []partEntry, base string, keep string, inUse map[string]bool, now time.Time) []string {
	var remove []string
	prefix := base + artifactMarker
	for _, entry := range entries {
		if entry.path == keep || !IsTransferArtifact(entry.path) || inUse[entry.path] {
			continue
		}
		if strings.HasPrefix(entry.path, prefix) {
			remove = append(remove, entry.path)
			continue
		}
		if now.Sub(entry.modTime) > partSweepAge {
			remove = append(remove, entry.path)
		}
	}
	return remove
}

// localRemovableParts finds deletable part files beside one local destination.
//
// A listing failure returns nothing: cleanup is housekeeping and must never be
// the reason a transfer fails.
func (m *Manager) localRemovableParts(localPath string, keep string) []string {
	dir := filepath.Dir(localPath)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	candidates := make([]partEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			// Without a mod time the age rule cannot be applied. A zero time
			// would read as ancient and delete it, so skip the entry instead.
			continue
		}
		candidates = append(candidates, partEntry{path: filepath.Join(dir, entry.Name()), modTime: info.ModTime()})
	}
	return removableParts(candidates, localPath, keep, m.partsInUse(), time.Now())
}

// remoteBase returns the directory of a remote path, using remote (slash)
// semantics rather than the local OS's.
func remoteBase(remotePath string) string {
	return path.Dir(remotePath)
}

// remoteRemovableParts finds deletable part files beside one remote
// destination. Listing a directory costs a round trip, so this runs once per
// transfer rather than per chunk.
func (m *Manager) remoteRemovableParts(client *sftp.Client, remotePath string, keep string) []string {
	dir := remoteBase(remotePath)
	entries, err := client.ReadDir(dir)
	if err != nil {
		return nil
	}
	candidates := make([]partEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		candidates = append(candidates, partEntry{path: path.Join(dir, entry.Name()), modTime: entry.ModTime()})
	}
	return removableParts(candidates, remotePath, keep, m.partsInUse(), time.Now())
}
