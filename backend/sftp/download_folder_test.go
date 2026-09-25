package sftpmanager

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"gxShell/backend/types"

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
	if _, err := m.DownloadFolder("test", "/source", destination); err == nil {
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
	if _, err := m.DownloadFolder("test", "/source", destination); err == nil {
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
			if _, err := m.DownloadFolder("test", "/source", destination); err == nil {
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
	if _, err := m.DownloadFolder("test", "/source", destination); err != nil {
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
	if _, err := m.DownloadFolder("test", "/source", destination); err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		got, err := os.ReadFile(filepath.Join(destination, name))
		if err != nil || string(got) != name {
			t.Fatalf("distinct file %q was not preserved: %q, %v", name, got, err)
		}
	}
}

// folderDownloadListHook fails the listing of one remote directory, which is
// what a server does for a directory the login user cannot read. It stays
// disarmed while the test builds the tree, because MkdirAll stats the paths it
// creates.
type folderDownloadListHook struct {
	base   sftp.FileLister
	failOn string
	armed  *atomic.Bool
}

func (l folderDownloadListHook) Filelist(request *sftp.Request) (sftp.ListerAt, error) {
	if l.armed != nil && l.armed.Load() && request.Filepath == l.failOn {
		return nil, os.ErrPermission
	}
	return l.base.Filelist(request)
}

// A backup of /etc/nginx that silently omits sites-enabled is not a backup.
// Links are not followed, so they have to be reported instead.
func TestDownloadFolderReportsSkippedSymlinks(t *testing.T) {
	m, client := newTransferTestManager(t, sftp.InMemHandler())
	if err := client.MkdirAll("/source/sites-available"); err != nil {
		t.Fatal(err)
	}
	putTransferTestFile(t, client, "/source/nginx.conf", []byte("server {}"))
	putTransferTestFile(t, client, "/source/sites-available/default", []byte("site"))
	if err := client.Symlink("sites-available", "/source/sites-enabled"); err != nil {
		t.Fatal(err)
	}
	if err := client.Symlink("nginx.conf", "/source/nginx.conf.bak"); err != nil {
		t.Fatal(err)
	}

	destination := t.TempDir()
	result, err := m.DownloadFolder("test", "/source", destination)
	if err != nil {
		t.Fatal(err)
	}
	reasons := make(map[string]string, len(result.Skipped))
	for _, skip := range result.Skipped {
		reasons[skip.Path] = skip.Reason
	}
	for _, want := range []string{"/source/sites-enabled", "/source/nginx.conf.bak"} {
		if reasons[want] != types.FolderDownloadSkipSymlink {
			t.Errorf("link %s was not reported as skipped: %+v", want, result.Skipped)
		}
	}
	if result.Files != 2 {
		t.Errorf("downloaded %d files, want 2", result.Files)
	}
	// Skipping has to mean skipping: a link must not turn into an empty
	// directory or a copy of its target on the local side.
	for _, name := range []string{"sites-enabled", "nginx.conf.bak"} {
		if _, err := os.Lstat(filepath.Join(destination, name)); !os.IsNotExist(err) {
			t.Errorf("skipped link %s was materialised locally (err=%v)", name, err)
		}
	}
	if got, err := os.ReadFile(filepath.Join(destination, "sites-available", "default")); err != nil || string(got) != "site" {
		t.Fatalf("the link's target was not downloaded: %q, %v", got, err)
	}
}

// One unreadable directory used to fail the whole download, and the error did
// not even say which one it was.
func TestDownloadFolderKeepsGoingPastAnUnreadableDirectory(t *testing.T) {
	armed := &atomic.Bool{}
	handlers := sftp.InMemHandler()
	handlers.FileList = folderDownloadListHook{base: handlers.FileList, failOn: "/source/secret", armed: armed}
	m, client := newTransferTestManager(t, handlers)
	if err := client.MkdirAll("/source"); err != nil {
		t.Fatal(err)
	}
	if err := client.Mkdir("/source/secret"); err != nil {
		t.Fatal(err)
	}
	putTransferTestFile(t, client, "/source/secret/hidden.txt", []byte("hidden"))
	putTransferTestFile(t, client, "/source/public.txt", []byte("public"))
	armed.Store(true)

	destination := t.TempDir()
	result, err := m.DownloadFolder("test", "/source", destination)
	if err != nil {
		t.Fatalf("one unreadable directory failed the whole download: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(destination, "public.txt")); err != nil || string(got) != "public" {
		t.Fatalf("readable file was not downloaded: %q, %v", got, err)
	}
	if len(result.Skipped) != 1 || result.Skipped[0].Path != "/source/secret" {
		t.Fatalf("skipped entries = %+v, want the unreadable directory", result.Skipped)
	}
	if result.Skipped[0].Reason != types.FolderDownloadSkipUnreadable {
		t.Errorf("skip reason = %q, want %q", result.Skipped[0].Reason, types.FolderDownloadSkipUnreadable)
	}
	if result.Skipped[0].Detail == "" {
		t.Error("skip entry carries no server message")
	}
	// The directory itself is still there, so the local tree shows where the
	// hole is instead of hiding it.
	if info, err := os.Stat(filepath.Join(destination, "secret")); err != nil || !info.IsDir() {
		t.Fatalf("unreadable directory was not created locally: %v", err)
	}
}

// A local failure is not the server refusing one entry: every remaining file
// would fail the same way, so the download stops and names the file.
func TestDownloadFolderNamesTheFileItCouldNotWrite(t *testing.T) {
	m, client := newTransferTestManager(t, sftp.InMemHandler())
	if err := client.MkdirAll("/source"); err != nil {
		t.Fatal(err)
	}
	putTransferTestFile(t, client, "/source/blocked.txt", []byte("data"))

	destination := t.TempDir()
	// A local directory where the file belongs.
	if err := os.Mkdir(filepath.Join(destination, "blocked.txt"), 0755); err != nil {
		t.Fatal(err)
	}
	_, err := m.DownloadFolder("test", "/source", destination)
	if err == nil {
		t.Fatal("download reported success while a local destination blocked it")
	}
	if !strings.Contains(err.Error(), "/source/blocked.txt") {
		t.Fatalf("error does not name the remote path that failed: %v", err)
	}
}

// A directory link is how a tree is usually published, so the folder the user
// picks may well be one.
func TestDownloadFolderFollowsADirectoryLinkAtTheRoot(t *testing.T) {
	m, client := newTransferTestManager(t, sftp.InMemHandler())
	if err := client.MkdirAll("/releases/2026-09-26"); err != nil {
		t.Fatal(err)
	}
	putTransferTestFile(t, client, "/releases/2026-09-26/app.conf", []byte("current"))
	if err := client.Symlink("releases/2026-09-26", "/current"); err != nil {
		t.Fatal(err)
	}

	destination := t.TempDir()
	result, err := m.DownloadFolder("test", "/current", destination)
	if err != nil {
		t.Fatal(err)
	}
	if result.Files != 1 {
		t.Errorf("downloaded %d files through the root link, want 1", result.Files)
	}
	if got, err := os.ReadFile(filepath.Join(destination, "app.conf")); err != nil || string(got) != "current" {
		t.Fatalf("app.conf = %q, %v", got, err)
	}
}

// A link chain longer than the resolver will follow is a loop or a mistake, and
// walking it would spin forever.
func TestDownloadFolderRejectsALoopAtTheRoot(t *testing.T) {
	m, client := newTransferTestManager(t, sftp.InMemHandler())
	if err := client.MkdirAll("/source"); err != nil {
		t.Fatal(err)
	}
	if err := client.Symlink("/source/loop", "/source/loop"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.DownloadFolder("test", "/source/loop", t.TempDir()); err == nil {
		t.Fatal("a self-referential root link was accepted as a directory")
	}
}
