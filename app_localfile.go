package main

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
	"gxShell/backend/types"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	maxTextFileSize         = 5 * 1024 * 1024
	maxMarkdownFileSize     = maxTextFileSize
	maxMarkdownResourceSize = 8 * 1024 * 1024
)

// ListLocalDir lists files in a local directory.
func (a *App) ListLocalDir(dir string) ([]types.LocalFile, error) {
	return localfs.ListDir(dir)
}

// LocalHomeDir returns the user's home directory path.
func (a *App) LocalHomeDir() string {
	return localfs.HomeDir()
}

// allowFile records that the user has genuinely chosen to open this path, so
// ReadLocalFile/WriteLocalFile may subsequently operate on it.
func (a *App) allowFile(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return ""
	}
	abs = filepath.Clean(abs)
	a.allowedFilesMu.Lock()
	a.allowedFiles[abs] = true
	a.allowedFilesMu.Unlock()
	return abs
}

// isFileAllowed reports whether path was previously authorized via allowFile.
func (a *App) isFileAllowed(absPath string) bool {
	a.allowedFilesMu.Lock()
	defer a.allowedFilesMu.Unlock()
	return a.allowedFiles[absPath]
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

// WriteLocalFile writes content to a local file, preserving its existing permissions.
func (a *App) WriteLocalFile(filePath string, content string) error {
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		return fmt.Errorf("invalid file path: %w", err)
	}
	absPath = filepath.Clean(absPath)
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

	if err := os.WriteFile(absPath, []byte(content), mode); err != nil {
		return fmt.Errorf("failed to write file: %w", err)
	}
	return nil
}

// OpenRecentTextFile re-authorizes a previously seen text path after a native
// confirmation. Recent paths are stored renderer-side, so this keeps the same
// user-consent boundary as a fresh file-open.
func (a *App) OpenRecentTextFile(filePath string) (string, error) {
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		return "", fmt.Errorf("invalid file path: %w", err)
	}
	absPath = filepath.Clean(absPath)
	if !isSupportedTextPath(absPath) {
		return "", fmt.Errorf("file is not a supported text file")
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return "", fmt.Errorf("file not found: %w", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("path is a directory, not a file")
	}
	if a.ctx != nil {
		a.nativeDialogMu.Lock()
		defer a.nativeDialogMu.Unlock()
		res, err := runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
			Type:          runtime.QuestionDialog,
			Title:         "Open recent text file",
			Message:       truncate(fmt.Sprintf("Open this recent text file?\n\n%s", absPath), 1200),
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

// SelectTextFile opens a file dialog to select a supported text file.
func (a *App) SelectTextFile() (string, error) {
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select text file",
		Filters: []runtime.FileFilter{
			{DisplayName: "Text Files", Pattern: supportedTextFileDialogPattern()},
			{DisplayName: "Markdown Files (*.md;*.markdown)", Pattern: "*.md;*.markdown"},
			{DisplayName: "Log/Text Files (*.log;*.txt)", Pattern: "*.log;*.txt"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil || path == "" {
		return path, err
	}
	if !isSupportedTextPath(path) {
		return "", fmt.Errorf("selected file is not a supported text file")
	}
	return a.allowFile(path), nil
}

// SelectMarkdownFile is kept for older frontend builds and preserves the
// original Markdown-only contract.
func (a *App) SelectMarkdownFile() (string, error) {
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
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

// ListTextFilesInDir lists supported text files in the same directory as the given file.
// The returned siblings are authorized for reading, matching the viewer's behavior
// of letting the user step between text files in the opened folder.
func (a *App) ListTextFilesInDir(filePath string) ([]string, error) {
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		return nil, fmt.Errorf("invalid file path: %w", err)
	}
	absPath = filepath.Clean(absPath)
	if !isSupportedTextPath(absPath) {
		return nil, fmt.Errorf("file is not a supported text file")
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
		if !entry.IsDir() && isSupportedTextPath(entry.Name()) {
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
