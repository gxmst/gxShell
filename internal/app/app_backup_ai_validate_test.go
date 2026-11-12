package app

import (
	"testing"

	"gxShell/backend/types"
)

func TestBackupRejectsInvalidAiConfigurationBeforeImport(t *testing.T) {
	for _, cfg := range []types.AiConfig{
		{Provider: "unknown"},
		{Provider: "gemini", Endpoint: "file:///tmp/config"},
		{Provider: "openai", Endpoint: "https://user:password@example.test/v1"},
		{Provider: "openai", Endpoint: "https://example.test/v1?key=value"},
	} {
		payload := backupTestPayload()
		payload.Settings.Ai = cfg
		if err := validateBackup(&payload); err == nil {
			t.Fatalf("invalid AI config accepted: %#v", cfg)
		}
	}
}
