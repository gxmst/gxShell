package sftpmanager

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pkg/sftp"
)

func newTransferTestManager(t *testing.T, handlers sftp.Handlers) (*Manager, *sftp.Client) {
	t.Helper()
	serverConn, clientConn := net.Pipe()
	_ = serverConn.SetDeadline(time.Now().Add(30 * time.Second))
	_ = clientConn.SetDeadline(time.Now().Add(30 * time.Second))
	server := sftp.NewRequestServer(serverConn, handlers)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		_ = server.Serve()
	}()
	client, err := sftp.NewClientPipe(clientConn, clientConn)
	if err != nil {
		_ = serverConn.Close()
		_ = clientConn.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = client.Close()
		_ = server.Close()
		<-finished
	})
	m := &Manager{
		cache: map[string]*cachedClient{"test": {client: client, lastCheck: time.Now(), lastUsed: time.Now()}},
		emit:  func(string, any) {},
	}
	return m, client
}

func putTransferTestFile(t *testing.T, client *sftp.Client, path string, data []byte) {
	t.Helper()
	file, err := client.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func readTransferTestFile(t *testing.T, client *sftp.Client, path string) []byte {
	t.Helper()
	file, err := client.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestDownloadVerifiesResumeContentsAndSource(t *testing.T) {
	for _, scenario := range []string{"matching", "changed-prefix", "changed-late-prefix", "other-path", "other-server", "legacy"} {
		t.Run(scenario, func(t *testing.T) {
			m, client := newTransferTestManager(t, sftp.InMemHandler())
			contents := bytes.Repeat([]byte("B"), minResumeBytes*2)
			putTransferTestFile(t, client, "/source.bin", contents)
			info, err := client.Stat("/source.bin")
			if err != nil {
				t.Fatal(err)
			}
			destination := filepath.Join(t.TempDir(), "download.bin")
			job := &transferJob{sessionID: "test"}
			key := resumeKey{source: job.remoteSourceIdentity("/source.bin"), size: info.Size(), modTime: info.ModTime()}
			switch scenario {
			case "other-path":
				key.source = job.remoteSourceIdentity("/another.bin")
			case "other-server":
				key.source = (&transferJob{sessionID: "another-server"}).remoteSourceIdentity("/source.bin")
			}
			part := localPartPath(destination, key)
			if scenario == "legacy" {
				part = fmt.Sprintf("%s.gxshell-r1-%x-%x.part", destination, info.Size(), info.ModTime().Unix())
			}
			prefix := bytes.Clone(contents[:minResumeBytes])
			if scenario == "changed-prefix" {
				prefix = bytes.Repeat([]byte("A"), minResumeBytes)
			} else if scenario == "changed-late-prefix" {
				prefix[len(prefix)-1] = 'A'
			}
			if err := os.WriteFile(part, prefix, 0600); err != nil {
				t.Fatal(err)
			}
			var resumed atomic.Bool
			m.emit = func(_ string, value any) {
				if event, ok := value.(map[string]any); ok && event["status"] == "resumed" {
					resumed.Store(true)
				}
			}
			if err := m.DownloadFileWithPolicy("test", "/source.bin", destination, false); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(destination)
			if err != nil || !bytes.Equal(got, contents) {
				t.Fatalf("download content mismatch: %v", err)
			}
			if resumed.Load() != (scenario == "matching") {
				t.Fatalf("resumed = %v", resumed.Load())
			}
		})
	}
}

func TestUploadVerifiesResumePrefix(t *testing.T) {
	for _, scenario := range []string{"matching", "changed-prefix", "changed-late-prefix", "other-path"} {
		t.Run(scenario, func(t *testing.T) {
			m, client := newTransferTestManager(t, sftp.InMemHandler())
			contents := bytes.Repeat([]byte("B"), minResumeBytes*2)
			source := filepath.Join(t.TempDir(), "upload.bin")
			if err := os.WriteFile(source, contents, 0600); err != nil {
				t.Fatal(err)
			}
			info, err := os.Stat(source)
			if err != nil {
				t.Fatal(err)
			}
			identity, err := localSourceIdentity(source)
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "other-path" {
				identity, err = localSourceIdentity(filepath.Join(filepath.Dir(source), "another.bin"))
				if err != nil {
					t.Fatal(err)
				}
			}
			part := remotePartPath("/upload.bin", resumeKey{source: identity, size: info.Size(), modTime: info.ModTime()})
			prefix := bytes.Clone(contents[:minResumeBytes])
			if scenario == "changed-prefix" {
				prefix = bytes.Repeat([]byte("A"), minResumeBytes)
			} else if scenario == "changed-late-prefix" {
				prefix[len(prefix)-1] = 'A'
			}
			putTransferTestFile(t, client, part, prefix)
			var resumed atomic.Bool
			m.emit = func(_ string, value any) {
				if event, ok := value.(map[string]any); ok && event["status"] == "resumed" {
					resumed.Store(true)
				}
			}
			if err := m.UploadFileWithPolicy("test", source, "/upload.bin", false); err != nil {
				t.Fatal(err)
			}
			if got := readTransferTestFile(t, client, "/upload.bin"); !bytes.Equal(got, contents) {
				t.Fatal("upload contains bytes from a different source")
			}
			if resumed.Load() != (scenario == "matching") {
				t.Fatalf("resumed = %v", resumed.Load())
			}
		})
	}
}

type saveFailureWriter struct {
	base           sftp.FileWriter
	denyTemp       atomic.Bool
	originalWrites atomic.Int32
}

func (w *saveFailureWriter) Filewrite(request *sftp.Request) (io.WriterAt, error) {
	if w.denyTemp.Load() {
		if strings.Contains(request.Filepath, ".gxshell-") {
			return nil, sftp.ErrSSHFxPermissionDenied
		}
		w.originalWrites.Add(1)
	}
	return w.base.Filewrite(request)
}

func TestRemoteSavePermissionFailurePreservesOriginal(t *testing.T) {
	handlers := sftp.InMemHandler()
	writer := &saveFailureWriter{base: handlers.FilePut}
	handlers.FilePut = writer
	m, client := newTransferTestManager(t, handlers)
	putTransferTestFile(t, client, "/document.txt", []byte("original"))
	writer.denyTemp.Store(true)
	if err := m.WriteRemoteFile("test", "/document.txt", []byte("changed")); !os.IsPermission(errors.Unwrap(err)) {
		t.Fatalf("expected wrapped permission error, got %v", err)
	}
	if got := readTransferTestFile(t, client, "/document.txt"); string(got) != "original" {
		t.Fatalf("original changed to %q", got)
	}
	if writer.originalWrites.Load() != 0 {
		t.Fatal("save attempted an in-place write")
	}
	if m.cache["test"] == nil {
		t.Fatal("permission failure invalidated a healthy SFTP client")
	}
}

func TestUploadRejectsSymlinkPartial(t *testing.T) {
	m, client := newTransferTestManager(t, sftp.InMemHandler())
	source := filepath.Join(t.TempDir(), "source.bin")
	if err := os.WriteFile(source, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(source)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := localSourceIdentity(source)
	if err != nil {
		t.Fatal(err)
	}
	part := remotePartPath("/destination.bin", resumeKey{source: identity, size: info.Size(), modTime: info.ModTime()})
	putTransferTestFile(t, client, "/original.bin", []byte("original"))
	if err := client.Symlink("/original.bin", part); err != nil {
		t.Fatal(err)
	}
	if err := m.UploadFileWithPolicy("test", source, "/destination.bin", false); !errors.Is(err, errInvalidTransferPart) {
		t.Fatalf("expected invalid partial error, got %v", err)
	}
	if got := readTransferTestFile(t, client, "/original.bin"); string(got) != "original" {
		t.Fatalf("symlink target changed to %q", got)
	}
	if m.cache["test"] == nil {
		t.Fatal("invalid partial invalidated a healthy SFTP client")
	}
}

func TestDownloadRejectsNonregularPartial(t *testing.T) {
	for _, kind := range []string{"directory", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			m, client := newTransferTestManager(t, sftp.InMemHandler())
			putTransferTestFile(t, client, "/source.bin", []byte("changed"))
			info, err := client.Stat("/source.bin")
			if err != nil {
				t.Fatal(err)
			}
			dir := t.TempDir()
			destination := filepath.Join(dir, "download.bin")
			original := filepath.Join(dir, "original.bin")
			if err := os.WriteFile(original, []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			job := &transferJob{sessionID: "test"}
			part := localPartPath(destination, resumeKey{source: job.remoteSourceIdentity("/source.bin"), size: info.Size(), modTime: info.ModTime()})
			if kind == "directory" {
				if err := os.Mkdir(part, 0700); err != nil {
					t.Fatal(err)
				}
			} else if err := os.Symlink(original, part); err != nil {
				t.Skipf("local symlinks unavailable: %v", err)
			}
			if err := m.DownloadFileWithPolicy("test", "/source.bin", destination, false); !errors.Is(err, errInvalidTransferPart) {
				t.Fatalf("expected invalid partial error, got %v", err)
			}
			if got, err := os.ReadFile(original); err != nil || string(got) != "original" {
				t.Fatalf("original changed: %q, %v", got, err)
			}
			if _, err := os.Stat(destination); !os.IsNotExist(err) {
				t.Fatalf("destination should not be created: %v", err)
			}
		})
	}
}

func TestResumeVerificationHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	job := &transferJob{ctx: ctx}
	reader := bytes.NewReader([]byte("prefix"))
	if _, err := verifyResumePrefix(job, reader, reader, 6); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
}

func TestConcurrentTransfersCannotSharePart(t *testing.T) {
	m, _ := newTransferTestManager(t, sftp.InMemHandler())
	first := m.beginTransfer("test", "/source", "download")
	second := m.beginTransfer("test", "/source", "download")
	defer m.finishTransfer(first, nil, 0, 0)
	defer m.finishTransfer(second, nil, 0, 0)
	if err := m.claimPart(first, "destination.part"); err != nil {
		t.Fatal(err)
	}
	err := m.claimPart(second, "destination.part")
	if !errors.Is(err, errTransferPartBusy) {
		t.Fatalf("expected busy partial error, got %v", err)
	}
	m.invalidateOnTransferErr("test", err)
	if m.cache["test"] == nil {
		t.Fatal("busy partial invalidated a healthy SFTP client")
	}
}

func TestConcurrentDownloadsRecognizePathAliases(t *testing.T) {
	for _, variant := range []string{"absolute", "cleaned", "case"} {
		t.Run(variant, func(t *testing.T) {
			if variant == "case" && runtime.GOOS != "windows" {
				t.Skip("case-insensitive local paths are a Windows policy")
			}
			part := "Download.bin.part"
			alias, err := filepath.Abs(part)
			if err != nil {
				t.Fatal(err)
			}
			if variant == "cleaned" {
				alias = "." + string(filepath.Separator) + part
			} else if variant == "case" {
				alias = strings.ToLower(part)
			}
			m, _ := newTransferTestManager(t, sftp.InMemHandler())
			first := m.beginTransfer("test", "/source", "download")
			second := m.beginTransfer("test", "/source", "download")
			defer m.finishTransfer(first, nil, 0, 0)
			defer m.finishTransfer(second, nil, 0, 0)
			if err := m.claimPart(first, part); err != nil {
				t.Fatal(err)
			}
			if err := m.claimPart(second, alias); !errors.Is(err, errTransferPartBusy) {
				t.Fatalf("path alias bypassed the active partial claim: %v", err)
			}
		})
	}
}

func TestCleanupKeepsPartClaimedAfterDirectorySnapshot(t *testing.T) {
	m, _ := newTransferTestManager(t, sftp.InMemHandler())
	target := filepath.Join(t.TempDir(), "download.bin")
	part := localPartPath(target, resumeKey{source: "old", size: 10, modTime: time.Now()})
	if err := os.WriteFile(part, []byte("partial"), 0600); err != nil {
		t.Fatal(err)
	}
	candidates := m.localRemovableParts(target, "")
	if len(candidates) != 1 {
		t.Fatalf("expected one abandoned part, got %v", candidates)
	}
	job := m.beginTransfer("test", "/source", "download")
	defer m.finishTransfer(job, nil, 0, 0)
	if err := m.claimPart(job, part); err != nil {
		t.Fatal(err)
	}
	for _, candidate := range candidates {
		if err := m.removeUnusedPart(candidate, "download", os.Remove); err != nil {
			t.Fatal(err)
		}
	}
	if got, err := os.ReadFile(part); err != nil || string(got) != "partial" {
		t.Fatalf("cleanup deleted a newly claimed part: %q, %v", got, err)
	}
}

func TestCleanupPreventsClaimsUntilDeletionFinishes(t *testing.T) {
	for _, direction := range []string{"upload", "download"} {
		t.Run(direction, func(t *testing.T) {
			m, _ := newTransferTestManager(t, sftp.InMemHandler())
			job := m.beginTransfer("test", "/source", direction)
			defer m.finishTransfer(job, nil, 0, 0)
			part := "destination.part"
			started, release := make(chan struct{}), make(chan struct{})
			finished := make(chan error, 1)
			go func() {
				finished <- m.removeUnusedPart(part, direction, func(string) error {
					close(started)
					<-release
					return os.ErrPermission
				})
			}()
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				close(release)
				t.Fatal("cleanup did not start")
			}
			claimed := make(chan error, 1)
			go func() { claimed <- m.claimPart(job, part) }()
			var claimErr error
			select {
			case claimErr = <-claimed:
			case <-time.After(5 * time.Second):
				close(release)
				t.Fatal("cleanup held the transfer lock during I/O")
			}
			close(release)
			if err := <-finished; !errors.Is(err, os.ErrPermission) {
				t.Fatalf("cleanup error was lost: %v", err)
			}
			if !errors.Is(claimErr, errTransferPartBusy) {
				t.Fatalf("claimed a file during deletion: %v", claimErr)
			}
			if err := m.claimPart(job, part); err != nil {
				t.Fatalf("failed cleanup did not release its reservation: %v", err)
			}
		})
	}
}
