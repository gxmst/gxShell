package secrets

import (
	"os"
	"path/filepath"
	"testing"
)

// newTestStore returns a Store whose data and legacy directories both point at
// fresh temp dirs, so tests never touch the real OS keyring or user dirs. The
// keyring itself is environment-dependent (and unavailable in CI), so these
// tests exercise the AES-GCM fallback path directly via the unexported helpers.
func newTestStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	return &Store{dataDir: dir, legacyDir: dir}
}

// When the keyring accepts one secret kind, only that kind may be removed from
// the fallback file: the other kind may still exist ONLY there (written during
// an earlier keyring outage) and must survive.
func TestDeleteFallbackKindKeepsSibling(t *testing.T) {
	s := newTestStore(t)
	if err := s.saveFallback("p1", "password", "pw"); err != nil {
		t.Fatalf("saveFallback: %v", err)
	}
	if err := s.saveFallback("p1", "passphrase", "pp"); err != nil {
		t.Fatalf("saveFallback: %v", err)
	}

	s.deleteFallbackKind("p1", "password")

	if got := s.loadFallback("p1", "password"); got != "" {
		t.Fatalf("password should be gone, got %q", got)
	}
	if got := s.loadFallback("p1", "passphrase"); got != "pp" {
		t.Fatalf("passphrase must survive deleting the password kind, got %q", got)
	}

	// Removing the last kind drops the whole entry (and the file).
	s.deleteFallbackKind("p1", "passphrase")
	if got := s.loadFallback("p1", "passphrase"); got != "" {
		t.Fatalf("passphrase should be gone, got %q", got)
	}
	if _, err := os.Stat(s.fallbackPath()); !os.IsNotExist(err) {
		t.Fatalf("fallback file should be removed once empty, stat err=%v", err)
	}
}

func TestFallbackRoundTrip(t *testing.T) {
	s := newTestStore(t)

	if err := s.saveFallback("profile-1", "password", "s3cr3t"); err != nil {
		t.Fatalf("saveFallback: %v", err)
	}
	if err := s.saveFallback("profile-1", "passphrase", "key-pass"); err != nil {
		t.Fatalf("saveFallback passphrase: %v", err)
	}
	if err := s.saveFallback("profile-2", "password", "other"); err != nil {
		t.Fatalf("saveFallback profile-2: %v", err)
	}

	if got := s.loadFallback("profile-1", "password"); got != "s3cr3t" {
		t.Fatalf("password = %q, want %q", got, "s3cr3t")
	}
	if got := s.loadFallback("profile-1", "passphrase"); got != "key-pass" {
		t.Fatalf("passphrase = %q, want %q", got, "key-pass")
	}
	if got := s.loadFallback("profile-2", "password"); got != "other" {
		t.Fatalf("profile-2 password = %q, want %q", got, "other")
	}
	if got := s.loadFallback("missing", "password"); got != "" {
		t.Fatalf("missing profile should return empty, got %q", got)
	}
}

func TestFallbackFileIsEncrypted(t *testing.T) {
	s := newTestStore(t)
	const secret = "do-not-store-in-plaintext"
	if err := s.saveFallback("p", "password", secret); err != nil {
		t.Fatalf("saveFallback: %v", err)
	}
	raw, err := os.ReadFile(s.fallbackPath())
	if err != nil {
		t.Fatalf("read fallback file: %v", err)
	}
	if len(raw) == 0 {
		t.Fatal("fallback file is empty")
	}
	if bytesContains(raw, []byte(secret)) {
		t.Fatal("secret stored in plaintext on disk")
	}
}

func TestDeleteFallbackRemovesProfile(t *testing.T) {
	s := newTestStore(t)
	if err := s.saveFallback("p1", "password", "a"); err != nil {
		t.Fatalf("saveFallback p1: %v", err)
	}
	if err := s.saveFallback("p2", "password", "b"); err != nil {
		t.Fatalf("saveFallback p2: %v", err)
	}

	s.deleteFallback("p1")
	if got := s.loadFallback("p1", "password"); got != "" {
		t.Fatalf("deleted profile still present: %q", got)
	}
	if got := s.loadFallback("p2", "password"); got != "b" {
		t.Fatalf("untouched profile lost: %q", got)
	}

	// Removing the last profile should delete the file entirely.
	s.deleteFallback("p2")
	if _, err := os.Stat(s.fallbackPath()); !os.IsNotExist(err) {
		t.Fatalf("fallback file should be removed when empty, stat err = %v", err)
	}
}

func TestEncryptDecryptRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	plaintext := []byte("the quick brown fox")
	ct, err := encrypt(plaintext, deriveKey(key))
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	pt, err := decrypt(ct, deriveKey(key))
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if string(pt) != string(plaintext) {
		t.Fatalf("round-trip = %q, want %q", pt, plaintext)
	}
}

func TestDecryptRejectsTamperedCiphertext(t *testing.T) {
	derived := deriveKey([]byte("0123456789abcdef0123456789abcdef"))
	ct, err := encrypt([]byte("payload"), derived)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	ct[len(ct)-1] ^= 0xff // flip a byte in the GCM tag
	if _, err := decrypt(ct, derived); err == nil {
		t.Fatal("tampered ciphertext should fail authentication")
	}
}

func TestDecryptRejectsShortCiphertext(t *testing.T) {
	derived := deriveKey([]byte("0123456789abcdef0123456789abcdef"))
	if _, err := decrypt([]byte{1, 2, 3}, derived); err == nil {
		t.Fatal("ciphertext shorter than nonce should error")
	}
}

func TestGetOrCreateKeyIsStable(t *testing.T) {
	s := newTestStore(t)
	first, err := s.getOrCreateKey()
	if err != nil {
		t.Fatalf("getOrCreateKey: %v", err)
	}
	if len(first) != 32 {
		t.Fatalf("key length = %d, want 32", len(first))
	}
	second, err := s.getOrCreateKey()
	if err != nil {
		t.Fatalf("getOrCreateKey (2nd): %v", err)
	}
	if string(first) != string(second) {
		t.Fatal("key changed between calls; persistence is broken")
	}
}

// TestLoadLegacyBareKeyFile verifies that a key file written by a version that
// predates the version header (a bare 32-byte blob) is still accepted, so
// existing fallback secrets remain decryptable after upgrade.
func TestLoadLegacyBareKeyFile(t *testing.T) {
	s := newTestStore(t)
	bare := make([]byte, 32)
	for i := range bare {
		bare[i] = byte(255 - i)
	}
	if err := os.WriteFile(s.keyPath(), bare, 0600); err != nil {
		t.Fatalf("write legacy key: %v", err)
	}
	got, err := s.getOrCreateKey()
	if err != nil {
		t.Fatalf("getOrCreateKey: %v", err)
	}
	if string(got) != string(bare) {
		t.Fatal("legacy bare key was not loaded verbatim")
	}
}

// TestLegacyKeyMigration verifies that a key in the legacy (volatile cache)
// directory is migrated into the data directory and that secrets encrypted
// under it remain readable through the migration.
func TestLegacyKeyMigration(t *testing.T) {
	dataDir := t.TempDir()
	legacyDir := t.TempDir()

	// First store only knows the legacy dir as both, so it writes a key there
	// and encrypts a secret with it.
	legacyStore := &Store{dataDir: legacyDir, legacyDir: legacyDir}
	if err := legacyStore.saveFallback("p", "password", "legacy-secret"); err != nil {
		t.Fatalf("save under legacy key: %v", err)
	}

	// Move the encrypted fallback file into the new data dir, leaving the key
	// behind in the legacy dir, to model an upgrade that changed the data path.
	raw, err := os.ReadFile(legacyStore.fallbackPath())
	if err != nil {
		t.Fatalf("read legacy fallback: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "secrets.dat"), raw, 0600); err != nil {
		t.Fatalf("seed new fallback: %v", err)
	}

	migrated := &Store{dataDir: dataDir, legacyDir: legacyDir}
	if got := migrated.loadFallback("p", "password"); got != "legacy-secret" {
		t.Fatalf("secret lost across key migration: %q", got)
	}
	// The migrated store should now have its own copy of the key.
	if _, err := os.Stat(migrated.keyPath()); err != nil {
		t.Fatalf("key was not migrated into data dir: %v", err)
	}
}

func bytesContains(haystack, needle []byte) bool {
	if len(needle) == 0 {
		return true
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		match := true
		for j := range needle {
			if haystack[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
