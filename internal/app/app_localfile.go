package app

// Local text/Markdown file access. All reads and writes are restricted to
// paths the user explicitly opened (see allowFile), so a compromised renderer
// cannot touch arbitrary files on disk.

import (
	"encoding/base64"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"gxShell/backend/localfs"
	sftpmanager "gxShell/backend/sftp"
	"gxShell/backend/types"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	maxTextFileSize         = 5 * 1024 * 1024
	maxMarkdownFileSize     = maxTextFileSize
	maxMarkdownResourceSize = 8 * 1024 * 1024
	maxPDFFileSize          = 50 * 1024 * 1024
)

// ListLocalDir lists files in a local directory.
//
// gxShell's own transfer temp files are filtered out for the same reason the
// remote listing drops them: a part file now survives a failed download so it
// can be resumed, and showing it invites the user to delete or open plumbing.
// The filter lives here rather than in localfs so that leaf package does not
// have to depend on the SFTP manager.
func (a *App) ListLocalDir(dir string) ([]types.LocalFile, error) {
	files, err := localfs.ListDir(dir)
	if err != nil {
		return nil, err
	}
	visible := make([]types.LocalFile, 0, len(files))
	for _, file := range files {
		if sftpmanager.IsTransferArtifact(file.Name) {
			continue
		}
		visible = append(visible, file)
	}
	return visible, nil
}

// LocalHomeDir returns the user's home directory path.
func (a *App) LocalHomeDir() string {
	return localfs.HomeDir()
}

// allowFile records that the user has genuinely chosen to open this path, so
// ReadLocalFile/WriteLocalFile may subsequently operate on it. The state and
// path normalization live in allowedFileSet; this stays a method so callers
// across the app read naturally.
func (a *App) allowFile(path string) string {
	return a.allowedFiles.allow(path)
}

// isFileAllowed reports whether path was previously authorized via allowFile.
func (a *App) isFileAllowed(absPath string) bool {
	return a.allowedFiles.contains(absPath)
}

// ReadLocalFile reads a local file and returns its content. Only files the user
// has explicitly opened (see allowFile) may be read, so a compromised renderer
// cannot exfiltrate arbitrary files from disk.
func (a *App) ReadLocalFile(filePath string) (string, error) {
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		return "", fmt.Errorf("invalid file path: %w", err)
	}
	absPath = filepath.Clean(absPath)
	if !isSupportedTextPath(absPath) {
		return "", fmt.Errorf("file is not a supported text file")
	}
	if !a.isFileAllowed(absPath) {
		return "", fmt.Errorf("access denied: file was not opened by the user")
	}

	info, err := os.Stat(absPath)
	if err != nil {
		return "", fmt.Errorf("file not found: %w", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("path is a directory, not a file")
	}

	if info.Size() > maxTextFileSize {
		return "", fmt.Errorf("file too large (max 5MB)")
	}

	data, err := os.ReadFile(absPath)
	if err != nil {
		return "", fmt.Errorf("failed to read file: %w", err)
	}

	return string(data), nil
}

