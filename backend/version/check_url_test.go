package version

import (
	"context"
	"fmt"
	"net/http"
	"testing"
)

func TestReleaseFeedRejectsUnsafeReleaseURLs(t *testing.T) {
	for _, target := range []string{"javascript:alert(1)", "file:///C:/test.exe", "http://example.test/release", "/release", "https:///release", "https://user:password@example.test/release"} {
		t.Run(target, func(t *testing.T) {
			checker, server := newTestChecker(func(w http.ResponseWriter, _ *http.Request) {
				fmt.Fprintf(w, `[{"tag_name":"v99.0.0","html_url":%q}]`, target)
			})
			defer server.Close()
			result := checker.Check(context.Background())
			if result.Error == "" || result.Latest != nil || result.UpdateAvailable {
				t.Fatalf("unsafe URL reached update UI: %#v", result)
			}
		})
	}
}
