package types

import "strings"

// These names are shared by persisted settings and SSH byte conversion.
func NormalizeTerminalEncoding(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "gbk", "cp936":
		return "gbk"
	case "gb18030":
		return "gb18030"
	case "big5", "big-5", "cp950":
		return "big5"
	case "windows-1252", "cp1252":
		return "windows-1252"
	default:
		return "utf-8"
	}
}

func NormalizeTerminalType(value string) string {
	switch value = strings.ToLower(strings.TrimSpace(value)); value {
	case "xterm", "vt100", "vt220", "ansi", "linux", "screen", "screen-256color", "dumb":
		return value
	default:
		return "xterm-256color"
	}
}
