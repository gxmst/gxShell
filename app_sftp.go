package main

import (
	"fmt"
	"path"
	"path/filepath"
	"strings"

	"gxShell/backend/types"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// ListRemoteDir lists files in a remote directory via SFTP.
func (a *App) ListRemoteDir(sessionID string, remotePath string) ([]types.RemoteFile, error) {
	return a.sftp.ListRemoteDir(sessionID, remotePath)
}

// UploadFile uploads a local file to the remote server via SFTP.
func (a *App) UploadFile(sessionID, localPath, remotePath string) error {
	return a.sftp.UploadFile(sessionID, localPath, remotePath)
}

// DownloadFile downloads a remote file to the local filesystem via SFTP.
func (a *App) DownloadFile(sessionID, remotePath, localPath string) error {
	return a.sftp.DownloadFile(sessionID, remotePath, localPath)
}

// ReadRemoteMarkdownFile reads a remote Markdown file through the active SFTP
// session. It is intentionally Markdown-only and size-limited for viewer use.
func (a *App) ReadRemoteMarkdownFile(sessionID, remotePath string) (string, error) {
	remotePath = cleanRemoteMarkdownPath(remotePath)
	if !isRemoteMarkdownPath(remotePath) {
		return "", fmt.Errorf("remote file is not a Markdown file")
	}
	data, err := a.sftp.ReadRemoteFile(sessionID, remotePath, maxMarkdownFileSize)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// WriteRemoteMarkdownFile writes edited Markdown content back to the remote
// server. Non-Markdown paths and oversized content are rejected.
func (a *App) WriteRemoteMarkdownFile(sessionID, remotePath, content string) error {
	remotePath = cleanRemoteMarkdownPath(remotePath)
	if !isRemoteMarkdownPath(remotePath) {
		return fmt.Errorf("remote file is not a Markdown file")
	}
	if len(content) > maxMarkdownFileSize {
		return fmt.Errorf("content too large (max 5MB)")
	}
	return a.sftp.WriteRemoteFile(sessionID, remotePath, []byte(content))
}

// ListRemoteMarkdownFilesInDir lists .md siblings for a remote Markdown file.
func (a *App) ListRemoteMarkdownFilesInDir(sessionID, remotePath string) ([]string, error) {
	remotePath = cleanRemoteMarkdownPath(remotePath)
	if !isRemoteMarkdownPath(remotePath) {
		return nil, fmt.Errorf("remote file is not a Markdown file")
	}
	dir := path.Dir(remotePath)
	files, err := a.sftp.ListRemoteDir(sessionID, dir)
	if err != nil {
		return nil, err
	}
	result := make([]string, 0)
	for _, file := range files {
		if !file.IsDir && isRemoteMarkdownPath(file.Name) {
			result = append(result, path.Join(dir, file.Name))
		}
	}
	return result, nil
}

// ResolveRemoteMarkdownLink resolves a relative .md link from a remote Markdown
// file. It mirrors local link behavior but returns a remote POSIX path.
func (a *App) ResolveRemoteMarkdownLink(markdownPath string, href string) (string, error) {
	return resolveRemoteMarkdownRelativePath(markdownPath, href, map[string]bool{".md": true})
}

// ReadRemoteMarkdownResourceDataURL resolves a relative image from a remote
// Markdown file and returns it as a data URL for preview rendering.
func (a *App) ReadRemoteMarkdownResourceDataURL(sessionID, markdownPath, href string) (string, error) {
	target, err := resolveRemoteMarkdownRelativePath(markdownPath, href, supportedMarkdownImageExts())
	if err != nil {
		return "", err
	}
	data, err := a.sftp.ReadRemoteFile(sessionID, target, maxMarkdownResourceSize)
	if err != nil {
		return "", err
	}
	return markdownDataURL(target, data), nil
}

// DownloadFolder downloads a remote directory recursively via SFTP.
func (a *App) DownloadFolder(sessionID, remotePath, localDir string) error {
	return a.sftp.DownloadFolder(sessionID, remotePath, localDir)
}

// DeleteRemoteFile deletes a file or directory on the remote server via SFTP.
func (a *App) DeleteRemoteFile(sessionID, remotePath string) error {
	return a.sftp.DeleteRemoteFile(sessionID, remotePath)
}

// RenameRemoteFile renames or moves a remote file via SFTP.
func (a *App) RenameRemoteFile(sessionID, oldPath, newPath string) error {
	return a.sftp.RenameRemoteFile(sessionID, oldPath, newPath)
}

// CreateRemoteDir creates a directory on the remote server via SFTP.
func (a *App) CreateRemoteDir(sessionID, remotePath string) error {
	return a.sftp.CreateRemoteDir(sessionID, remotePath)
}

// SelectUploadFile opens a file dialog to select a file for upload.
func (a *App) SelectUploadFile() (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select file to upload",
	})
}

// SelectDownloadPath opens a save dialog to choose where to save a downloaded file.
func (a *App) SelectDownloadPath(defaultName string) (string, error) {
	return runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Save downloaded file",
		DefaultFilename: filepath.Base(defaultName),
	})
}

func resolveRemoteMarkdownRelativePath(markdownPath string, href string, allowedExts map[string]bool) (string, error) {
	base := cleanRemoteMarkdownPath(markdownPath)
	if !isRemoteMarkdownPath(base) {
		return "", fmt.Errorf("base file is not a Markdown file")
	}
	hrefPath, err := cleanMarkdownRelativeHref(href)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(hrefPath, "/") {
		return "", fmt.Errorf("only relative paths are supported")
	}
	rel := path.Clean(hrefPath)
	if rel == "." || rel == "" || rel == ".." || strings.HasPrefix(rel, "../") {
		return "", fmt.Errorf("path must stay inside the Markdown folder")
	}
	if len(allowedExts) > 0 && !allowedExts[strings.ToLower(path.Ext(rel))] {
		return "", fmt.Errorf("unsupported linked file type")
	}
	baseDir := path.Dir(base)
	target := path.Clean(path.Join(baseDir, rel))
	if baseDir == "." {
		return target, nil
	}
	prefix := baseDir
	if prefix != "/" {
		prefix += "/"
	}
	if target != baseDir && !strings.HasPrefix(target, prefix) {
		return "", fmt.Errorf("path must stay inside the Markdown folder")
	}
	return target, nil
}

func cleanRemoteMarkdownPath(p string) string {
	cleaned := path.Clean(strings.ReplaceAll(p, "\\", "/"))
	if cleaned == "." || cleaned == "" {
		return "."
	}
	return cleaned
}

func isRemoteMarkdownPath(p string) bool {
	return strings.EqualFold(path.Ext(p), ".md")
}