// ReadLocalPDFBase64 returns an explicitly opened local PDF for a read-only
// Blob URL consumed by WebView2's built-in PDF viewer. PDF bytes never pass
// through the text editor or its write path.
func (a *App) ReadLocalPDFBase64(filePath string) (string, error) {
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		return "", fmt.Errorf("invalid file path: %w", err)
	}
	absPath = filepath.Clean(absPath)
	if !isPDFPath(absPath) {
		return "", fmt.Errorf("file is not a PDF")
	}
	if !a.isFileAllowed(absPath) {
		return "", fmt.Errorf("access denied: file was not opened by the user")
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return "", fmt.Errorf("file not found: %w", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("path is a directory, not a file")
	}
	if info.Size() > maxPDFFileSize {
		return "", fmt.Errorf("PDF is too large (max 50MB)")
	}
	data, err := os.ReadFile(absPath)
	if err != nil {
		return "", fmt.Errorf("failed to read PDF: %w", err)
	}
	if len(data) < 5 || string(data[:5]) != "%PDF-" {
		return "", fmt.Errorf("file does not contain a valid PDF header")
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

// WriteLocalFile writes content to a local file, preserving its existing permissions.
func (a *App) WriteLocalFile(filePath string, content string) error {
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		return fmt.Errorf("invalid file path: %w", err)
	}
	absPath = filepath.Clean(absPath)
	if !isSupportedTextPath(absPath) {
		return fmt.Errorf("file is not a supported text file")
	}
	// Writing is only permitted to a path the user already opened. We never
	// auto-allow on write, so the renderer cannot overwrite an arbitrary file.
	if !a.isFileAllowed(absPath) {
		return fmt.Errorf("access denied: file was not opened by the user")
	}

	if len(content) > maxTextFileSize {
		return fmt.Errorf("content too large (max 5MB)")
	}

	// Preserve existing file mode when the file already exists.
	mode := os.FileMode(0644)
	if info, statErr := os.Stat(absPath); statErr == nil {
		if info.IsDir() {
			return fmt.Errorf("path is a directory, not a file")
		}
		mode = info.Mode().Perm()
	}

	// This is the local editor's save path: write a sibling temp file and
	// rename it over the original, mirroring the SFTP editor save. An in-place
	// truncating write would destroy the document if the app or machine died
	// mid-write.
	tmp, err := os.CreateTemp(filepath.Dir(absPath), "."+filepath.Base(absPath)+".gxshell-*.tmp")
	if err != nil {
		return fmt.Errorf("failed to create temporary file: %w", err)
	}
	tmpPath := tmp.Name()
	removeTemp := true
	defer func() {
		_ = tmp.Close()
		if removeTemp {
			_ = os.Remove(tmpPath)
		}
	}()
	if err := tmp.Chmod(mode); err != nil {
		return fmt.Errorf("failed to set temporary file mode: %w", err)
	}
	if _, err := tmp.WriteString(content); err != nil {
		return fmt.Errorf("failed to write file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("failed to flush file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("failed to close temporary file: %w", err)
	}
	if err := replaceLocalFile(tmpPath, absPath); err != nil {
		return fmt.Errorf("failed to write file: %w", err)
	}
	removeTemp = false
	return nil
}

// replaceLocalFile promotes a fully written sibling temp file over target.
// os.Rename replaces the destination atomically where the platform allows it.
// Where it does not (e.g. Windows with the destination held open elsewhere),
// move the original aside and restore it if the promotion fails, so a failed
// save never leaves a truncated document.
func replaceLocalFile(tmpPath, target string) error {
	if err := os.Rename(tmpPath, target); err == nil {
		return nil
	} else if _, statErr := os.Stat(target); statErr != nil {
		return err
	}

	// tmpPath was created with CreateTemp, so this sibling name is unique and
	// does not collide with a user-owned fixed .gxshell-bak file.
	backupPath := tmpPath + ".bak"
	if err := os.Rename(target, backupPath); err != nil {
		return fmt.Errorf("prepare existing file for replace: %w", err)
	}
	if err := os.Rename(tmpPath, target); err != nil {
		if restoreErr := os.Rename(backupPath, target); restoreErr != nil {
			return fmt.Errorf("replace file: %v; restore original: %w", err, restoreErr)
		}
		return fmt.Errorf("replace file: %w", err)
	}
	_ = os.Remove(backupPath)
	return nil
}

// OpenRecentTextFile re-authorizes a previously seen document path after a native
// confirmation. Recent paths are stored renderer-side, so this keeps the same
// user-consent boundary as a fresh file-open.
func (a *App) OpenRecentTextFile(filePath string) (string, error) {
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		return "", fmt.Errorf("invalid file path: %w", err)
	}
	absPath = filepath.Clean(absPath)
	if !isSupportedDocumentPath(absPath) {
		return "", fmt.Errorf("file is not a supported document")
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return "", fmt.Errorf("file not found: %w", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("path is a directory, not a file")
	}
	if ctx := a.ctx.Get(); ctx != nil {
		a.nativeDialogMu.Lock()
		defer a.nativeDialogMu.Unlock()
		res, err := runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
			Type:          runtime.QuestionDialog,
			Title:         "Open recent document",
			Message:       truncate(fmt.Sprintf("Open this recent document?\n\n%s", absPath), 1200),
			Buttons:       []string{"Open", "Cancel"},
			DefaultButton: "Cancel",
			CancelButton:  "Cancel",
		})
		if err != nil {
			return "", err
		}
		if res != "Open" && res != "Yes" {
			return "", fmt.Errorf("user cancelled open")
		}
	}
	return a.allowFile(absPath), nil
}

