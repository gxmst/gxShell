package websites

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestSitePathConfinement(t *testing.T) {
	path, err := sitePath("nginx", "sites", "example.com")
	if err != nil || path != "/etc/nginx/sites-available/example.com" {
		t.Fatalf("path = %q, %v", path, err)
	}
	path, err = sitePath("nginx", "confd", "api")
	if err != nil || path != "/etc/nginx/conf.d/api.conf" {
		t.Fatalf("confd path = %q, %v", path, err)
	}
	for _, name := range []string{"../passwd", "a/b", "", ".hidden"} {
		if _, err := sitePath("nginx", "sites", name); err == nil {
			t.Errorf("unsafe name %q accepted", name)
		}
	}
}

func TestParseWebsiteConfig(t *testing.T) {
	nginx := parseWebsiteConfig("nginx", "sites", "example", true, `server {
  listen 80;
  listen 443 ssl;
  server_name example.com www.example.com;
  root /var/www/example;
}`)
	if len(nginx.ServerNames) != 2 || len(nginx.Listen) != 2 || nginx.Root != "/var/www/example" {
		t.Fatalf("nginx = %+v", nginx)
	}
	apache := parseWebsiteConfig("apache", "sites", "example.conf", false, `<VirtualHost *:80>
ServerName example.com
ServerAlias www.example.com static.example.com
DocumentRoot /srv/example
</VirtualHost>`)
	if len(apache.ServerNames) != 3 || apache.Root != "/srv/example" || apache.Listen[0] != "*:80" {
		t.Fatalf("apache = %+v", apache)
	}
}

// Status runs unprivileged, so a non-root session can find site configs it
// cannot read. Those must be counted rather than silently dropped: otherwise the
// panel shows "no sites" on a host that is in fact serving several.
func TestParseStatusCountsUnreadableSites(t *testing.T) {
	enc := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	out := strings.Join([]string{
		"BACKEND\tnginx\tsites",
		"SITE\tnginx\tsites\t1\t" + enc("readable.com") + "\t" + enc("server {\n listen 80;\n}"),
		"UNREADABLE\tnginx\t" + enc("secret.com"),
		"UNREADABLE\tnginx\t" + enc("other.com"),
	}, "\n")

	status, err := parseStatus(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(status.Sites) != 1 || status.Sites[0].Name != "readable.com" {
		t.Fatalf("sites = %+v", status.Sites)
	}
	if status.Unreadable != 2 {
		t.Errorf("Unreadable = %d, want 2", status.Unreadable)
	}
	// An ordinary listing must not report a permission problem that isn't there.
	clean, err := parseStatus("BACKEND\tnginx\tsites")
	if err != nil {
		t.Fatal(err)
	}
	if clean.Unreadable != 0 {
		t.Errorf("Unreadable = %d on a clean listing, want 0", clean.Unreadable)
	}
}
