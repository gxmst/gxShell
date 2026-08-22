package app

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

func TestUpdateProfileRejectsNestedProxyJump(t *testing.T) {
	app := newProfileTestApp(t)
	profiles := []types.Profile{
		{ID: "app", Name: "app", Host: "app.test", Port: 22, Username: "root", ProxyJumpID: "jump"},
		{ID: "jump", Name: "jump", Host: "jump.test", Port: 22, Username: "root"},
		{ID: "edge", Name: "edge", Host: "edge.test", Port: 22, Username: "root"},
	}
	if err := app.store.SaveProfiles(profiles); err != nil {
		t.Fatal(err)
	}

	jump := profiles[1]
	jump.ProxyJumpID = "edge"
	if _, err := app.UpdateProfile(jump); err == nil {
		t.Fatal("profile used as a jump host was allowed to use another jump host")
	}

	appProfile := profiles[0]
	appProfile.ProxyJumpID = "missing"
	if _, err := app.UpdateProfile(appProfile); err == nil {
		t.Fatal("missing jump host reference was accepted")
	}
}

func TestNormalizeImportedProxyJumpsKeepsOnlyOneHop(t *testing.T) {
	profiles := []types.Profile{
		{ID: "app", ProxyJumpID: "jump"},
		{ID: "jump", ProxyJumpID: "edge"},
		{ID: "edge"},
		{ID: "self", ProxyJumpID: "self"},
		{ID: "missing-ref", ProxyJumpID: "missing"},
	}

	normalizeImportedProxyJumps(profiles, map[int]bool{0: true, 1: true, 3: true, 4: true})

	if profiles[0].ProxyJumpID != "" {
		t.Fatalf("outer nested jump was not cleared: %q", profiles[0].ProxyJumpID)
	}
	if profiles[1].ProxyJumpID != "edge" {
		t.Fatalf("usable inner jump was not preserved: %q", profiles[1].ProxyJumpID)
	}
	if profiles[3].ProxyJumpID != "" || profiles[4].ProxyJumpID != "" {
		t.Fatal("self or missing imported jump reference was not cleared")
	}
}

func TestNormalizeImportedProxyJumpsPreservesExistingRelationship(t *testing.T) {
	profiles := []types.Profile{
		{ID: "app", ProxyJumpID: "jump"},
		{ID: "jump", ProxyJumpID: "edge"},
		{ID: "edge"},
	}

	normalizeImportedProxyJumps(profiles, map[int]bool{1: true})

	if profiles[0].ProxyJumpID != "jump" {
		t.Fatalf("import changed an existing jump relationship: %q", profiles[0].ProxyJumpID)
	}
	if profiles[1].ProxyJumpID != "" {
		t.Fatalf("conflicting imported nested jump was not cleared: %q", profiles[1].ProxyJumpID)
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
