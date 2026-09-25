package sftpmanager

import (
	"testing"

	"gxShell/backend/types"

	"github.com/pkg/sftp"
)

// readdir reports a link as a link, so a directory link — which is how a
// published tree usually looks — arrived looking like a file. The browser then
// offered a download, the server answered SSH_FX_FAILURE, and the attempt left
// a zero-byte part file behind.
func TestListRemoteDirResolvesDirectoryLinks(t *testing.T) {
	m, client := newTransferTestManager(t, sftp.InMemHandler())
	if err := client.MkdirAll("/root/releases/2026-09-26"); err != nil {
		t.Fatal(err)
	}
	putTransferTestFile(t, client, "/root/releases/2026-09-26/app.conf", []byte("current"))
	putTransferTestFile(t, client, "/root/plain.txt", []byte("plain"))
	if err := client.Symlink("releases/2026-09-26", "/root/current"); err != nil {
		t.Fatal(err)
	}
	if err := client.Symlink("releases/2026-09-26/app.conf", "/root/current.conf"); err != nil {
		t.Fatal(err)
	}

	files, err := m.ListRemoteDir("test", "/root")
	if err != nil {
		t.Fatal(err)
	}
	byName := make(map[string]types.RemoteFile, len(files))
	for _, file := range files {
		byName[file.Name] = file
	}

	current, ok := byName["current"]
	if !ok {
		t.Fatal("directory link is missing from the listing")
	}
	if !current.IsLink || !current.IsDir {
		t.Errorf("directory link listed as isLink=%v isDir=%v, want true/true", current.IsLink, current.IsDir)
	}
	if current.LinkTarget != "releases/2026-09-26" {
		t.Errorf("directory link target = %q, want %q", current.LinkTarget, "releases/2026-09-26")
	}

	fileLink, ok := byName["current.conf"]
	if !ok {
		t.Fatal("file link is missing from the listing")
	}
	if !fileLink.IsLink || fileLink.IsDir {
		t.Errorf("file link listed as isLink=%v isDir=%v, want true/false", fileLink.IsLink, fileLink.IsDir)
	}
	// The link's own size is the length of the path it holds, which is not the
	// number anyone is comparing. The target's size is.
	if fileLink.Size != int64(len("current")) {
		t.Errorf("file link size = %d, want the target's %d", fileLink.Size, len("current"))
	}

	if plain := byName["plain.txt"]; plain.IsLink {
		t.Error("a regular file was reported as a link")
	}
	// A directory link sorts with the directories so the browser groups it the
	// way the server does.
	if files[0].Name != "current" {
		t.Errorf("first entry = %q, want the directory link %q", files[0].Name, "current")
	}
}

// A link whose target is gone is still a link. The row has to stay honest about
// that instead of silently losing the entry or claiming it is a file.
func TestListRemoteDirKeepsDanglingLinks(t *testing.T) {
	m, client := newTransferTestManager(t, sftp.InMemHandler())
	if err := client.MkdirAll("/root"); err != nil {
		t.Fatal(err)
	}
	if err := client.Symlink("gone.conf", "/root/dangling.conf"); err != nil {
		t.Fatal(err)
	}

	files, err := m.ListRemoteDir("test", "/root")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 {
		t.Fatalf("listing has %d entries, want the dangling link only", len(files))
	}
	link := files[0]
	if !link.IsLink {
		t.Error("dangling link was not reported as a link")
	}
	if link.IsDir {
		t.Error("dangling link was reported as a directory")
	}
	if link.LinkTarget != "gone.conf" {
		t.Errorf("dangling link target = %q, want %q", link.LinkTarget, "gone.conf")
	}
}
