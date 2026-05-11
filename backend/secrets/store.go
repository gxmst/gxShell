package secrets

import (
	"errors"

	"github.com/zalando/go-keyring"
)

const service = "gxShell"

type Store struct{}

func NewStore() *Store {
	return &Store{}
}

func (s *Store) SavePassword(profileID string, password string) error {
	if password == "" {
		return nil
	}
	return keyring.Set(service, key(profileID, "password"), password)
}

func (s *Store) SavePassphrase(profileID string, passphrase string) error {
	if passphrase == "" {
		return nil
	}
	return keyring.Set(service, key(profileID, "passphrase"), passphrase)
}

func (s *Store) GetPassword(profileID string) (string, error) {
	value, err := keyring.Get(service, key(profileID, "password"))
	if errors.Is(err, keyring.ErrNotFound) {
		return "", nil
	}
	return value, err
}

func (s *Store) GetPassphrase(profileID string) (string, error) {
	value, err := keyring.Get(service, key(profileID, "passphrase"))
	if errors.Is(err, keyring.ErrNotFound) {
		return "", nil
	}
	return value, err
}

func (s *Store) Delete(profileID string) {
	_ = keyring.Delete(service, key(profileID, "password"))
	_ = keyring.Delete(service, key(profileID, "passphrase"))
}

func key(profileID string, kind string) string {
	return profileID + "." + kind
}
