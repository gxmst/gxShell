package secrets

import "github.com/zalando/go-keyring"

// The per-store adapter lets migration tests exercise failures without reading
// or modifying the user's native credential manager.
type credentialStore interface {
	Get(string) (string, error)
	Set(string, string) error
	Delete(string) error
	NamedNames(string) ([]string, error)
}

type nativeCredentials struct{}

func (nativeCredentials) Get(id string) (string, error) { return keyring.Get(service, id) }
func (nativeCredentials) Set(id, value string) error    { return keyring.Set(service, id, value) }
func (nativeCredentials) Delete(id string) error        { return keyring.Delete(service, id) }
func (nativeCredentials) NamedNames(namespace string) ([]string, error) {
	return nativeNamedNames(namespace)
}

func (s *Store) credentials() credentialStore {
	if s.keyring != nil {
		return s.keyring
	}
	return nativeCredentials{}
}
