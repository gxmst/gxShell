package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/zalando/go-keyring"
)

const service = "gxShell"

type Store struct {
	dataDir   string
	legacyDir string
	mu        sync.Mutex

	// Cached state, guarded by mu. The store owns its files exclusively, so
	// caching avoids re-reading and re-decrypting the fallback file (and the
	// key file) on every secret operation.
	encKey        []byte
	fallbackCache map[string]map[string]string
	// fallbackDegraded is set when secrets.dat exists but could not be read or
	// decrypted (e.g. a transient DPAPI failure). While set, reads retry the
	// file instead of caching the empty view, and the first write moves the
	// unreadable file aside (secrets.dat.corrupt-<timestamp>) instead of
	// overwriting bytes that might still be recoverable. Guarded by mu.
	fallbackDegraded bool
}

func NewStore(dataDir string) *Store {
	// legacyDir is the volatile cache location where older versions stored the
	// encryption key. It is only consulted to migrate an existing key into the
	// (persistent) data directory; new keys are never written there.
	legacyDir := dataDir
	if cacheDir, err := os.UserCacheDir(); err == nil {
		legacyDir = filepath.Join(cacheDir, "gxShell")
	}
	_ = os.MkdirAll(dataDir, 0700)
	return &Store{dataDir: dataDir, legacyDir: legacyDir}
}

func (s *Store) SavePassword(profileID string, password string) error {
	if password == "" {
		return nil
	}
	err := keyring.Set(service, key(profileID, "password"), password)
	if err != nil {
		return s.saveFallback(profileID, "password", password)
	}
	s.deleteFallbackKind(profileID, "password")
	return nil
}

func (s *Store) SavePassphrase(profileID string, passphrase string) error {
	if passphrase == "" {
		return nil
	}
	err := keyring.Set(service, key(profileID, "passphrase"), passphrase)
	if err != nil {
		return s.saveFallback(profileID, "passphrase", passphrase)
	}
	s.deleteFallbackKind(profileID, "passphrase")
	return nil
}

// SaveNamed stores an application-managed secret under an explicit namespace.
// Callers should expose only the name to untrusted clients; the returned value
// from GetNamed must stay inside the final execution boundary.
func (s *Store) SaveNamed(namespace string, name string, value string) error {
	if namespace == "" || name == "" || value == "" {
		return errors.New("secret namespace, name, and value are required")
	}
	id := "named:" + namespace + ":" + name
	err := keyring.Set(service, key(id, "value"), value)
	if err != nil {
		return s.saveFallback(id, "value", value)
	}
	s.deleteFallbackKind(id, "value")
	return nil
}

// GetNamed retrieves an application-managed secret without exposing it through
// profile/config serialization.
func (s *Store) GetNamed(namespace string, name string) (string, error) {
	id := "named:" + namespace + ":" + name
	value, err := keyring.Get(service, key(id, "value"))
	if err == nil {
		return value, nil
	}
	if fallback := s.loadFallback(id, "value"); fallback != "" {
		return fallback, nil
	}
	if errors.Is(err, keyring.ErrNotFound) {
		return "", nil
	}
	return "", err
}

// DeleteNamed removes one application-managed secret.
func (s *Store) DeleteNamed(namespace string, name string) {
	id := "named:" + namespace + ":" + name
	_ = keyring.Delete(service, key(id, "value"))
	s.deleteFallback(id)
}

func (s *Store) GetPassword(profileID string) (string, error) {
	value, err := keyring.Get(service, key(profileID, "password"))
	if err == nil {
		return value, nil
	}
	if errors.Is(err, keyring.ErrNotFound) {
		if fallback := s.loadFallback(profileID, "password"); fallback != "" {
			return fallback, nil
		}
		return "", nil
	}
	if fallback := s.loadFallback(profileID, "password"); fallback != "" {
		return fallback, nil
	}
	return "", err
}

func (s *Store) GetPassphrase(profileID string) (string, error) {
	value, err := keyring.Get(service, key(profileID, "passphrase"))
	if err == nil {
		return value, nil
	}
	if errors.Is(err, keyring.ErrNotFound) {
		if fallback := s.loadFallback(profileID, "passphrase"); fallback != "" {
			return fallback, nil
		}
		return "", nil
	}
	if fallback := s.loadFallback(profileID, "passphrase"); fallback != "" {
		return fallback, nil
	}
	return "", err
}

