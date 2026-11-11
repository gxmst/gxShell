package app

import (
	"testing"
	"time"

	"gxShell/backend/config"
	"gxShell/backend/types"
)

func TestCliTrustConfirmationTransitions(t *testing.T) {
	now := time.Now()
	base := types.Profile{CliEnabled: true, CliAlias: "prod", CliTrustUntil: now.Add(time.Hour)}
	if !cliTrustNeedsConfirmation(types.Profile{}, base, now) {
		t.Fatal("new trust window did not require confirmation")
	}
	if cliTrustNeedsConfirmation(base, base, now) {
		t.Fatal("unchanged trust window required confirmation")
	}
	shorter := base
	shorter.CliTrustUntil = now.Add(30 * time.Minute)
	if cliTrustNeedsConfirmation(base, shorter, now) {
		t.Fatal("shortening a trust window required confirmation")
	}
	extended := base
	extended.CliTrustUntil = now.Add(2 * time.Hour)
	if !cliTrustNeedsConfirmation(base, extended, now) {
		t.Fatal("extending a trust window did not require confirmation")
	}
	disabled := base
	disabled.CliEnabled = false
	if cliTrustNeedsConfirmation(base, disabled, now) {
		t.Fatal("disabling CLI access required trust confirmation")
	}
}

func TestCliTrustDurationIsBounded(t *testing.T) {
	profile := types.Profile{CliEnabled: true, CliAlias: "prod", CliTrustUntil: time.Now().Add(25 * time.Hour)}
	if err := validateProfileCliSettings(profile, nil); err == nil {
		t.Fatal("trust window longer than 24 hours was accepted")
	}
}

func TestCliFullTrustDurationAndModeAreBounded(t *testing.T) {
	now := time.Now()
	for _, tc := range []struct {
		mode     string
		duration time.Duration
		valid    bool
	}{
		{"full", time.Hour, true}, {"full", time.Hour + time.Second, false},
		{"full", 4 * time.Hour, false}, {"", 24 * time.Hour, true}, {"unknown", time.Hour, false},
	} {
		profile := types.Profile{CliEnabled: true, CliAlias: "prod", CliTrustMode: tc.mode, CliTrustUntil: now.Add(tc.duration)}
		if err := validateProfileCliSettings(profile, nil); (err == nil) != tc.valid {
			t.Fatalf("mode=%q duration=%s: %v", tc.mode, tc.duration, err)
		}
	}
}

func TestDeprecatedGlobalCliAutoApproveIsNotSurfacedOrResaved(t *testing.T) {
	store, err := config.NewStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	settings, err := store.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	settings.CliAutoApprove = true
	settings.Ai.Provider = "openai"
	if err := store.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	app := &App{store: store}
	got, err := app.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if got.CliAutoApprove {
		t.Fatal("deprecated permanent trust was surfaced as active")
	}
	if _, err := app.UpdateSettings(got); err != nil {
		t.Fatal(err)
	}
	persisted, err := store.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if persisted.CliAutoApprove {
		t.Fatal("deprecated permanent trust was re-saved")
	}
}
