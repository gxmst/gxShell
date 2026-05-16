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
	"strings"
	"sync"

	"github.com/zalando/go-keyring"
)

const service = "gxShell"

type Store struct {
	dataDir  string
	cacheDir string
	mu       sync.Mutex
}

func NewStore(dataDir string) *Store {
	cacheDir, err := os.UserCacheDir()
	if err != nil {
		cacheDir = dataDir
	}
	cacheDir = filepath.Join(cacheDir, "gxShell")
	_ = os.MkdirAll(cacheDir, 0700)
	return &Store{dataDir: dataDir, cacheDir: cacheDir}
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
	return filepath.Join(s.cacheDir, ".gxshell_key")
}

func (s *Store) getOrCreateKey() ([]byte, error) {
	keyFile := s.keyPath()
	raw, err := os.ReadFile(keyFile)
	if err == nil && len(raw) == 32 {
		return raw, nil
	}
	machineID, err := s.collectMachineID()
	if err != nil {
		key := make([]byte, 32)
		if _, err := io.ReadFull(rand.Reader, key); err != nil {
			return nil, err
		}
		_ = os.MkdirAll(filepath.Dir(keyFile), 0700)
		if err := os.WriteFile(keyFile, key, 0400); err != nil {
			return nil, err
		}
		return key, nil
	}
	h := sha256.New()
	h.Write([]byte(machineID))
	h.Write([]byte("gxShell-secrets-key-v2"))
	derived := h.Sum(nil)
	_ = os.MkdirAll(filepath.Dir(keyFile), 0700)
	_ = os.WriteFile(keyFile, derived, 0400)
	return derived, nil
}

func (s *Store) collectMachineID() (string, error) {
	var parts []string
	if hostname, err := os.Hostname(); err == nil {
		parts = append(parts, hostname)
	}
	if home, err := os.UserHomeDir(); err == nil {
		parts = append(parts, home)
	}
	if user, err := os.UserCacheDir(); err == nil {
		parts = append(parts, user)
	}
	if len(parts) == 0 {
		return "", fmt.Errorf("cannot collect machine identity")
	}
	return strings.Join(parts, "|"), nil
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
		_ = os.Remove(tmp)
		dataCopy, readErr := os.ReadFile(tmp)
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
