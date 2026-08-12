package app

import (
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
)

const localPDFAssetPath = "/__gxshell/document/pdf"

// DocumentAssetHandler streams large local documents through Wails' asset
// server. It is a package-level factory rather than an App method so it never
// becomes part of the webview's generated binding surface.
func DocumentAssetHandler(a *App) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != localPDFAssetPath {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		file, info, err := a.openAuthorizedPDF(r.URL.Query().Get("path"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		defer file.Close()

		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": filepath.Base(info.Name())}))
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeContent(w, r, info.Name(), info.ModTime(), file)
	})
}

func (a *App) openAuthorizedPDF(filePath string) (*os.File, os.FileInfo, error) {
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		return nil, nil, fmt.Errorf("invalid file path")
	}
	absPath = filepath.Clean(absPath)
	if !isPDFPath(absPath) || !a.isFileAllowed(absPath) {
		return nil, nil, fmt.Errorf("access denied")
	}
	file, err := os.Open(absPath)
	if err != nil {
		return nil, nil, fmt.Errorf("file not found")
	}
	info, err := file.Stat()
	if err != nil || info.IsDir() || info.Size() > maxPDFFileSize {
		file.Close()
		return nil, nil, fmt.Errorf("invalid PDF")
	}
	var header [5]byte
	if _, err := file.ReadAt(header[:], 0); err != nil || string(header[:]) != "%PDF-" {
		file.Close()
		return nil, nil, fmt.Errorf("invalid PDF")
	}
	if _, err := file.Seek(0, 0); err != nil {
		file.Close()
		return nil, nil, fmt.Errorf("failed to open PDF")
	}
	return file, info, nil
}
