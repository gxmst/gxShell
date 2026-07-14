package main

import (
	"testing"
	"time"

	"gxShell/backend/config"
	"gxShell/backend/monitor"
	"gxShell/backend/secrets"
	"gxShell/backend/types"
)

func newProfileTestApp(t *testing.T) *App {
	t.Helper()
	store, err := config.NewStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	app.store = store
	app.secrets = secrets.NewStore(store.DataDir())
	return app
}

func TestUpdateProfilePreservesStoredSecretsWhenFieldsAreSanitized(t *testing.T) {
	app := newProfileTestApp(t)
	profileID := types.NewID("profile-test")
	now := time.Now()
	original := types.Profile{
		ID:               profileID,
		Name:             "production",
		Host:             "example.test",
		Port:             22,
		Username:         "root",
		AuthType:         types.AuthPassword,
		RememberPassword: true,
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	if err := app.store.SaveProfiles([]types.Profile{original}); err != nil {
		t.Fatal(err)
	}
	if err := app.secrets.SavePassword(profileID, "stored-password"); err != nil {
		t.Fatal(err)
	}
	if err := app.secrets.SavePassphrase(profileID, "stored-passphrase"); err != nil {
		t.Fatal(err)
	}
	defer app.secrets.Delete(profileID)

	update := original
	update.Description = "edited without re-entering credentials"
	update.Password = ""
	update.PrivateKeyPassphrase = ""
	got, err := app.UpdateProfile(update)
	if err != nil {
		t.Fatal(err)
	}
	if got.Password != "" || got.PrivateKeyPassphrase != "" {
		t.Fatal("updated profile returned unsanitized credentials")
	}
	password, err := app.secrets.GetPassword(profileID)
	if err != nil {
		t.Fatal(err)
	}
	passphrase, err := app.secrets.GetPassphrase(profileID)
	if err != nil {
		t.Fatal(err)
	}
	if password != "stored-password" || passphrase != "stored-passphrase" {
		t.Fatalf("non-credential edit changed stored secrets: password=%q passphrase=%q", password, passphrase)
	}
}

func TestDuplicateProfileRequiresCredentialsToBeEnteredAgain(t *testing.T) {
	app := newProfileTestApp(t)
	original := types.Profile{
		ID:               types.NewID("profile-test"),
		Name:             "production",
		Host:             "example.test",
		Port:             22,
		Username:         "root",
		AuthType:         types.AuthPassword,
		RememberPassword: true,
		CreatedAt:        time.Now(),
		UpdatedAt:        time.Now(),
	}
	if err := app.store.SaveProfiles([]types.Profile{original}); err != nil {
		t.Fatal(err)
	}

	duplicate, err := app.DuplicateProfile(original.ID)
	if err != nil {
		t.Fatal(err)
	}
	if duplicate.ID == original.ID {
		t.Fatal("duplicate reused the original profile ID")
	}
	if duplicate.RememberPassword {
		t.Fatal("duplicate claims to remember credentials that were not copied")
	}
}

type appMonitorExecutor struct {
	calls chan string
}

func (e *appMonitorExecutor) Exec(sessionID string, _ string, _ time.Duration) (string, error) {
	e.calls <- sessionID
	return "", nil
}

func waitForAppMonitorCall(t *testing.T, calls <-chan string) {
	t.Helper()
	select {
	case <-calls:
	case <-time.After(time.Second):
		t.Fatal("monitor did not collect within one second")
	}
}

func newSettingsMonitorTestApp(t *testing.T) (*App, *appMonitorExecutor, types.AppSettings) {
	t.Helper()
	store, err := config.NewStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	settings := config.DefaultSettings()
	settings.MonitorIntervalSec = 3600
	// Keep UpdateSettings out of its AI-config preservation branch; that branch
	// is unrelated to these focused tests and requires a fully started AI manager.
	settings.Ai.Provider = "test"
	if err := store.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	executor := &appMonitorExecutor{calls: make(chan string, 8)}
	app := NewApp()
	app.store = store
	app.monitor = monitor.NewManager(executor, nil)
	t.Cleanup(app.monitor.StopAll)
	return app, executor, settings
}

func TestMonitorDisabledSettingStopsAndBlocksCollectors(t *testing.T) {
	app, executor, settings := newSettingsMonitorTestApp(t)
	if err := app.StartMonitor("session-1"); err != nil {
		t.Fatal(err)
	}
	waitForAppMonitorCall(t, executor.calls)

	settings.MonitorEnabled = false
	if _, err := app.UpdateSettings(settings); err != nil {
		t.Fatal(err)
	}
	if err := app.StartMonitor("session-1"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-executor.calls:
		t.Fatal("disabled monitoring started another collection")
	case <-time.After(100 * time.Millisecond):
	}
	if got := app.GetLatestMetrics("session-1"); got.SessionID != "" {
		t.Fatalf("disabled monitoring retained stale metrics: %#v", got)
	}
}

func TestMonitorIntervalUpdateRestartsActiveCollectors(t *testing.T) {
	app, executor, settings := newSettingsMonitorTestApp(t)
	if err := app.StartMonitor("session-1"); err != nil {
		t.Fatal(err)
	}
	waitForAppMonitorCall(t, executor.calls)

	settings.MonitorIntervalSec = 120
	if _, err := app.UpdateSettings(settings); err != nil {
		t.Fatal(err)
	}
	// Restarting a poller collects immediately, so this verifies that the new
	// interval was applied without waiting for the old one-hour ticker.
	waitForAppMonitorCall(t, executor.calls)
}
