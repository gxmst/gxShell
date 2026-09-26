package i18n

import "testing"

func TestChinese(t *testing.T) {
	chinese := []string{"zh-CN", "zh-cn", "zh", " ZH-CN ", "Zh"}
	for _, language := range chinese {
		if !Chinese(language) {
			t.Errorf("Chinese(%q) = false, want true", language)
		}
	}
	// An empty tag is the state of a fresh install, and readTrayLanguage plus the
	// frontend both read it as English. Treating it as Chinese here would make the
	// same install show a Chinese tray and English errors.
	other := []string{"", "en", "en-US", "zh-TW", "zh-Hans", "de", "english"}
	for _, language := range other {
		if Chinese(language) {
			t.Errorf("Chinese(%q) = true, want false", language)
		}
	}
}

func TestText(t *testing.T) {
	cases := []struct {
		language string
		want     string
	}{
		{"zh-CN", "中文"},
		{"zh", "中文"},
		{"en", "English"},
		{"", "English"},
		{"fr", "English"},
	}
	for _, tc := range cases {
		if got := Text(tc.language, "中文", "English"); got != tc.want {
			t.Errorf("Text(%q) = %q, want %q", tc.language, got, tc.want)
		}
	}
}
