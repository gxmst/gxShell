package main

import (
	"testing"
	"time"

	"gxShell/backend/config"
	"gxShell/backend/version"
)

func newUpdateTestApp(t *testing.T) *App {
	t.Helper()
	store, err := config.NewStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	app.store = store
	return app
}

// saveUpdateSettings writes the two update fields, leaving everything else at
// its default.
func saveUpdateSettings(t *testing.T, app *App, enabled bool, skipped string) {
	t.Helper()
	settings := config.DefaultSettings()
	settings.UpdateCheckEnabled = enabled
	settings.UpdateSkippedVersion = skipped
	if err := app.store.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
}

func updateFound(v string) version.CheckResult {
	return version.CheckResult{
		Current:         version.Version,
		Latest:          &version.Release{Version: v, URL: "https://example.test/releases/" + v},
		UpdateAvailable: true,
		CheckedAt:       time.Now(),
	}
}

func TestShouldAnnounceUpdate(t *testing.T) {
	cases := []struct {
		name    string
		enabled bool
		skipped string
		result  version.CheckResult
		want    bool
	}{
		{
			name:    "announces a newer release",
			enabled: true,
			result:  updateFound("9.9.9"),
			want:    true,
		},
		{
			name:    "stays quiet when the check is disabled",
			enabled: false,
			result:  updateFound("9.9.9"),
			want:    false,
		},
		{
			name:    "stays quiet for the skipped version",
			enabled: true,
			skipped: "9.9.9",
			result:  updateFound("9.9.9"),
			want:    false,
		},
		{
			// A skip must not silence every future release.
			name:    "still announces a release newer than the skipped one",
			enabled: true,
			skipped: "9.9.9",
			result:  updateFound("10.0.0"),
			want:    true,
		},
		{
			// Skipping 2.0.0 also covers an older 1.9.0 showing up later.
			name:    "stays quiet for a release older than the skipped one",
			enabled: true,
			skipped: "2.0.0",
			result:  updateFound("1.9.0"),
			want:    false,
		},
		{
			name:    "stays quiet when no update is available",
			enabled: true,
			result:  version.CheckResult{Current: version.Version, UpdateAvailable: false},
			want:    false,
		},
		{
			// A failed check must never produce a prompt.
			name:    "stays quiet when the check failed",
			enabled: true,
			result:  version.CheckResult{Current: version.Version, Error: "could not reach the release feed"},
			want:    false,
		},
		{
			// UpdateAvailable without a release would be a backend bug; treat it
			// as nothing to show rather than dereferencing nil.
			name:    "stays quiet when the result has no release",
			enabled: true,
			result:  version.CheckResult{Current: version.Version, UpdateAvailable: true},
			want:    false,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			app := newUpdateTestApp(t)
			saveUpdateSettings(t, app, c.enabled, c.skipped)
			if got := app.shouldAnnounceUpdate(c.result); got != c.want {
				t.Errorf("shouldAnnounceUpdate() = %v, want %v", got, c.want)
			}
		})
	}
}

func TestSkipUpdateVersionPersistsNormalizedVersion(t *testing.T) {
	app := newUpdateTestApp(t)
	saveUpdateSettings(t, app, true, "")

	// Tags arrive decorated; the stored value must be comparable.
	if err := app.SkipUpdateVersion("v9.9.9"); err != nil {
		t.Fatal(err)
	}

	settings, err := app.store.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if settings.UpdateSkippedVersion != "9.9.9" {
		t.Errorf("UpdateSkippedVersion = %q, want 9.9.9", settings.UpdateSkippedVersion)
	}
	// The skip must actually take effect.
	if app.shouldAnnounceUpdate(updateFound("9.9.9")) {
		t.Error("the skipped version should no longer be announced")
	}
}

// Skipping must not disable the feature: the toggle and the skip are separate
// decisions and a later release still has to get through.
func TestSkipUpdateVersionKeepsChecksEnabled(t *testing.T) {
	app := newUpdateTestApp(t)
	saveUpdateSettings(t, app, true, "")

	if err := app.SkipUpdateVersion("9.9.9"); err != nil {
		t.Fatal(err)
	}

	settings, err := app.store.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if !settings.UpdateCheckEnabled {
		t.Error("skipping a version must not turn off the update check")
	}
	if !app.shouldAnnounceUpdate(updateFound("10.0.0")) {
		t.Error("a newer release should still be announced after a skip")
	}
}

func TestGetVersionReportsSharedConstant(t *testing.T) {
	app := newUpdateTestApp(t)
	if got := app.GetVersion(); got != version.Version {
		t.Errorf("GetVersion() = %q, want %q", got, version.Version)
	}
}

// startUpdateCheck must not start a goroutine at all when the user has turned
// the feature off, so a disabled install makes no outbound request.
func TestStartUpdateCheckRespectsDisabledSetting(t *testing.T) {
	app := newUpdateTestApp(t)
	saveUpdateSettings(t, app, false, "")
	// No event context is set, so an accidental emit would be dropped rather
	// than panicking; the assertion that matters is that this returns promptly
	// without waiting on the startup delay.
	done := make(chan struct{})
	go func() {
		app.startUpdateCheck()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("startUpdateCheck blocked with the check disabled")
	}
}
