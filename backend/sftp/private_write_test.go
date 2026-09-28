package sftpmanager

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/pkg/sftp"
)

// Observe protocol operations instead of trusting InMemHandler's no-op chmod.
type privateWriteTrace struct {
	mu          sync.Mutex
	active      bool
	chmods      map[string]int
	writes      int
	unprotected bool
	denyChmod   int
	denyError   error
}
type privateFileCommands struct {
	sftp.FileCmder
	trace *privateWriteTrace
}

func (c privateFileCommands) Filecmd(r *sftp.Request) error {
	c.trace.mu.Lock()
	deny := false
	if c.trace.active && r.Method == "Setstat" && r.AttrFlags().Permissions {
		c.trace.chmods[r.Filepath]++
		deny = c.trace.denyChmod == c.trace.chmods[r.Filepath]
		if c.trace.chmods[r.Filepath] == 1 && r.Attributes().Mode&0777 != 0600 {
			c.trace.unprotected = true
		}
	}
	c.trace.mu.Unlock()
	if deny {
		if c.trace.denyError != nil {
			return c.trace.denyError
		}
		return os.ErrPermission
	}
	return c.FileCmder.Filecmd(r)
}

type privateHandleStub struct {
	mode              os.FileMode
	statErr, chmodErr error
	chmods            int
}

func (h *privateHandleStub) Stat() (os.FileInfo, error) { return privateModeInfo{h.mode}, h.statErr }
func (h *privateHandleStub) Chmod(os.FileMode) error    { h.chmods++; return h.chmodErr }

type privateModeInfo struct{ mode os.FileMode }

func (i privateModeInfo) Name() string       { return "part" }
func (i privateModeInfo) Size() int64        { return 0 }
func (i privateModeInfo) Mode() os.FileMode  { return i.mode }
func (i privateModeInfo) ModTime() time.Time { return time.Time{} }
func (i privateModeInfo) IsDir() bool        { return false }
func (i privateModeInfo) Sys() any           { return nil }

func TestPrivateHandleCapabilities(t *testing.T) {
	for _, tc := range []struct {
		name    string
		mode    os.FileMode
		statErr error
		wantErr bool
		chmods  int
	}{
		{"unsupported-stat", 0600, sftp.ErrSSHFxOpUnsupported, true, 0},
		{"already-private", 0600, nil, false, 0},
		{"unsupported-chmod", 0644, nil, true, 1},
		{"special-bits", 0600 | os.ModeSetuid, nil, true, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := &privateHandleStub{mode: tc.mode, statErr: tc.statErr, chmodErr: sftp.ErrSSHFxOpUnsupported}
			_, err := protectRemoteFileHandle(h)
			if (err != nil) != tc.wantErr || h.chmods != tc.chmods {
				t.Fatalf("error=%v chmods=%d", err, h.chmods)
			}
		})
	}
}

func TestUploadMetadataFailureCleanup(t *testing.T) {
	for _, tc := range []struct {
		name     string
		err      error
		retained bool
	}{
		{"permission", sftp.ErrSSHFxPermissionDenied, false},
		{"unsupported", sftp.ErrSSHFxOpUnsupported, false},
		{"transient", sftp.ErrSSHFxFailure, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			trace := &privateWriteTrace{chmods: map[string]int{}, denyChmod: 2, denyError: tc.err}
			handlers := sftp.InMemHandler()
			handlers.FileCmd = privateFileCommands{handlers.FileCmd, trace}
			m, c := newTransferTestManager(t, handlers)
			putTransferTestFile(t, c, "/target", []byte("original"))
			local := filepath.Join(t.TempDir(), "source")
			if err := os.WriteFile(local, []byte("replacement"), 0600); err != nil {
				t.Fatal(err)
			}
			trace.mu.Lock()
			trace.active = true
			trace.mu.Unlock()
			if err := m.UploadFileWithPolicy("test", local, "/target", true); err == nil {
				t.Fatal("expected metadata error")
			} else {
				t.Logf("upload error: %v", err)
			}
			if got := string(readTransferTestFile(t, c, "/target")); got != "original" {
				t.Fatalf("original replaced: %q", got)
			}
			entries, err := c.ReadDir("/")
			if err != nil {
				t.Fatal(err)
			}
			parts := 0
			for _, entry := range entries {
				if entry.Name() != "target" {
					parts++
				}
			}
			if (parts != 0) != tc.retained {
				t.Fatalf("remaining temporary files=%d, retained=%v", parts, tc.retained)
			}
		})
	}
}
func (c privateFileCommands) PosixRename(r *sftp.Request) error {
	return c.FileCmder.(sftp.PosixRenameFileCmder).PosixRename(r)
}

type privateFileWrites struct {
	sftp.FileWriter
	trace *privateWriteTrace
}

