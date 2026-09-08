package config

import (
	"fmt"
	"regexp"
	"unicode/utf8"

	"gxShell/backend/types"
)

func NormalizeSessionLog(value types.SessionLogSettings) types.SessionLogSettings {
	if value.MaxFileMB < 1 || value.MaxFileMB > 100 {
		value.MaxFileMB = 10
	}
	if value.MaxSessionMB < value.MaxFileMB || value.MaxSessionMB > 1024 {
		value.MaxSessionMB = max(100, value.MaxFileMB)
	}
	return value
}

var highlightColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func ValidateHighlightRules(rules []types.HighlightRule) error {
	if len(rules) > 20 {
		return fmt.Errorf("at most 20 highlight rules are allowed")
	}
	ids := map[string]bool{}
	for i, rule := range rules {
		if rule.ID == "" || ids[rule.ID] {
			return fmt.Errorf("highlight rule %d: unique ID required", i+1)
		}
		ids[rule.ID] = true
		if !highlightColor.MatchString(rule.Color) {
			return fmt.Errorf("highlight rule %d: invalid color", i+1)
		}
		if rule.Mode != "literal" && rule.Mode != "regex" {
			return fmt.Errorf("highlight rule %d: invalid mode", i+1)
		}
		if utf8.RuneCountInString(rule.Pattern) > 256 {
			return fmt.Errorf("highlight rule %d: pattern exceeds 256 characters", i+1)
		}
		if !rule.Enabled {
			continue
		}
		if rule.Pattern == "" {
			return fmt.Errorf("highlight rule %d: empty pattern", i+1)
		}
		if rule.Mode == "regex" {
			if _, err := regexp.Compile(rule.Pattern); err != nil {
				return fmt.Errorf("highlight rule %d: %w", i+1, err)
			}
		}
	}
	return nil
}