func (s *Store) Delete(profileID string) {
	_ = keyring.Delete(service, key(profileID, "password"))
	_ = keyring.Delete(service, key(profileID, "passphrase"))
	s.deleteFallback(profileID)
}

func key(profileID string, kind string) string {
	return profileID + "." + kind
}

func (s *Store) fallbackPath() string {
	return filepath.Join(s.dataDir, "secrets.dat")
}

func (s *Store) keyPath() string {
	return filepath.Join(s.dataDir, ".gxshell_key")
}

func (s *Store) legacyKeyPath() string {
	return filepath.Join(s.legacyDir, ".gxshell_key")
}

// Key-file format: a 1-byte version header followed by the payload.
//
//	keyFormatRaw   (0x00): payload is the 32-byte key in plaintext.
//	keyFormatDPAPI (0x01): payload is the key wrapped with CryptProtectData.
//
// Files written by versions before the header existed are bare 32-byte blobs;
// those are still recognised and transparently upgraded on next write.
const (
	keyFormatRaw   byte = 0x00
	keyFormatDPAPI byte = 0x01
)

// getOrCreateKey returns the 32-byte file-encryption key. The key is a
// high-entropy random value persisted next to the encrypted data. We never
// derive the key from machine attributes (hostname/home dir) because those are
// low-entropy and guessable, which would let anyone holding secrets.dat
// recompute the key offline. On Windows the key is additionally wrapped with
// DPAPI so it never sits on disk in plaintext (see keyWrapped/protect).
func (s *Store) getOrCreateKey() ([]byte, error) {
	keyFile := s.keyPath()
	if key, ok := s.loadKeyFile(keyFile); ok {
		return key, nil
	}

	// Migrate a key written by an older version from the volatile cache dir.
	if s.legacyKeyPath() != keyFile {
		if key, ok := s.loadKeyFile(s.legacyKeyPath()); ok {
			_ = s.writeKeyFile(keyFile, key)
			return key, nil
		}
	}

	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, err
	}
	if err := s.writeKeyFile(keyFile, key); err != nil {
		return nil, err
	}
	return key, nil
}

// loadKeyFile reads and decodes a key file, returning the 32-byte key. It
// accepts the headered format and the legacy bare-32-byte format.
func (s *Store) loadKeyFile(path string) ([]byte, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	// Legacy: a bare 32-byte key with no version header.
	if len(raw) == 32 {
		return raw, true
	}
	if len(raw) < 1 {
		return nil, false
	}
	switch raw[0] {
	case keyFormatRaw:
		if len(raw) == 33 {
			return raw[1:], true
		}
	case keyFormatDPAPI:
		key, err := unprotect(raw[1:])
		if err == nil && len(key) == 32 {
			return key, true
		}
	}
	return nil, false
}

// writeKeyFile encodes and atomically persists the key, wrapping it with DPAPI
// where available.
func (s *Store) writeKeyFile(path string, key []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	var payload []byte
	if keyWrapped() {
		wrapped, err := protect(key)
		if err != nil {
			return err
		}
		payload = append([]byte{keyFormatDPAPI}, wrapped...)
	} else {
		payload = append([]byte{keyFormatRaw}, key...)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return os.WriteFile(path, payload, 0600)
	}
	return nil
}

func deriveKey(encKey []byte) []byte {
	h := sha256.New()
	h.Write(encKey)
	h.Write([]byte("gxShell-v1-secrets"))
	return h.Sum(nil)
}

// cachedKey returns the file-encryption key, loading or creating it on first
// use. Callers must hold s.mu.
func (s *Store) cachedKey() ([]byte, error) {
	if s.encKey != nil {
		return s.encKey, nil
	}
	key, err := s.getOrCreateKey()
	if err != nil {
		return nil, err
	}
	s.encKey = key
	return key, nil
}

// fallbackData returns the decrypted fallback secrets, reading the file only
// on first use and caching the result. A degraded read (file exists but is
// unreadable/undecryptable) is deliberately NOT cached, so a later call retries
// the file — the failure may be transient. Callers must hold s.mu.
func (s *Store) fallbackData() map[string]map[string]string {
	if s.fallbackCache == nil || s.fallbackDegraded {
		data, degraded := s.readFallback()
		s.fallbackDegraded = degraded
		if degraded {
			return data
		}
		s.fallbackCache = data
	}
	return s.fallbackCache
}

