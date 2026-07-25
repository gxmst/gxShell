package version

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestChecker(handler http.HandlerFunc) (*Checker, *httptest.Server) {
	server := httptest.NewServer(handler)
	return &Checker{Client: server.Client(), Endpoint: server.URL, UserAgent: "test"}, server
}

func TestCheckPicksHighestStableVersion(t *testing.T) {
	// Deliberately out of version order and with a pre-release first, which is
	// what the real feed looks like when a patch ships after a minor.
	feed := `[
		{"tag_name":"v1.5.0-rc.1","html_url":"u1","body":"rc","prerelease":true},
		{"tag_name":"v1.3.1","html_url":"u2","body":"patch"},
		{"tag_name":"v1.9.0","html_url":"u3","body":"notes for 1.9","published_at":"2026-07-01T00:00:00Z"},
		{"tag_name":"v1.10.0","html_url":"u4","body":"notes for 1.10"},
		{"tag_name":"v1.4.0","html_url":"u5","body":"old","draft":true}
	]`
	checker, server := newTestChecker(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, feed)
	})
	defer server.Close()

	result := checker.Check(context.Background())
	if result.Error != "" {
		t.Fatalf("unexpected error: %s", result.Error)
	}
	if result.Latest == nil {
		t.Fatal("expected a release")
	}
	// 1.10.0, not 1.9.0 (string order) and not the rc or the draft.
	if result.Latest.Version != "1.10.0" {
		t.Errorf("Latest.Version = %q, want 1.10.0", result.Latest.Version)
	}
	if result.Latest.URL != "u4" {
		t.Errorf("Latest.URL = %q, want u4", result.Latest.URL)
	}
	if !result.UpdateAvailable {
		t.Errorf("expected an update to be available over %s", Version)
	}
	if result.Current != Version {
		t.Errorf("Current = %q, want %q", result.Current, Version)
	}
}

func TestCheckNoUpdateWhenFeedMatchesCurrent(t *testing.T) {
	checker, server := newTestChecker(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, `[{"tag_name":"v%s","html_url":"u"}]`, Version)
	})
	defer server.Close()

	result := checker.Check(context.Background())
	if result.Error != "" {
		t.Fatalf("unexpected error: %s", result.Error)
	}
	if result.UpdateAvailable {
		t.Error("the running version should not be offered as an update")
	}
}

func TestCheckNoUpdateWhenFeedIsOlder(t *testing.T) {
	checker, server := newTestChecker(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `[{"tag_name":"v0.9.0","html_url":"u"}]`)
	})
	defer server.Close()

	result := checker.Check(context.Background())
	if result.UpdateAvailable {
		t.Error("an older release should not be offered as an update")
	}
	if result.Latest == nil || result.Latest.Version != "0.9.0" {
		t.Error("the older release should still be reported, just not as an update")
	}
}

func TestCheckIgnoresPrereleaseOnlyFeed(t *testing.T) {
	checker, server := newTestChecker(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `[{"tag_name":"v9.0.0-rc.1","html_url":"u","prerelease":true}]`)
	})
	defer server.Close()

	result := checker.Check(context.Background())
	if result.UpdateAvailable {
		t.Error("a pre-release must not be offered as an update")
	}
	if result.Error == "" {
		t.Error("expected an explanation when no stable release exists")
	}
}

func TestCheckReportsRateLimitPlainly(t *testing.T) {
	checker, server := newTestChecker(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	})
	defer server.Close()

	result := checker.Check(context.Background())
	if result.UpdateAvailable {
		t.Error("a failed check must not claim an update")
	}
	if !strings.Contains(result.Error, "rate limit") {
		t.Errorf("Error = %q, want it to mention the rate limit", result.Error)
	}
}

func TestCheckHandlesMalformedFeed(t *testing.T) {
	checker, server := newTestChecker(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"not":"an array"}`)
	})
	defer server.Close()

	result := checker.Check(context.Background())
	if result.Error == "" {
		t.Error("expected a parse error")
	}
	if result.UpdateAvailable || result.Latest != nil {
		t.Error("a malformed feed must not produce a release")
	}
}

func TestCheckSkipsMalformedHighVersionTag(t *testing.T) {
	checker, server := newTestChecker(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `[
			{"tag_name":"v99.x.0","html_url":"bad"},
			{"tag_name":"v1.10.0","html_url":"good"}
		]`)
	})
	defer server.Close()

	result := checker.Check(context.Background())
	if result.Error != "" {
		t.Fatalf("unexpected error: %s", result.Error)
	}
	if result.Latest == nil || result.Latest.Version != "1.10.0" {
		t.Fatalf("Latest = %#v, want valid 1.10.0 release", result.Latest)
	}
}

func TestCheckTruncatesLongNotes(t *testing.T) {
	checker, server := newTestChecker(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, `[{"tag_name":"v99.0.0","html_url":"u","body":%q}]`, strings.Repeat("x", notesLimit*2))
	})
	defer server.Close()

	result := checker.Check(context.Background())
	if result.Latest == nil {
		t.Fatal("expected a release")
	}
	if len(result.Latest.Notes) > notesLimit+8 {
		t.Errorf("notes not truncated: got %d bytes", len(result.Latest.Notes))
	}
}

func TestCheckRespectsCancelledContext(t *testing.T) {
	checker, server := newTestChecker(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `[{"tag_name":"v99.0.0","html_url":"u"}]`)
	})
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	result := checker.Check(ctx)
	if result.Error == "" {
		t.Error("expected the cancelled context to fail the check")
	}
	if result.UpdateAvailable {
		t.Error("a cancelled check must not claim an update")
	}
}
