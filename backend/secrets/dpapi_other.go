//go:build !windows

package secrets

// On non-Windows platforms there is no DPAPI; the key file is protected by the
// keyring (primary path) and filesystem permissions (fallback path). protect and
// unprotect are identity functions so the on-disk format is platform-portable
// in code, while keyWrapped() reports that wrapping is unavailable.
func protect(plaintext []byte) ([]byte, error)    { return plaintext, nil }
func unprotect(ciphertext []byte) ([]byte, error) { return ciphertext, nil }

// keyWrapped reports whether protect() provides real OS-level wrapping on this
// platform. False here means new key files are written in raw form.
func keyWrapped() bool { return false }
