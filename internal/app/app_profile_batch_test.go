package app

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"

	"gxShell/backend/types"
)

func TestBatchProfilesRejectsEntireInvalidSelection(t *testing.T) {
	a := newProfileTestApp(t)
	if err := a.store.SaveProfiles([]types.Profile{{ID: "one", Group: "original", Port: 22}}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(a.store.DataDir(), "profiles.json")
	before, _ := os.ReadFile(path)
	group, badPort := "changed", 0
	for _, tc := range []struct {
		ids   []string
		patch types.ProfileBatchPatch
	}{
		{[]string{"one", "missing"}, types.ProfileBatchPatch{Group: &group}},
		{[]string{"one"}, types.ProfileBatchPatch{Group: &group, Port: &badPort}},
		{[]string{"one"}, types.ProfileBatchPatch{}},
	} {
		if _, err := a.UpdateProfilesBatch(tc.ids, tc.patch); err == nil {
			t.Fatal("invalid batch accepted")
		}
		after, _ := os.ReadFile(path)
		if !bytes.Equal(before, after) {
			t.Fatal("failed batch changed persisted profiles")
		}
	}
}

func TestBatchProfilesPreservesSecretsTrustAndUntouchedFields(t *testing.T) {
	a := newProfileTestApp(t)
	id := types.NewID("batch-test")
	deadline := time.Now().Add(time.Hour).Truncate(time.Second)
	profiles := []types.Profile{{ID: id, Host: "host", Username: "root", Port: 22, RememberPassword: true, CliEnabled: true, CliAlias: "prod", CliTrustUntil: deadline, Description: "keep", AutoReconnect: true}, {ID: "other", Group: "untouched", Port: 22}}
	if err := a.store.SaveProfiles(profiles); err != nil {
		t.Fatal(err)
	}
	if err := a.secrets.SavePassword(id, "batch-test-secret"); err != nil {
		t.Fatal(err)
	}
	defer a.secrets.Delete(id)
	group, off := "", false
	result, err := a.UpdateProfilesBatch([]string{id, id}, types.ProfileBatchPatch{Group: &group, AutoReconnect: &off})
	if err != nil {
		t.Fatal(err)
	}
	p := result[0]
	if p.AutoReconnect || p.Group != "" || p.Host != "host" || p.Username != "root" || p.Description != "keep" || !p.CliTrustUntil.Equal(deadline) || !p.CliEnabled || p.CliAlias != "prod" || !p.RememberPassword || p.Password != "" {
		t.Fatalf("unexpected result: %+v", p)
	}
	if result[1].Group != "untouched" {
		t.Fatal("unselected profile changed")
	}
	if secret, err := a.secrets.GetPassword(id); err != nil || secret != "batch-test-secret" {
		t.Fatal("saved credential changed")
	}
}
