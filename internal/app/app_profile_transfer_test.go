package app

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"gxShell/backend/types"
)

func TestDecodeProfileBundleWithoutSecretsClearsOnImportPath(t *testing.T) {
	data, err := json.Marshal(profileExportBundle{
		Version:         1,
		IncludesSecrets: false,
		Profiles: []types.Profile{{
			ID:               "p1",
			Host:             "example.com",
			Port:             22,
			Username:         "root",
			AuthType:         types.AuthPassword,
			RememberPassword: true,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	profiles, includesSecrets, err := decodeProfileBundle(data)
	if err != nil {
		t.Fatal(err)
	}
	if includesSecrets || len(profiles) != 1 {
		t.Fatalf("unexpected decode result: includesSecrets=%v profiles=%d", includesSecrets, len(profiles))
	}
}

func TestParseOpenSSHConfigAppliesFirstMatchDefaultsAndProxyJump(t *testing.T) {
	homeConfig := `
Host bastion
  HostName jump.example.com
  User jump-user

Host prod
  HostName prod.internal
  User deploy
  Port 2202
  IdentityFile "~/.ssh/prod key"
  ProxyJump bastion

Host *.internal
  User should-not-override

Host *
  Port 2022
`
	candidates, err := parseOpenSSHConfig(homeConfig)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 2 {
		t.Fatalf("expected two concrete hosts, got %d", len(candidates))
	}
	byName := map[string]profileImportCandidate{}
	for _, candidate := range candidates {
		byName[candidate.Profile.Name] = candidate
	}
	prod := byName["prod"]
	bastion := byName["bastion"]
	if prod.Profile.Host != "prod.internal" || prod.Profile.Username != "deploy" || prod.Profile.Port != 2202 {
		t.Fatalf("unexpected prod profile: %+v", prod.Profile)
	}
	if prod.Profile.AuthType != types.AuthPrivateKey || !strings.Contains(prod.Profile.PrivateKeyPath, "prod key") {
		t.Fatalf("identity file was not imported: %+v", prod.Profile)
	}
	if prod.ProxyRef == "" || prod.ProxyRef != bastion.Profile.ID {
		t.Fatalf("ProxyJump was not resolved: prod=%q bastion=%q", prod.ProxyRef, bastion.Profile.ID)
	}
	if bastion.Profile.Port != 2022 {
		t.Fatalf("wildcard default port should apply, got %d", bastion.Profile.Port)
	}
}

func TestMergeImportedProfilesAddsUpdatesSkipsAndStoresSecret(t *testing.T) {
	app := newProfileTestApp(t)
	importedID := types.NewID("profile-import-test")
	existing, err := app.CreateProfile(types.Profile{
		Name:     "existing",
		Host:     "same.example.com",
		Port:     22,
		Username: "root",
		AuthType: types.AuthAgent,
	})
	if err != nil {
		t.Fatal(err)
	}

	result, err := app.mergeImportedProfiles([]profileImportCandidate{
		{Profile: types.Profile{
			ID:       existing.ID,
			Name:     "updated name",
			Host:     "same.example.com",
			Port:     22,
			Username: "root",
			AuthType: types.AuthAgent,
		}},
		{Profile: types.Profile{
			ID:       "other-id",
			Name:     "duplicate identity",
			Host:     "same.example.com",
			Port:     22,
			Username: "root",
			AuthType: types.AuthAgent,
		}},
		{Profile: types.Profile{
			ID:               importedID,
			Name:             "new server",
			Host:             "new.example.com",
			Port:             22,
			Username:         "deploy",
			AuthType:         types.AuthPassword,
			Password:         "imported-secret",
			RememberPassword: true,
			CliEnabled:       true,
			CliAlias:         "new-server",
			CliTrustUntil:    time.Now().Add(12 * time.Hour),
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result["added"] != 1 || result["updated"] != 1 || result["skipped"] != 1 {
		t.Fatalf("unexpected summary: %#v", result)
	}
	profiles, err := app.store.ListProfiles()
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles) != 2 {
		t.Fatalf("expected two profiles after merge, got %d", len(profiles))
	}
	var imported types.Profile
	for _, profile := range profiles {
		if profile.Host == "new.example.com" {
			imported = profile
		}
	}
	if imported.ID == "" || !imported.RememberPassword || imported.Password != "" {
		t.Fatalf("unexpected imported profile metadata: %+v", imported)
	}
	if !imported.CliTrustUntil.IsZero() {
		t.Fatalf("imported profile retained unsafe trust deadline: %s", imported.CliTrustUntil)
	}
	password, err := app.secrets.GetPassword(imported.ID)
	if err != nil {
		t.Fatal(err)
	}
	if password != "imported-secret" {
		t.Fatalf("imported secret was not stored, got %q", password)
	}
	app.secrets.Delete(imported.ID)
}

func TestParseOpenSSHConfigSupportsEqualsSyntaxAndInlineJump(t *testing.T) {
	candidates, err := parseOpenSSHConfig("Host=web\nHostName=web.example.com\nProxyJump=ops@jump.example.com:2222\n")
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 2 {
		t.Fatalf("expected web and inline jump profiles, got %d", len(candidates))
	}
	web := candidates[0]
	jump := candidates[1]
	if web.Profile.Host != "web.example.com" || web.ProxyRef != jump.Profile.ID {
		t.Fatalf("unexpected web import: %+v", web)
	}
	if jump.Profile.Host != "jump.example.com" || jump.Profile.Port != 2222 || jump.Profile.Username != "ops" {
		t.Fatalf("unexpected inline jump: %+v", jump.Profile)
	}
}

func TestMergeImportedProfileWithoutSecretDoesNotClaimCredentialIsRemembered(t *testing.T) {
	app := newProfileTestApp(t)
	result, err := app.mergeImportedProfiles([]profileImportCandidate{{Profile: types.Profile{
		Name:             "portable",
		Host:             "portable.example.com",
		Port:             22,
		Username:         "root",
		AuthType:         types.AuthPassword,
		RememberPassword: true,
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if result["added"] != 1 {
		t.Fatalf("unexpected merge summary: %#v", result)
	}
	profiles, err := app.store.ListProfiles()
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles) != 1 || profiles[0].RememberPassword {
		t.Fatalf("credential-free import should prompt normally: %+v", profiles)
	}
}
