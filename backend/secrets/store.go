package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/zalando/go-keyring"
)

const service = "gxShell"

type Store struct {
	dataDir string
	mu      sync.Mutex
}

func NewStore(dataDir string) *Store {
	return &Store{dataDir: dataDir}
}

func (s *Store) SavePassword(profileID string, password string) error {
	if password == "" {
		return nil
	}
	err := keyring.Set(service, key(profileID, "password"), password)
	if err != nil {
		return s.saveFallback(profileID, "password", password)
	}
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
	return filepath.Join(s.dataDir, ".secretkey")
}

func (s *Store) getOrCreateKey() ([]byte, error) {
	key, err := os.ReadFile(s.keyPath())
	if err == nil && len(key) == 32 {
		return key, nil
	}
	key = make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, err
	}
	if err := os.WriteFile(s.keyPath(), key, 0600); err != nil {
		return nil, err
	}
	return key, nil
}

func (s *Store) readFallback() map[string]map[string]string {
	data := map[string]map[string]string{}
	raw, err := os.ReadFile(s.fallbackPath())
	if err != nil {
		return data
	}
	key, err := s.getOrCreateKey()
	if err != nil {
		return data
	}
	plain, err := decrypt(raw, key)
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
	key, err := s.getOrCreateKey()
	if err != nil {
		return err
	}
	encrypted, err := encrypt(plain, key)
	if err != nil {
		return err
	}
	return os.WriteFile(s.fallbackPath(), encrypted, 0600)
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
		return nil, errors.New("ciphertext too short")
	}
	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
	return gcm.Open(nil, nonce, ciphertext, nil)
}
