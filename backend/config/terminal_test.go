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