func (w privateFileWrites) Filewrite(r *sftp.Request) (io.WriterAt, error) {
	file, err := w.FileWriter.Filewrite(r)
	if err != nil {
		return nil, err
	}
	return privateWriter{file, w.trace, r.Filepath}, nil
}

type privateWriter struct {
	io.WriterAt
	trace *privateWriteTrace
	path  string
}

func (w privateWriter) WriteAt(data []byte, offset int64) (int, error) {
	w.trace.mu.Lock()
	if w.trace.active {
		w.trace.writes++
		if w.trace.chmods[w.path] == 0 {
			w.trace.unprotected = true
		}
	}
	w.trace.mu.Unlock()
	return w.WriterAt.WriteAt(data, offset)
}

func TestRemoteWritesProtectTemporaryContents(t *testing.T) {
	for _, operation := range []string{"editor", "upload", "copy"} {
		for _, deny := range []int{0, 1, 2} {
			name := operation + []string{"/success", "/protection-denied", "/restore-denied"}[deny]
			t.Run(name, func(t *testing.T) {
				trace := &privateWriteTrace{chmods: map[string]int{}, denyChmod: deny}
				handlers := sftp.InMemHandler()
				handlers.FileCmd = privateFileCommands{handlers.FileCmd, trace}
				handlers.FilePut = privateFileWrites{handlers.FilePut, trace}
				m, c := newTransferTestManager(t, handlers)
				putTransferTestFile(t, c, "/target.conf", []byte("original"))
				putTransferTestFile(t, c, "/source.conf", []byte("replacement"))
				local := filepath.Join(t.TempDir(), "source.conf")
				if err := os.WriteFile(local, []byte("replacement"), 0600); err != nil {
					t.Fatal(err)
				}
				trace.mu.Lock()
				trace.active = true
				trace.mu.Unlock()
				var err error
				switch operation {
				case "editor":
					err = m.WriteRemoteFile("test", "/target.conf", []byte("replacement"))
				case "upload":
					err = m.UploadFileWithPolicy("test", local, "/target.conf", true)
				case "copy":
					_, err = m.CopyRemoteFile(context.Background(), "test", "/source.conf", "test", "/target.conf", nil)
				}
				if (err != nil) != (deny != 0) {
					t.Fatalf("result = %v, deny chmod #%d", err, deny)
				}
				want := "replacement"
				if deny != 0 {
					want = "original"
				}
				if got := string(readTransferTestFile(t, c, "/target.conf")); got != want {
					t.Fatalf("target=%q, want %q", got, want)
				}
				trace.mu.Lock()
				defer trace.mu.Unlock()
				if trace.unprotected {
					t.Fatal("content written before 0600 protection")
				}
				if deny == 1 && trace.writes != 0 {
					t.Fatal("content written despite refused protection")
				}
				if deny == 0 && trace.writes == 0 {
					t.Fatal("success did not write content")
				}
			})
		}
	}
}

type ownershipFileInfo struct {
	os.FileInfo
	ids [2]int
}

func (i ownershipFileInfo) Sys() any {
	return &sftp.FileStat{UID: uint32(i.ids[0]), GID: uint32(i.ids[1])}
}

type strictOwnershipOps struct {
	*fakeRemoteFileOps
	denyChown, denyChmod bool
}

func (o *strictOwnershipOps) Lstat(name string) (os.FileInfo, error) {
	info, err := o.fakeRemoteFileOps.Lstat(name)
	if err != nil {
		return nil, err
	}
	return ownershipFileInfo{info, o.uids[name]}, nil
}
func (o *strictOwnershipOps) Chown(name string, uid, gid int) error {
	if o.denyChown {
		return os.ErrPermission
	}
	return o.fakeRemoteFileOps.Chown(name, uid, gid)
}
func (o *strictOwnershipOps) Chmod(name string, mode os.FileMode) error {
	if o.denyChmod {
		return os.ErrPermission
	}
	return o.fakeRemoteFileOps.Chmod(name, mode)
}
func TestRemoteOwnershipRestoresZeroValuesAndReportsFailures(t *testing.T) {
	for _, failure := range []string{"", "chown", "chmod"} {
		t.Run(failure, func(t *testing.T) {
			ops := &strictOwnershipOps{fakeRemoteFileOps: newFakeRemoteFileOps(), denyChown: failure == "chown", denyChmod: failure == "chmod"}
			ops.addFile("/target", 0)
			ops.addFile("/temp", 0600)
			ops.uids["/temp"] = [2]int{1000, 1000}
			owner := captureRemoteOwnership(ops, "/target")
			err := applyRemoteOwnership(ops, "/temp", owner)
			if failure != "" {
				if !errors.Is(err, os.ErrPermission) {
					t.Fatalf("metadata failure lost: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if ops.uids["/temp"] != [2]int{0, 0} || ops.files["/temp"] != 0 {
				t.Fatal("root ownership or mode 0000 not restored")
			}
		})
	}
}
