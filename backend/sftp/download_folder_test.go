package sftpmanager

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/pkg/sftp"
)

// Junctions do not need the symbolic-link privilege on Windows, so the
// supported desktop platform always exercises this regression in CI.
func createDownloadDirectoryLink(link, target string) error {
	if runtime.GOOS == "windows" {
		command := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "New-Item -ItemType Junction -Path $env:GXSHELL_TEST_LINK -Target $env:GXSHELL_TEST_TARGET -ErrorAction Stop | Out-Null")
		command.Env = append(os.Environ(), "GXSHELL_TEST_LINK="+link, "GXSHELL_TEST_TARGET="+target)
		if output, err := command.CombinedOutput(); err != nil {
			return fmt.Errorf("create junction: %w: %s", err, output)
		}
		return nil
	}
	return os.Symlink(target, link)
}

func makeDownloadDirectoryLink(t *testing.T, link, target string) {
	t.Helper()
	if err := createDownloadDirectoryLink(link, target); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(link) })
}

type folderDownloadReadHook struct {
	base   sftp.FileReader
	before func() error
}

func (r folderDownloadReadHook) Fileread(request *sftp.Request) (io.ReaderAt, error) {
	if err := r.before(); err != nil {
		return nil, err
	}
	return r.base.Fileread(request)
}

func TestDownloadFolderRejectsDirectorySwapAfterWalking(t *testing.T) {
	destination, outside := t.TempDir(), t.TempDir()
	link := filepath.Join(destination, "nested")
	swapped := make(chan error, 1)
	handlers := sftp.InMemHandler()
	handlers.FileGet = folderDownloadReadHook{base: handlers.FileGet, before: func() error {
		err := os.Rename(link, link+"-original")
		if err == nil {
			err = createDownloadDirectoryLink(link, outside)
		}
		swapped <- err
		return err
	}}
	m, client := newTransferTestManager(t, handlers)
	if err := client.MkdirAll("/source/nested"); err != nil {
		t.Fatal(err)
	}
	putTransferTestFile(t, client, "/source/nested/file.txt", []byte("replacement"))
	victim := filepath.Join(outside, "file.txt")
	if err := os.WriteFile(victim, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(link) })
	if err := m.DownloadFolder("test", "/source", destination); err == nil {
		t.Error("download succeeded after its destination directory was replaced by an escaping link")
	}
	select {
	case err := <-swapped:
		if err != nil {
			t.Fatalf("directory swap failed: %v", err)
		}
	default:
		t.Fatal("download did not reach the directory swap")
	}
	got, err := os.ReadFile(victim)
	if err != nil || string(got) != "original" {
		t.Fatalf("outside file was changed: %q, %v", got, err)
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 1 {
		t.Fatalf("download left files outside destination: %v, %v", entries, err)
	}
}

func TestDownloadFolderRejectsEscapingDirectoryLink(t *testing.T) {
	m, client := newTransferTestManager(t, sftp.InMemHandler())
	if err := client.MkdirAll("/source/link/nested"); err != nil {
		t.Fatal(err)
	}
	putTransferTestFile(t, client, "/source/link/existing.txt", []byte("remote replacement"))
	putTransferTestFile(t, client, "/source/link/nested/new.txt", []byte("new file"))
	destination, outside := t.TempDir(), t.TempDir()
	victim := filepath.Join(outside, "existing.txt")
	if err := os.WriteFile(victim, []byte("original outside file"), 0600); err != nil {
		t.Fatal(err)
	}
	makeDownloadDirectoryLink(t, filepath.Join(destination, "link"), outside)
	if err := m.DownloadFolder("test", "/source", destination); err == nil {
		t.Error("download through an escaping directory link succeeded")
	}
	got, err := os.ReadFile(victim)
	if err != nil || string(got) != "original outside file" {
		t.Fatalf("outside file was changed: %q, %v", got, err)
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 1 {
		t.Fatalf("download created directories or temporary files outside destination: %v, %v", entries, err)
	}
}

func TestDownloadFolderRejectsWindowsNameCollisionsBeforeWriting(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows filename aliases")
	}
	for _, names := range [][]string{
		{"Foo.txt", "foo.txt"},
		{"Dir/a.txt", "dir/b.txt"},
		{"Foo.txt", "Foo.txt."},
		{"Foo.txt", "Foo.txt "},
	} {
		t.Run(names[1], func(t *testing.T) {
			m, client := newTransferTestManager(t, sftp.InMemHandler())
			if err := client.Mkdir("/source"); err != nil {
				t.Fatal(err)
			}
			putTransferTestFile(t, client, "/source/0-first.txt", []byte("replacement"))
			for _, name := range names {
				if err := client.MkdirAll(path.Dir("/source/" + name)); err != nil {
					t.Fatal(err)
				}
				putTransferTestFile(t, client, "/source/"+name, []byte(name))
			}
			destination := t.TempDir()
			first := filepath.Join(destination, "0-first.txt")
			if err := os.WriteFile(first, []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := m.DownloadFolder("test", "/source", destination); err == nil {
				t.Error("download with colliding names reported success")
			}
			got, err := os.ReadFile(first)
			if err != nil || string(got) != "original" {
				t.Fatalf("destination was changed before rejecting the collision: %q, %v", got, err)
			}
			entries, err := os.ReadDir(destination)
			if err != nil || len(entries) != 1 {
				t.Fatalf("name validation wrote destination entries: %v, %v", entries, err)
			}
		})
	}
}

func TestDownloadFolderCopiesNestedFilesAndReplacesRegularTargets(t *testing.T) {
	m, client := newTransferTestManager(t, sftp.InMemHandler())
	if err := client.MkdirAll("/source/nested/empty"); err != nil {
		t.Fatal(err)
	}
	putTransferTestFile(t, client, "/source/existing.txt", []byte("updated"))
	putTransferTestFile(t, client, "/source/nested/new.txt", []byte("new nested file"))
	destination := t.TempDir()
	if err := os.WriteFile(filepath.Join(destination, "existing.txt"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := m.DownloadFolder("test", "/source", destination); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"existing.txt": "updated", "nested/new.txt": "new nested file"} {
		got, err := os.ReadFile(filepath.Join(destination, filepath.FromSlash(name)))
		if err != nil || string(got) != want {
			t.Fatalf("downloaded %s = %q, %v", name, got, err)
		}
	}
	if info, err := os.Stat(filepath.Join(destination, "nested", "empty")); err != nil || !info.IsDir() {
		t.Fatalf("empty remote directory was not downloaded: %v", err)
	}
}

func TestDownloadFolderPreservesDistinctNamesOnLinux(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux case-sensitive filenames")
	}
	m, client := newTransferTestManager(t, sftp.InMemHandler())
	if err := client.Mkdir("/source"); err != nil {
		t.Fatal(err)
	}
	names := []string{"Foo.txt", "foo.txt", "Foo.txt.", "Foo.txt "}
	for _, name := range names {
		putTransferTestFile(t, client, "/source/"+name, []byte(name))
	}
	destination := t.TempDir()
	if err := m.DownloadFolder("test", "/source", destination); err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		got, err := os.ReadFile(filepath.Join(destination, name))
		if err != nil || string(got) != name {
			t.Fatalf("distinct file %q was not preserved: %q, %v", name, got, err)
		}
	}
}
