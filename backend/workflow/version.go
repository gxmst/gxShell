package workflow

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"gxShell/backend/ai"
)

func stampRun(run *Run, cfg ai.Config) {
	run.WorkflowVersion, run.PromptVersion = WorkflowVersion, PromptVersion
	// Store a grouping fingerprint, never endpoint query credentials or API keys.
	endpoint := strings.TrimRight(strings.TrimSpace(cfg.Endpoint), "/")
	hash := sha256.Sum256([]byte(string(cfg.Provider) + ":" + endpoint))
	run.EndpointID = hex.EncodeToString(hash[:6])
}
