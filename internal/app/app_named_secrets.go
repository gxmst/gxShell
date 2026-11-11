package app

import (
	"errors"
	"strings"

	"gxShell/backend/secrets"
)

// NamedSecret exposes metadata only. There is deliberately no value getter on App.
type NamedSecret struct {
	Alias     string `json:"alias"`
	Reference string `json:"reference"`
}

func (a *App) ListNamedSecrets() ([]NamedSecret, error) {
	if a.secrets == nil {
		return nil, errors.New("credential storage unavailable")
	}
	names, err := a.secrets.NamedNames(cliSecretNamespace)
	if err != nil {
		return nil, errors.New("failed to list named secrets")
	}
	result := make([]NamedSecret, 0, len(names))
	for _, alias := range names {
		if cliSecretAliasPattern.MatchString(alias) {
			result = append(result, NamedSecret{Alias: alias, Reference: "secret://" + alias})
		}
	}
	return result, nil
}

// SaveNamedSecret is the manual desktop entry path; automation writes retain
// their native confirmation in handleCliSecrets. Values never enter settings.
func (a *App) SaveNamedSecret(alias, value string, replace bool) error {
	alias = strings.TrimSpace(alias)
	if !cliSecretAliasPattern.MatchString(alias) {
		return errors.New("invalid secret alias")
	}
	if value == "" || len(value) > 65536 || strings.ContainsAny(value, "\r\n\x00") {
		return errors.New("invalid secret value")
	}
	if a.secrets == nil {
		return errors.New("credential storage unavailable")
	}
	before, err := a.secrets.GetNamed(cliSecretNamespace, alias)
	if err != nil {
		return errors.New("failed to read named secret status")
	}
	if (before != "") != replace {
		return errors.New("secret changed; refresh the list and choose add or replace")
	}
	// Compare inside the store lock so another UI/CLI/backup edit cannot be lost.
	err = a.secrets.ApplyMigration([]secrets.Value{{
		ID: "named:" + cliSecretNamespace + ":" + alias, Kind: "value", Text: value, Expected: &before,
	}}, func() error { return nil })
	if err != nil {
		return errors.New("failed to save named secret; refresh and retry")
	}
	return nil
}

func (a *App) DeleteNamedSecret(alias string) error {
	alias = strings.TrimSpace(alias)
	if !cliSecretAliasPattern.MatchString(alias) {
		return errors.New("invalid secret alias")
	}
	if a.secrets == nil {
		return errors.New("credential storage unavailable")
	}
	err := a.secrets.ApplyMigration([]secrets.Value{{
		ID: "named:" + cliSecretNamespace + ":" + alias, Kind: "value",
	}}, func() error { return nil })
	if err != nil {
		return errors.New("failed to delete named secret")
	}
	return nil
}
