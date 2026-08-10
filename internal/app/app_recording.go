package app

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	osruntime "runtime"
	"sort"
	"strings"
	"time"

	"gxShell/backend/logger"
	"gxShell/backend/types"
)

// recordingsDir returns the directory where .cast session recordings live. It is
// kept under the app data dir alongside logs so it inherits the same location
// and cleanup expectations.
func (a *App) recordingsDir() string {
	return filepath.Join(a.store.DataDir(), "recordings")
}

// sanitizeRecordingName returns a filesystem-safe base name for a recording,
// derived from the session/host title. Falls back to "session" when empty.
func sanitizeRecordingName(title string) string {
	title = strings.TrimSpace(title)
	if title == "" {
		title = "session"
	}
	var b strings.Builder
	for _, r := range title {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		case r == '.' || r == '@' || r == ' ':
			b.WriteRune('-')
		}
	}
	name := strings.Trim(b.String(), "-")
	if name == "" {
		name = "session"
	}
	if len(name) > 48 {
		name = name[:48]
	}
	return name
}

// randomSuffix returns a short hex token used to disambiguate recording file
// names created within the same second. Falls back to a fixed token if the
// system RNG is unavailable, which at worst reintroduces the same-second clash
// that the timestamp already mostly prevents.
func randomSuffix() string {
	b := make([]byte, 3)
	if _, err := rand.Read(b); err != nil {
		return "rec"
	}
	return hex.EncodeToString(b)
}

// StartRecording begins recording the given session's terminal output to a
// timestamped .cast file. title is used both in the .cast header and the file
// name. Recording taps terminal output only, not stdin. Shell-echoed commands
// can appear in recordings; password prompts with echo disabled are not captured.
func (a *App) StartRecording(sessionID string, title string) (string, error) {
	if err := os.MkdirAll(a.recordingsDir(), 0700); err != nil {
		return "", fmt.Errorf("cannot create recordings dir: %w", err)
	}
	stamp := time.Now().Format("20060102-150405")
	// A short random suffix disambiguates two recordings of the same title
	// started within the same second, which a second-resolution timestamp alone
	// cannot (they would otherwise map to one path and O_TRUNC would clobber the
	// first, or two file handles would interleave into a corrupt file).
	fileName := fmt.Sprintf("%s-%s-%s.cast", sanitizeRecordingName(title), stamp, randomSuffix())
	path := filepath.Join(a.recordingsDir(), fileName)
	if err := a.ssh.StartRecording(sessionID, path, title); err != nil {
		return "", err
	}
	a.log.InfoFields("Started session recording", logger.LogFields{"file": fileName})
	return fileName, nil
}

// StopRecording finalizes a session recording and returns the .cast file name.
func (a *App) StopRecording(sessionID string) (string, error) {
	path, err := a.ssh.StopRecording(sessionID)
	if err != nil {
		return "", err
	}
	name := filepath.Base(path)
	a.log.InfoFields("Stopped session recording", logger.LogFields{"file": name})
	return name, nil
}

// IsRecording reports whether the session is currently recording.
func (a *App) IsRecording(sessionID string) bool {
	return a.ssh.IsRecording(sessionID)
}

// ListRecordings returns saved .cast recordings, newest first.
func (a *App) ListRecordings() ([]types.Recording, error) {
	dir := a.recordingsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []types.Recording{}, nil
		}
		return nil, err
	}
	recordings := []types.Recording{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".cast") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		recordings = append(recordings, types.Recording{
			Name:    entry.Name(),
			Size:    info.Size(),
			ModTime: info.ModTime(),
		})
	}
	sort.Slice(recordings, func(i, j int) bool { return recordings[i].ModTime.After(recordings[j].ModTime) })
	return recordings, nil
}

// validRecordingName guards the recording file name against path traversal. The
// name must be a bare .cast file with no path separators or "..".
func validRecordingName(name string) bool {
	if !strings.HasSuffix(name, ".cast") {
		return false
	}
	// Reject any path separator, parent ref, or Windows drive/ADS colon, and
	// require the name to be a bare base name. This blocks traversal on both
	// *nix and Windows (e.g. "..\x", "C:x.cast", "a/b.cast").
	if strings.Contains(name, "..") || strings.ContainsAny(name, `/\:`) {
		return false
	}
	if filepath.Base(name) != name {
		return false
	}
	return true
}

// ReadRecording returns the raw .cast content for the internal player. The name
// must be a bare .cast file in the recordings dir (no traversal).
func (a *App) ReadRecording(name string) (string, error) {
	if !validRecordingName(name) {
		return "", fmt.Errorf("invalid recording name")
	}
	path := filepath.Join(a.recordingsDir(), name)
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	const maxPlaybackSize = 64 * 1024 * 1024
	if info.Size() > maxPlaybackSize {
		return "", fmt.Errorf("recording is too large for the built-in player (%d MB, max 64 MB); open it with asciinema instead", info.Size()/(1024*1024))
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// DeleteRecording removes a saved recording.
func (a *App) DeleteRecording(name string) error {
	if !validRecordingName(name) {
		return fmt.Errorf("invalid recording name")
	}
	return os.Remove(filepath.Join(a.recordingsDir(), name))
}

// OpenRecordingsDir opens the recordings folder in the OS file browser so users
// can grab a .cast to play in the asciinema CLI or upload it.
func (a *App) OpenRecordingsDir() error {
	dir := a.recordingsDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	switch osruntime.GOOS {
	case "windows":
		return exec.Command("explorer.exe", dir).Start()
	case "darwin":
		return exec.Command("open", dir).Start()
	default:
		return exec.Command("xdg-open", dir).Start()
	}
}
