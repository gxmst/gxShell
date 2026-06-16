package logger

import "testing"

func TestRedactKeyValueAndPassword(t *testing.T) {
	cases := map[string]string{
		`password=hunter2`:     `password=<redacted>`,
		`password: hunter2`:    `password: <redacted>`,
		`"password":"hunter2"`: `"password":"<redacted>"`,
		`passphrase=secret`:    `passphrase=<redacted>`,
		`api_key=abc123`:       `api_key=<redacted>`,
		`token: bearer xyz`:    `token: <redacted> xyz`,
	}
	for in, want := range cases {
		got := redact(in)
		if got != want {
			t.Errorf("redact(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRedactLeavesNonSensitiveText(t *testing.T) {
	for _, in := range []string{
		`uptime`,
		`ls -la /var/log`,
		`docker ps -a`,
		`echo hello world`,
	} {
		if got := redact(in); got != in {
			t.Errorf("redact(%q) = %q, want unchanged", in, got)
		}
	}
}

func TestRedactMysqlInlinePassword(t *testing.T) {
	cases := map[string]string{
		`mysql -phunter2 -u root`:        `mysql -p<redacted> -u root`,
		`mysqldump -psecret dbname`:      `mysqldump -p<redacted> dbname`,
		`mariadb -pp@ss db`:              `mariadb -p<redacted> db`,
		`mysql -u root -phunter2 -e "x"`: `mysql -u root -p<redacted> -e "x"`,
	}
	for in, want := range cases {
		got := redact(in)
		if got != want {
			t.Errorf("redact(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRedactDoesNotManglePortFlag(t *testing.T) {
	// -p followed by a port number for non-database CLIs must not be touched.
	for _, in := range []string{
		`ssh -p 2222 host`,
		`curl http://host:8080`,
	} {
		if got := redact(in); got != in {
			t.Errorf("redact(%q) = %q, want unchanged", in, got)
		}
	}
}
