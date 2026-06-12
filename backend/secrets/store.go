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

	"github.com/zalando/go-keyring"
)

const service = "gxShell"

type Store struct {
	dataDir   string
	legacyDir string
	mu        sync.Mutex
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
	s.deleteFallback(profileID)
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
	s.deleteFallback(profileID)
	return nil
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

func (s *Store) readFallback() map[string]map[string]string {
	data := map[string]map[string]string{}
	raw, err := os.ReadFile(s.fallbackPath())
	if err != nil {
		return data
	}
	encKey, err := s.getOrCreateKey()
	if err != nil {
		return data
	}
	derived := deriveKey(encKey)
	plain, err := decrypt(raw, derived)
	if err != nil {
		return data
	}
	_ = json.Unmarshal(plain, &data)
	return data
}

func (s *Store) writeFallback(data map[string]map[string]string) error {
	plain, err := json.Marshal(data)
	if err != nil {
		return err
	}
	encKey, err := s.getOrCreateKey()
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
		return os.WriteFile(s.fallbackPath(), dataCopy, 0600)
	}
	return nil
}

func (s *Store) saveFallback(profileID, kind, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := s.readFallback()
	if data[profileID] == nil {
		data[profileID] = map[string]string{}
	}
	data[profileID][kind] = value
	return s.writeFallback(data)
}

func (s *Store) loadFallback(profileID, kind string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := s.readFallback()
	if entry, ok := data[profileID]; ok {
		return entry[kind]
	}
	return ""
}

func (s *Store) deleteFallback(profileID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := s.readFallback()
	delete(data, profileID)
	if len(data) == 0 {
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
