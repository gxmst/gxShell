package main

// Update-check bindings. gxShell checks a public release feed and tells the
// user; it never downloads or replaces its own binary. Self-updating an
// unsigned single-exe desktop app is a much larger trust and failure surface
// than opening the release page, so the "update" action is a browser link.

import (
	"context"
	"time"

	"gxShell/backend/logger"
	"gxShell/backend/version"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// updateCheckStartupDelay staggers the automatic check so it does not compete
// with connecting sessions and the first frontend render.
const updateCheckStartupDelay = 8 * time.Second

// GetVersion returns the running version.
func (a *App) GetVersion() string {
	return version.Version
}

// CheckForUpdate queries the release feed and reports what it found.
//
// A failed check is reported in CheckResult.Error rather than as a Go error:
// the caller is a UI that wants to show "could not reach the release feed"
// without treating it as an app failure.
func (a *App) CheckForUpdate() version.CheckResult {
	return a.checkForUpdate(context.Background(), true)
}

// checkForUpdate performs the lookup. manual distinguishes a user-initiated
// check (which reports regardless of the setting) from the startup one.
func (a *App) checkForUpdate(ctx context.Context, manual bool) version.CheckResult {
	result := version.NewChecker().Check(ctx)

	if result.Error != "" {
		if a.log != nil {
			// Info, not Error: an unreachable release feed is an expected outcome
			// on an offline or firewalled machine, not a fault to escalate.
			a.log.InfoFields("update check did not complete", logger.LogFields{
				"reason": result.Error,
				"manual": manual,
			})
		}
		return result
	}

	if result.UpdateAvailable && a.log != nil {
		a.log.InfoFields("update available", logger.LogFields{
			"current": result.Current,
			"latest":  result.Latest.Version,
		})
	}
	return result
}

// SkipUpdateVersion records a version the user does not want to be reminded
// about. Anything newer still prompts.
//
// This writes through the store rather than UpdateSettings: that method also
// re-derives the AI configuration and restarts the monitor pollers, which is a
// lot of unrelated machinery to set in motion for a "don't remind me" click.
func (a *App) SkipUpdateVersion(v string) error {
	settings, err := a.store.GetSettings()
	if err != nil {
		return err
	}
	settings.UpdateSkippedVersion = version.Normalize(v)
	return a.store.SaveSettings(settings)
}

// startUpdateCheck runs the automatic check in the background at startup.
//
// It is silent by design: it emits an event only when there is a strictly newer
// stable release that the user has not skipped. Nothing is shown when the check
// fails, so an offline launch never produces a toast the user cannot act on.
func (a *App) startUpdateCheck() {
	settings, err := a.store.GetSettings()
	if err != nil || !settings.UpdateCheckEnabled {
		return
	}

	go func() {
		// Give the app time to finish starting. A short sleep rather than a
		// timer so shutdown does not have to track one more resource; the
		// goroutine holds nothing but this delay.
		time.Sleep(updateCheckStartupDelay)

		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()

		result := a.checkForUpdate(ctx, false)
		if a.shouldAnnounceUpdate(result) {
			a.emitUpdateAvailable(result)
		}
	}()
}

// shouldAnnounceUpdate decides whether a completed background check is worth
// interrupting the user for.
//
// It re-reads settings rather than trusting the values captured before the
// startup delay: the user may have turned the check off, or skipped this very
// version, while the check was in flight. Failing to read settings suppresses
// the prompt, on the principle that an unprompted dialog is worse than a missed
// notification.
func (a *App) shouldAnnounceUpdate(result version.CheckResult) bool {
	if !result.UpdateAvailable || result.Latest == nil {
		return false
	}
	current, err := a.store.GetSettings()
	if err != nil {
		return false
	}
	if !current.UpdateCheckEnabled {
		return false
	}
	// A skip covers that version and anything older, so a user who skipped 1.5.0
	// is still told about 1.6.0.
	if current.UpdateSkippedVersion != "" &&
		version.Compare(current.UpdateSkippedVersion, result.Latest.Version) >= 0 {
		return false
	}
	return true
}

// emitUpdateAvailable notifies the frontend about a newer release. Like the
// other emitters here it no-ops before domReady has published a context, so a
// check that finishes during a very early shutdown is simply dropped.
func (a *App) emitUpdateAvailable(result version.CheckResult) {
	ctx := a.ctx.Get()
	if ctx == nil {
		return
	}
	runtime.EventsEmit(ctx, "update:available", result)
}