// readFallback loads and decrypts secrets.dat. degraded reports that the file
// exists but could not be read or decrypted; a missing file is the normal
// empty state and is not degraded.
func (s *Store) readFallback() (data map[string]map[string]string, degraded bool) {
	data = map[string]map[string]string{}
	raw, err := os.ReadFile(s.fallbackPath())
	if err != nil {
		return data, !errors.Is(err, os.ErrNotExist)
	}
	encKey, err := s.cachedKey()
	if err != nil {
		return data, true
	}
	derived := deriveKey(encKey)
	plain, err := decrypt(raw, derived)
	if err != nil {
		return data, true
	}
	if err := json.Unmarshal(plain, &data); err != nil {
		return map[string]map[string]string{}, true
	}
	return data, false
}

// quarantineFallback moves an undecryptable secrets.dat aside instead of
// destroying it: the decrypt failure may be transient and the old bytes may
// still be recoverable. Callers must hold s.mu.
func (s *Store) quarantineFallback() error {
	// Keep every recovery candidate. Reusing a fixed .corrupt name would either
	// overwrite an older recovery copy or require deleting it first.
	corrupt := fmt.Sprintf("%s.corrupt-%d", s.fallbackPath(), time.Now().UnixNano())
	if err := os.Rename(s.fallbackPath(), corrupt); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			s.fallbackDegraded = false
			return nil
		}
		return fmt.Errorf("preserve unreadable fallback secrets: %w", err)
	}
	s.fallbackDegraded = false
	return nil
}

func (s *Store) writeFallback(data map[string]map[string]string) error {
	// Never rename a fresh file over bytes we could not read: preserve them
	// first so a transient decrypt failure does not become permanent data loss.
	if s.fallbackDegraded {
		if err := s.quarantineFallback(); err != nil {
			return err
		}
	}
	plain, err := json.Marshal(data)
	if err != nil {
		return err
	}
	encKey, err := s.cachedKey()
	if err != nil {
		return err
	}
	derived := deriveKey(encKey)
	encrypted, err := encrypt(plain, derived)
	if err != nil {
		return err
	}
	tmp := s.fallbackPath() + ".tmp"
	if err := os.WriteFile(tmp, encrypted, 0600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.fallbackPath()); err != nil {
		dataCopy, readErr := os.ReadFile(tmp)
		_ = os.Remove(tmp)
		if readErr != nil {
			return err
		}
		if err := os.WriteFile(s.fallbackPath(), dataCopy, 0600); err != nil {
			return err
		}
	}
	// Disk now matches data, so it is safe to (re)cache and leave degraded mode.
	s.fallbackCache = data
	s.fallbackDegraded = false
	return nil
}

func (s *Store) saveFallback(profileID, kind, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := s.fallbackData()
	if data[profileID] == nil {
		data[profileID] = map[string]string{}
	}
	data[profileID][kind] = value
	return s.writeFallback(data)
}

func (s *Store) loadFallback(profileID, kind string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := s.fallbackData()
	if entry, ok := data[profileID]; ok {
		return entry[kind]
	}
	return ""
}

func (s *Store) deleteFallback(profileID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := s.fallbackData()
	delete(data, profileID)
	if len(data) == 0 {
		// A degraded file may still hold OTHER profiles' secrets we could not
		// read; move it aside rather than deleting it outright.
		if s.fallbackDegraded {
			_ = s.quarantineFallback()
			return
		}
		_ = os.Remove(s.fallbackPath())
		return
	}
	_ = s.writeFallback(data)
}

// deleteFallbackKind removes a single secret kind for the profile. When the
// keyring accepts one kind, the OTHER kind may still exist only in the
// fallback file (written during an earlier keyring outage); deleting the whole
// profile entry there would silently destroy that remaining credential.
func (s *Store) deleteFallbackKind(profileID, kind string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := s.fallbackData()
	entry, ok := data[profileID]
	if !ok {
		return
	}
	if _, exists := entry[kind]; !exists {
		return
	}
	delete(entry, kind)
	if len(entry) == 0 {
		delete(data, profileID)
	}
	if len(data) == 0 {
		if s.fallbackDegraded {
			_ = s.quarantineFallback()
			return
		}
		_ = os.Remove(s.fallbackPath())
		return
	}
	_ = s.writeFallback(data)
}

func encrypt(plaintext []byte, key []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

func decrypt(ciphertext []byte, key []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonceSize := gcm.NonceSize()
	if len(ciphertext) < nonceSize {
		return nil, fmt.Errorf("ciphertext too short (%d bytes)", len(ciphertext))
	}
	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
	return gcm.Open(nil, nonce, ciphertext, nil)
}
