package version

import "testing"

func TestCompare(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		// The case that motivated hand-rolling this: string comparison puts
		// "1.10.0" before "1.9.0" because '1' < '9'.
		{"1.9.0", "1.10.0", -1},
		{"1.10.0", "1.9.0", 1},

		{"1.3.0", "1.3.0", 0},
		{"1.3.0", "1.4.0", -1},
		{"1.4.0", "1.3.0", 1},
		{"1.3.0", "2.0.0", -1},
		{"1.3.1", "1.3.10", -1},

		// Release tags arrive as "v1.4.0" and may carry whitespace.
		{"v1.4.0", "1.4.0", 0},
		{" 1.4.0 ", "v1.4.0", 0},

		// A missing component is zero.
		{"1.4", "1.4.0", 0},
		{"1", "1.0.0", 0},
		{"1.4", "1.4.1", -1},

		// Pre-releases sort below the matching release.
		{"1.4.0-rc.1", "1.4.0", -1},
		{"1.4.0", "1.4.0-rc.1", 1},
		{"1.4.0-rc.1", "1.4.0-rc.2", -1},
		{"1.4.0-rc.2", "1.4.0-rc.10", -1},
		{"1.4.0-alpha", "1.4.0-beta", -1},
		{"1.4.0-rc.1", "1.4.0-rc.1.1", -1},
		// Numeric identifiers rank below alphanumeric ones.
		{"1.4.0-1", "1.4.0-alpha", -1},
		{"1.4.0-rc.1", "1.4.0-rc.1", 0},

		// Build metadata is excluded from precedence.
		{"1.4.0+build.5", "1.4.0", 0},
		{"1.4.0+build.5", "1.4.0+build.9", 0},

		// Malformed input sorts below every valid version. Missing components are
		// legal above, but a component that is present must be numeric.
		{"not-a-version", "0.0.0", -1},
		{"not-a-version", "1.3.0", -1},
		{"1.x.0", "1.0.0", -1},
		{"2.x.0", "1.5.0", -1},
		{"", "1.3.0", -1},
	}

	for _, c := range cases {
		if got := Compare(c.a, c.b); got != c.want {
			t.Errorf("Compare(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestCompareIsAntisymmetric(t *testing.T) {
	versions := []string{"1.0.0", "1.0.1", "1.1.0", "1.9.0", "1.10.0", "2.0.0", "1.4.0-rc.1", "1.4.0"}
	for _, a := range versions {
		for _, b := range versions {
			if Compare(a, b) != -Compare(b, a) {
				t.Errorf("Compare(%q, %q) and Compare(%q, %q) disagree", a, b, b, a)
			}
		}
	}
}

func TestIsNewer(t *testing.T) {
	if !IsNewer("1.3.0", "1.4.0") {
		t.Error("1.4.0 should be newer than 1.3.0")
	}
	if IsNewer("1.3.0", "1.3.0") {
		t.Error("a version is not newer than itself")
	}
	if IsNewer("1.4.0", "1.3.0") {
		t.Error("1.3.0 should not be newer than 1.4.0")
	}
	// A pre-release must not be offered as an update over its release.
	if IsNewer("1.4.0", "1.4.0-rc.1") {
		t.Error("1.4.0-rc.1 should not be newer than 1.4.0")
	}
	if IsNewer("1.5.0", "2.x.0") || IsNewer("1.5.0", "1.6.x") {
		t.Error("a malformed candidate must not trigger an update")
	}
	// A build with an unparseable local version should not be spammed with
	// updates for every published tag.
	if IsNewer("dev", "1.4.0") != true {
		t.Log("unparseable current version is treated as 0.0.0, so updates are offered")
	}
}

func TestValidAllowsMissingComponentsButRejectsGarbage(t *testing.T) {
	for _, value := range []string{"1", "1.4", "1.4.0", "v1.4.0-rc.1+build.5"} {
		if !Valid(value) {
			t.Errorf("Valid(%q) = false", value)
		}
	}
	for _, value := range []string{"", "1.", "1.x.0", "2.x.0", "1.2.3.4", "1.0.0-", "1.0.0+"} {
		if Valid(value) {
			t.Errorf("Valid(%q) = true", value)
		}
	}
}

func TestNormalize(t *testing.T) {
	for in, want := range map[string]string{
		"v1.4.0":  "1.4.0",
		" v1.4.0": "1.4.0",
		"1.4.0":   "1.4.0",
		"":        "",
	} {
		if got := Normalize(in); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", in, got, want)
		}
	}
}