// RestoreTextFiles re-authorizes the small set of local documents that were
// open when this personal workspace last closed. Invalid or stale entries are
// ignored so startup remains silent and resilient.
func (a *App) RestoreTextFiles(paths []string) []string {
	if len(paths) > 30 {
		paths = paths[:30]
	}
	restored := make([]string, 0, len(paths))
	seen := make(map[string]bool, len(paths))
	for _, filePath := range paths {
		absPath, err := filepath.Abs(filePath)
		if err != nil {
			continue
		}
		absPath = filepath.Clean(absPath)
		key := strings.ToLower(absPath)
		if seen[key] || !isSupportedDocumentPath(absPath) {
			continue
		}
		info, err := os.Stat(absPath)
		if err != nil || info.IsDir() {
			continue
		}
		seen[key] = true
		restored = append(restored, a.allowFile(absPath))
	}
	return restored
}

// OpenRecentMarkdownFile is kept for older frontend builds and preserves the
// original Markdown-only contract.
func (a *App) OpenRecentMarkdownFile(filePath string) (string, error) {
	if !isMarkdownPath(filePath) {
		return "", fmt.Errorf("file is not a Markdown file")
	}
	return a.OpenRecentTextFile(filePath)
}

// ResolveLocalMarkdownLink resolves and authorizes a relative .md link from an
// already opened Markdown file. Links may point inside the opened file's folder
// tree, but never above it.
func (a *App) ResolveLocalMarkdownLink(markdownPath string, href string) (string, error) {
	target, err := a.resolveLocalMarkdownRelativePath(markdownPath, href, supportedTextFileExts())
	if err != nil {
		return "", err
	}
	info, err := os.Stat(target)
	if err != nil {
		return "", fmt.Errorf("linked file not found: %w", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("linked path is a directory")
	}
	return a.allowFile(target), nil
}

// ReadLocalMarkdownResourceDataURL reads a relative image used by an opened
// Markdown file and returns it as a data URL for the sanitized renderer.
func (a *App) ReadLocalMarkdownResourceDataURL(markdownPath string, href string) (string, error) {
	target, err := a.resolveLocalMarkdownRelativePath(markdownPath, href, supportedMarkdownImageExts())
	if err != nil {
		return "", err
	}
	info, err := os.Stat(target)
	if err != nil {
		return "", fmt.Errorf("resource not found: %w", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("resource path is a directory")
	}
	if info.Size() > maxMarkdownResourceSize {
		return "", fmt.Errorf("resource too large (max 8MB)")
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return "", fmt.Errorf("failed to read resource: %w", err)
	}
	return markdownDataURL(target, data), nil
}

// SelectTextFile opens a file dialog to select a supported text document or PDF.
func (a *App) SelectTextFile() (string, error) {
	path, err := runtime.OpenFileDialog(a.ctx.Get(), runtime.OpenDialogOptions{
		Title: "Select document",
		Filters: []runtime.FileFilter{
			{DisplayName: "Documents", Pattern: supportedDocumentFileDialogPattern()},
			{DisplayName: "PDF Files (*.pdf)", Pattern: "*.pdf"},
			{DisplayName: "Text Files", Pattern: supportedTextFileDialogPattern()},
			{DisplayName: "Markdown Files (*.md;*.markdown)", Pattern: "*.md;*.markdown"},
			{DisplayName: "Log/Text Files (*.log;*.txt)", Pattern: "*.log;*.txt"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil || path == "" {
		return path, err
	}
	if !isSupportedDocumentPath(path) {
		return "", fmt.Errorf("selected file is not a supported document")
	}
	return a.allowFile(path), nil
}

// SelectMarkdownFile is kept for older frontend builds and preserves the
// original Markdown-only contract.
func (a *App) SelectMarkdownFile() (string, error) {
	path, err := runtime.OpenFileDialog(a.ctx.Get(), runtime.OpenDialogOptions{
		Title: "Select Markdown file",
		Filters: []runtime.FileFilter{
			{DisplayName: "Markdown Files (*.md;*.markdown)", Pattern: "*.md;*.markdown"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil || path == "" {
		return path, err
	}
	if !isMarkdownPath(path) {
		return "", fmt.Errorf("selected file is not a Markdown file")
	}
	return a.allowFile(path), nil
}

// ListTextFilesInDir lists supported documents in the same directory as the given file.
// The returned siblings are authorized for reading, matching the viewer's behavior
// of letting the user step between documents in the opened folder.
func (a *App) ListTextFilesInDir(filePath string) ([]string, error) {
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		return nil, fmt.Errorf("invalid file path: %w", err)
	}
	absPath = filepath.Clean(absPath)
	if !isSupportedDocumentPath(absPath) {
		return nil, fmt.Errorf("file is not a supported document")
	}
	if !a.isFileAllowed(absPath) {
		return nil, fmt.Errorf("access denied: file was not opened by the user")
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return nil, fmt.Errorf("file not found: %w", err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("path is a directory, not a file")
	}

	dir := filepath.Dir(absPath)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	var textFiles []string
	for _, entry := range entries {
		if !entry.IsDir() && isSupportedDocumentPath(entry.Name()) {
			full := filepath.Join(dir, entry.Name())
			a.allowFile(full)
			textFiles = append(textFiles, full)
		}
	}
	return textFiles, nil
}

// ListMarkdownFilesInDir is kept for older frontend builds and preserves the
// original Markdown-only sibling list.
func (a *App) ListMarkdownFilesInDir(filePath string) ([]string, error) {
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		return nil, fmt.Errorf("invalid file path: %w", err)
	}
	absPath = filepath.Clean(absPath)
	if !isMarkdownPath(absPath) {
		return nil, fmt.Errorf("file is not a Markdown file")
	}
	if !a.isFileAllowed(absPath) {
		return nil, fmt.Errorf("access denied: file was not opened by the user")
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return nil, fmt.Errorf("file not found: %w", err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("path is a directory, not a file")
	}

	dir := filepath.Dir(absPath)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	var mdFiles []string
	for _, entry := range entries {
		if !entry.IsDir() && isMarkdownPath(entry.Name()) {
			full := filepath.Join(dir, entry.Name())
			a.allowFile(full)
			mdFiles = append(mdFiles, full)
		}
	}
	return mdFiles, nil
}

func isMarkdownPath(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return ext == ".md" || ext == ".markdown"
}

func isSupportedTextPath(path string) bool {
	return supportedTextFileExts()[strings.ToLower(filepath.Ext(path))]
}

func isPDFPath(path string) bool {
	return strings.EqualFold(filepath.Ext(path), ".pdf")
}

func isSupportedDocumentPath(path string) bool {
	return isSupportedTextPath(path) || isPDFPath(path)
}

func supportedDocumentFileDialogPattern() string {
	return supportedTextFileDialogPattern() + ";*.pdf"
}

func supportedDocumentFileExtensionList() []string {
	return append(supportedTextFileExtensionList(), ".pdf")
}

func supportedTextFileDialogPattern() string {
	patterns := make([]string, 0, len(supportedTextFileExtensionList()))
	for _, ext := range supportedTextFileExtensionList() {
		patterns = append(patterns, "*"+ext)
	}
	return strings.Join(patterns, ";")
}

func supportedTextFileExtensionList() []string {
	return []string{
		".md", ".markdown", ".txt", ".text", ".log",
		".conf", ".cfg", ".ini", ".env",
		".json", ".jsonl", ".yaml", ".yml", ".toml", ".xml",
		".csv", ".tsv",
		".sh", ".bash", ".zsh", ".fish",
		".ps1", ".bat", ".cmd", ".sql", ".service",
	}
}

func supportedTextFileExts() map[string]bool {
	exts := map[string]bool{}
	for _, ext := range supportedTextFileExtensionList() {
		exts[ext] = true
	}
	return exts
}

func (a *App) resolveLocalMarkdownRelativePath(markdownPath string, href string, allowedExts map[string]bool) (string, error) {
	absBase, err := filepath.Abs(markdownPath)
	if err != nil {
		return "", fmt.Errorf("invalid markdown path: %w", err)
	}
	absBase = filepath.Clean(absBase)
	if !isMarkdownPath(absBase) {
		return "", fmt.Errorf("base file is not a Markdown file")
	}
	if !a.isFileAllowed(absBase) {
		return "", fmt.Errorf("access denied: base file was not opened by the user")
	}

	hrefPath, err := cleanMarkdownRelativeHref(href)
	if err != nil {
		return "", err
	}
	if filepath.IsAbs(hrefPath) || filepath.VolumeName(hrefPath) != "" {
		return "", fmt.Errorf("only relative paths are supported")
	}
	rel := filepath.Clean(filepath.FromSlash(hrefPath))
	if rel == "." || rel == "" || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("path must stay inside the Markdown folder")
	}
	if !isAllowedMarkdownExt(rel, allowedExts) {
		return "", fmt.Errorf("unsupported linked file type")
	}

	baseDir := filepath.Dir(absBase)
	target := filepath.Clean(filepath.Join(baseDir, rel))
	if !pathWithinDir(target, baseDir) {
		return "", fmt.Errorf("path must stay inside the Markdown folder")
	}
	if !realPathWithinDir(target, baseDir) {
		return "", fmt.Errorf("path resolves outside the Markdown folder")
	}
	return target, nil
}

func cleanMarkdownRelativeHref(raw string) (string, error) {
	href := strings.TrimSpace(raw)
	if href == "" || strings.HasPrefix(href, "#") {
		return "", fmt.Errorf("empty relative path")
	}
	if idx := strings.Index(href, "#"); idx >= 0 {
		href = href[:idx]
	}
	if idx := strings.Index(href, "?"); idx >= 0 {
		href = href[:idx]
	}
	if href == "" {
		return "", fmt.Errorf("empty relative path")
	}
	parsed, err := url.Parse(href)
	if err == nil && parsed.Scheme != "" {
		return "", fmt.Errorf("external URLs are not local files")
	}
	if err == nil && parsed.Host != "" {
		return "", fmt.Errorf("external URLs are not local files")
	}
	if strings.HasPrefix(href, "/") || strings.HasPrefix(href, "\\") {
		return "", fmt.Errorf("only relative paths are supported")
	}
	if decoded, err := url.PathUnescape(href); err == nil {
		href = decoded
	}
	if strings.HasPrefix(href, "/") || strings.HasPrefix(href, "\\") {
		return "", fmt.Errorf("only relative paths are supported")
	}
	href = strings.ReplaceAll(href, "\\", "/")
	cleaned := pathCleanSlash(href)
	if cleaned == "." || cleaned == "" || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("path must stay inside the Markdown folder")
	}
	return cleaned, nil
}

func pathCleanSlash(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	for strings.Contains(p, "//") {
		p = strings.ReplaceAll(p, "//", "/")
	}
	parts := strings.Split(p, "/")
	stack := make([]string, 0, len(parts))
	for _, part := range parts {
		switch part {
		case "", ".":
			continue
		case "..":
			if len(stack) == 0 {
				return "../" + strings.Join(parts, "/")
			}
			stack = stack[:len(stack)-1]
		default:
			stack = append(stack, part)
		}
	}
	return strings.Join(stack, "/")
}

func pathWithinDir(target string, dir string) bool {
	target = filepath.Clean(target)
	dir = filepath.Clean(dir)
	if target == dir {
		return true
	}
	prefix := dir + string(os.PathSeparator)
	return strings.HasPrefix(target, prefix)
}

func realPathWithinDir(target string, dir string) bool {
	realTarget, targetErr := filepath.EvalSymlinks(target)
	realDir, dirErr := filepath.EvalSymlinks(dir)
	if targetErr != nil || dirErr != nil {
		return pathWithinDir(target, dir)
	}
	return pathWithinDir(realTarget, realDir)
}

func supportedMarkdownImageExts() map[string]bool {
	return map[string]bool{
		".png": true, ".jpg": true, ".jpeg": true, ".gif": true,
		".webp": true, ".bmp": true, ".svg": true,
	}
}

func isAllowedMarkdownExt(p string, allowedExts map[string]bool) bool {
	if len(allowedExts) == 0 {
		return true
	}
	return allowedExts[strings.ToLower(filepath.Ext(p))]
}

func markdownDataURL(name string, data []byte) string {
	mimeType := mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
	if mimeType == "" {
		mimeType = http.DetectContentType(data)
	}
	return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(data)
}
