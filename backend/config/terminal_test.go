package config

import (
	"gxShell/backend/types"
	"testing"
)

func TestHighlightRuleValidation(t *testing.T) {
	rule := types.HighlightRule{ID: "rule", Pattern: "(a+)+$", Mode: "regex", Color: "#abcdef", Enabled: true}
	if err := ValidateHighlightRules([]types.HighlightRule{rule}); err != nil {
		t.Fatal(err)
	}
	rule.Pattern = "["
	if err := ValidateHighlightRules([]types.HighlightRule{rule}); err == nil {
		t.Fatal("invalid pattern accepted")
	}
	rule.Enabled = false
	if err := ValidateHighlightRules([]types.HighlightRule{rule}); err != nil {
		t.Fatal("disabled draft should be retained")
	}
	if err := ValidateHighlightRules([]types.HighlightRule{rule, rule}); err == nil {
		t.Fatal("duplicate IDs accepted")
	}
}

func TestTerminalAndLoggingBounds(t *testing.T) {
	got := NormalizeTerminalSettings(types.TerminalSettings{FontSize: 99, ScrollbackLines: 1, LineHeight: 0, CursorStyle: "invalid"})
	if got.FontSize != 14 || got.ScrollbackLines != 5000 || got.LineHeight != 1.25 || got.CursorStyle != "block" || got.FontFamily == "" {
		t.Fatalf("bad normalization: %+v", got)
	}
	logs := NormalizeSessionLog(types.SessionLogSettings{MaxFileMB: 100, MaxSessionMB: 1})
	if logs.Enabled || logs.MaxFileMB != 100 || logs.MaxSessionMB < logs.MaxFileMB {
		t.Fatalf("bad log bounds: %+v", logs)
	}
}

func TestTerminalCompatibilityDefaultsAndAliases(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{" CP936 ", "gbk"}, {"CP950", "big5"}, {"cp1252", "windows-1252"},
		{"GB18030", "gb18030"}, {"unsupported", "utf-8"}, {"", "utf-8"},
	} {
		got := NormalizeTerminalSettings(types.TerminalSettings{Encoding: tc.input, TerminalType: "bad\nTERM", BackspaceKey: "bad", DeleteKey: "bad"})
		if got.Encoding != tc.want || got.TerminalType != "xterm-256color" || got.BackspaceKey != "del" || got.DeleteKey != "escape" {
			t.Fatalf("normalization of %q: %+v", tc.input, got)
		}
	}
}

func TestTerminalCompatibilityPersists(t *testing.T) {
	store := newTestStore(t)
	settings := DefaultSettings()
	settings.Terminal.Encoding = "gb18030"
	settings.Terminal.TerminalType = " VT100 "
	settings.Terminal.BackspaceKey = "ctrl-h"
	settings.Terminal.DeleteKey = "del"
	if err := store.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	got, err := store.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if got.Terminal.Encoding != "gb18030" || got.Terminal.TerminalType != "vt100" || got.Terminal.BackspaceKey != "ctrl-h" || got.Terminal.DeleteKey != "del" {
		t.Fatalf("persisted settings: %+v", got.Terminal)
	}
	profileTerminal := NormalizeTerminalSettings(types.TerminalSettings{Encoding: "cp950", TerminalType: "screen", BackspaceKey: "del", DeleteKey: "ctrl-h"})
	if err := store.SaveProfiles([]types.Profile{{ID: "legacy", Terminal: &profileTerminal}}); err != nil {
		t.Fatal(err)
	}
	profiles, err := store.ListProfiles()
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles) != 1 || profiles[0].Terminal == nil || *profiles[0].Terminal != profileTerminal {
		t.Fatalf("profile settings were not preserved: %+v", profiles)
	}
}
