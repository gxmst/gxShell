package app

import (
	"fmt"
	"io"
	"os"
	"unicode/utf8"
)

const documentNotText = "GX_DOCUMENT_NOT_TEXT"

// Filenames identify supported document types, not their encoding. Reject
// binary/legacy-encoded bytes before JSON serialization can replace invalid
// UTF-8, and repeat this check before saving over an existing document.
func validateTextDocument(data []byte) error {
	if !utf8.Valid(data) {
		return fmt.Errorf("%s: only UTF-8 text can be edited", documentNotText)
	}
	for _, b := range data {
		if b < 0x20 && b != '\t' && b != '\n' && b != '\r' && b != '\f' && b != '\b' && b != 0x1b {
			return fmt.Errorf("%s: binary content cannot be edited", documentNotText)
		}
	}
	return nil
}

func openRegularDocument(root *os.Root, name string) (*os.File, os.FileInfo, error) {
	before, err := root.Lstat(name)
	if err != nil {
		return nil, nil, err
	}
	if !before.Mode().IsRegular() {
		return nil, nil, fmt.Errorf("document must be a regular file, not a link or special file")
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(before, info) {
		file.Close()
		return nil, nil, fmt.Errorf("document changed while opening; try again")
	}
	return file, info, nil
}

func readRegularDocument(root *os.Root, name string, limit int64) ([]byte, os.FileInfo, error) {
	file, info, err := openRegularDocument(root, name)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	if info.Size() > limit {
		return nil, nil, fmt.Errorf("file too large (max %dMB)", limit/(1024*1024))
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, nil, err
	}
	if int64(len(data)) > limit {
		return nil, nil, fmt.Errorf("file too large (max %dMB)", limit/(1024*1024))
	}
	return data, info, nil
}

// All paths are relative to one authorized directory handle. In particular,
// the Windows replacement fallback must not resolve an absolute parent again.
func replaceDocumentFile(root *os.Root, temporary, target string) error {
	if err := root.Rename(temporary, target); err == nil {
		return nil
	} else if _, statErr := root.Lstat(target); statErr != nil {
		return err
	}
	backup := temporary + ".bak"
	if err := root.Rename(target, backup); err != nil {
		return fmt.Errorf("prepare existing file for replace: %w", err)
	}
	if err := root.Rename(temporary, target); err != nil {
		if restoreErr := root.Rename(backup, target); restoreErr != nil {
			return fmt.Errorf("replace failed: %v; original retained at %s: %w", err, backup, restoreErr)
		}
		return err
	}
	// The replacement is committed; a leftover temporary backup must not make
	// the editor report that the saved document is still unwritten.
	_ = root.Remove(backup)
	return nil
}
