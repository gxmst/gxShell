package websites

import "testing"

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
