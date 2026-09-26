package app

import (
	"testing"

	"gxShell/backend/types"
)

// The interface language is not passed per call: it lives in settings and the
// managers hold a getter for it. This covers the whole path from "the user
// picked Chinese" to "the message a manager builds is Chinese", including the
// composition that startup performs -- nothing else exercises those two
// construction calls, so a nil or constant getter there would compile, vet and
// pass every other test, and the only symptom would be English errors shown to
// a user who chose Chinese.
func TestManagerErrorsFollowStoredLanguage(t *testing.T) {
	app := newProfileTestApp(t)
	app.websites = app.newWebsitesManager()
	app.scheduler = app.newSchedulerManager()

	// Both cases fail their input check before any SSH call, so a nil ssh field
	// is never dereferenced.
	websiteError := func() string {
		t.Helper()
		_, err := app.websites.Config("session", "nginx", "sites", "../etc/passwd")
		if err == nil {
			t.Fatal("unsafe site name was accepted")
		}
		return err.Error()
	}
	cronError := func() string {
		t.Helper()
		if err := app.scheduler.Save("session", "job-1", "* * * *", "echo ok", true); err == nil {
			t.Fatal("four-field cron expression was accepted")
		} else {
			return err.Error()
		}
		return ""
	}

	// No settings file yet. The frontend and the tray menu both read that as
	// English, so the backend must not fall through to its Chinese text.
	if got := app.uiLanguage(); got != "" {
		t.Fatalf("uiLanguage on a fresh store = %q, want empty", got)
	}
	if got := websiteError(); got != "Invalid site configuration name" {
		t.Errorf("website error without a stored language = %q", got)
	}
	if got := cronError(); got != "The cron expression must contain 5 fields" {
		t.Errorf("cron error without a stored language = %q", got)
	}

	for _, tc := range []struct {
		language string
		website  string
		cron     string
	}{
		{"zh-CN", "无效的站点配置名称", "Cron 表达式必须包含 5 个字段"},
		{"en", "Invalid site configuration name", "The cron expression must contain 5 fields"},
	} {
		if err := app.store.SaveSettings(types.AppSettings{Language: tc.language}); err != nil {
			t.Fatal(err)
		}
		// Nothing is rebuilt between iterations: the getter is read per message, so
		// a language change applies immediately. That is as much the property under
		// test as the wording is.
		if got := websiteError(); got != tc.website {
			t.Errorf("language %q: website error = %q, want %q", tc.language, got, tc.website)
		}
		if got := cronError(); got != tc.cron {
			t.Errorf("language %q: cron error = %q, want %q", tc.language, got, tc.cron)
		}
	}
}
