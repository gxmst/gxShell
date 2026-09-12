package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDeploymentDocumentFormats(t *testing.T) {
	for _, name := range []string{"Dockerfile", "Dockerfile.prod", "Containerfile", "Makefile", ".env.production", ".gitignore", "settings.JSONC", "events.ndjson", "main.py", "index.html", "worker.ts"} {
		if !isSupportedTextPath(filepath.Join(t.TempDir(), name)) || !isRemoteSupportedTextPath("/srv/"+name) {
			t.Errorf("deployment file is not supported locally and remotely: %s", name)
		}
	}
	for _, name := range []string{"image.png", "program.exe", "report.docx", "archive.zip", "arbitrary-file"} {
		if isSupportedDocumentPath(name) || isRemoteSupportedDocumentPath(name) {
			t.Errorf("unsupported document accepted: %s", name)
		}
	}
}

func TestNamedDocumentLinksRetainFileAuthorization(t *testing.T) {
	a := NewApp()
	dir := t.TempDir()
	readme := filepath.Join(dir, "readme.md")
	dockerfile := filepath.Join(dir, "Dockerfile")
	for name, content := range map[string]string{readme: "# Deployment", dockerfile: "FROM scratch\n"} {
		if err := os.WriteFile(name, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := a.ReadLocalFile(dockerfile); err == nil {
		t.Fatal("unapproved named file is readable")
	}
	a.allowFile(readme)
	if _, err := a.ResolveLocalMarkdownLink(readme, "Dockerfile"); err != nil {
		t.Fatal(err)
	}
	if content, err := a.ReadLocalFile(dockerfile); err != nil || content != "FROM scratch\n" {
		t.Fatalf("read named document: %q %v", content, err)
	}
	if _, err := a.ReadLocalMarkdownResourceDataURL(readme, "Dockerfile"); err == nil {
		t.Fatal("document accepted as an image")
	}
	if _, err := a.ResolveLocalMarkdownLink(readme, "../Dockerfile"); err == nil {
		t.Fatal("parent traversal accepted")
	}
	if got, err := a.ResolveRemoteMarkdownLink("/srv/readme.md", "Dockerfile"); err != nil || got != "/srv/Dockerfile" {
		t.Fatalf("remote link: %q %v", got, err)
	}
	if _, err := a.ResolveRemoteMarkdownLink("/srv/readme.md", "../Dockerfile"); err == nil {
		t.Fatal("remote parent traversal accepted")
	}
}
