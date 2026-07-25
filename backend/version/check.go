package version

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Release is what the app knows about a published version.
type Release struct {
	// Version is the tag with its decoration stripped, e.g. "1.4.0".
	Version string `json:"version"`
	// URL is the human-readable release page, opened in the system browser. The
	// app deliberately does not download or replace its own binary: gxShell is
	// distributed as a single unsigned exe, and silently self-replacing it is a
	// far bigger trust and failure surface than sending the user to the page.
	URL string `json:"url"`
	// Notes is the release body, shown in the update prompt. Rendered as plain
	// text, never as HTML, because it is remote content.
	Notes string `json:"notes"`
	// PublishedAt is when the release went out, for display only.
	PublishedAt time.Time `json:"publishedAt"`
	// Prerelease marks a release the feed flagged as not stable.
	Prerelease bool `json:"prerelease"`
}

// CheckResult is the outcome of one update check.
type CheckResult struct {
	// Current is the running version.
	Current string `json:"current"`
	// Latest is the newest release found, empty when the check failed.
	Latest *Release `json:"latest,omitempty"`
	// UpdateAvailable is true only when Latest is strictly newer than Current.
	UpdateAvailable bool `json:"updateAvailable"`
	// CheckedAt is when this result was produced.
	CheckedAt time.Time `json:"checkedAt"`
	// Error carries a short reason when the check could not complete. It is a
	// field rather than a returned error so a failed background check can be
	// recorded and displayed without being treated as an app error.
	Error string `json:"error,omitempty"`
}

// notesLimit caps how much of a release body is kept. The feed's body is
// arbitrary remote text; truncating bounds both the payload crossing into the
// renderer and what the update dialog has to lay out.
const notesLimit = 4000

// maxResponseBytes bounds the response read. The endpoint is trusted-ish, but an
// unbounded io.ReadAll on a remote body is how a hung or hostile server turns a
// background check into memory pressure.
const maxResponseBytes = 1 << 20

// Checker looks up the latest published release.
type Checker struct {
	// Client is the HTTP client used for the lookup. A nil Client means a
	// default one with a bounded timeout.
	Client *http.Client
	// Endpoint overrides the release feed URL. Empty uses the GitHub releases
	// API for Repository. Tests set this to a local server.
	Endpoint string
	// UserAgent identifies the app to the feed. GitHub rejects requests without
	// one.
	UserAgent string
}

// NewChecker returns a Checker with the defaults the app uses.
func NewChecker() *Checker {
	return &Checker{
		// A short timeout: this runs in the background at startup, and a check
		// that hangs should be forgotten rather than retried indefinitely.
		Client:    &http.Client{Timeout: 10 * time.Second},
		UserAgent: "gxShell/" + Version,
	}
}

// Check fetches the latest release and compares it with the running version.
//
// It reports the newest *stable* release. Pre-releases are skipped: someone
// running a release build should not be prompted to move onto an rc.
func (c *Checker) Check(ctx context.Context) CheckResult {
	result := CheckResult{Current: Version, CheckedAt: time.Now()}

	release, err := c.latestStable(ctx)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.Latest = release
	result.UpdateAvailable = IsNewer(Version, release.Version)
	return result
}

func (c *Checker) latestStable(ctx context.Context) (*Release, error) {
	endpoint := c.Endpoint
	if endpoint == "" {
		// The /releases list rather than /releases/latest: the latter follows
		// GitHub's own notion of "latest", which can be a pre-release, and it
		// gives no way to fall back to the newest stable one.
		endpoint = fmt.Sprintf("https://api.github.com/repos/%s/releases?per_page=20", Repository)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("could not build request: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	// No Authorization header: this is an unauthenticated read of a public
	// repository. Sending a token would leak credentials to the feed and gain
	// nothing but a higher rate limit the app does not need.
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}

	client := c.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, errors.New("could not reach the release feed")
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusForbidden, resp.StatusCode == http.StatusTooManyRequests:
		// Unauthenticated GitHub API calls are rate limited per source IP, so
		// this is expected rather than broken, and worth saying plainly.
		return nil, errors.New("release feed rate limit reached, try again later")
	case resp.StatusCode == http.StatusNotFound:
		return nil, errors.New("no releases published")
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("release feed returned status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return nil, errors.New("could not read the release feed")
	}

	var feed []struct {
		TagName     string    `json:"tag_name"`
		Name        string    `json:"name"`
		HTMLURL     string    `json:"html_url"`
		Body        string    `json:"body"`
		Draft       bool      `json:"draft"`
		Prerelease  bool      `json:"prerelease"`
		PublishedAt time.Time `json:"published_at"`
	}
	if err := json.Unmarshal(body, &feed); err != nil {
		return nil, errors.New("could not parse the release feed")
	}

	var best *Release
	for _, entry := range feed {
		if entry.Draft || entry.Prerelease {
			continue
		}
		tag := Normalize(entry.TagName)
		if tag == "" {
			tag = Normalize(entry.Name)
		}
		if tag == "" {
			continue
		}
		if !Valid(tag) {
			continue
		}
		// The feed is ordered newest-first by creation date, which is not the
		// same as highest version: a patch for an older line can be published
		// after a newer minor. Pick by version instead of taking the first.
		if best != nil && !IsNewer(best.Version, tag) {
			continue
		}
		notes := strings.TrimSpace(entry.Body)
		if len(notes) > notesLimit {
			notes = notes[:notesLimit] + "\n…"
		}
		best = &Release{
			Version:     tag,
			URL:         entry.HTMLURL,
			Notes:       notes,
			PublishedAt: entry.PublishedAt,
			Prerelease:  entry.Prerelease,
		}
	}
	if best == nil {
		return nil, errors.New("no stable release found")
	}
	return best, nil
}
