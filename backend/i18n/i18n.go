// Package i18n is the two-language helper for backend messages that reach the
// UI.
//
// The backend deliberately has no translator of its own. The interface language
// lives in the settings store, and the App layer hands each manager a getter for
// it (see App.uiLanguage), so a manager can render a message at the moment it
// creates it. That matters for errors: an error string is what the frontend
// shows verbatim in a toast or inline under a field, and it is also what the
// activity log records, so it has to be right when it is produced rather than
// patched up by every consumer.
//
// Messages are written inline as a (Chinese, English) pair instead of being
// looked up from a table keyed by an opaque code. A code table would need a
// second, frontend-side mapping to be useful and would let the two halves drift
// silently; a pair at the call site keeps both renderings next to the logic that
// chose them, and makes a missing translation a compile error rather than a
// runtime surprise.
package i18n

import "strings"

// Chinese reports whether a language tag selects Chinese.
//
// Both "zh-CN" and a bare "zh" are accepted. Nothing else is: the app ships two
// languages, and treating an unrecognised tag as Chinese would be a guess.
func Chinese(language string) bool {
	trimmed := strings.TrimSpace(language)
	return strings.EqualFold(trimmed, "zh-CN") || strings.EqualFold(trimmed, "zh")
}

// Text returns zh for a Chinese tag and en otherwise.
//
// An empty or unknown tag yields en. That matches every other place the language
// is defaulted -- the frontend falls back to "en" when settings carry no
// language, and readTrayLanguage does the same -- so an install that never chose
// a language behaves consistently across the tray, the window and its errors.
func Text(language, zh, en string) string {
	if Chinese(language) {
		return zh
	}
	return en
}
