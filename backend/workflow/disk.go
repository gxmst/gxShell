package workflow

import (
	"context"
	"fmt"

	"gxShell/backend/ai"
)

var DiskScopes = []string{"/var/log", "/var/cache", "/var/lib/docker", "/home", "/tmp"}

func (m *Manager) StartDiskDiagnosis(ctx context.Context, sessionID, profileID, target, language string, cfg ai.Config) (Run, error) {
	return m.start(ctx, sessionID, profileID, target, language, cfg, "disk_diagnosis", "", 0)
}

func diskUsageCommand(scope string) (string, error) {
	paths := "/var/log /var/cache /var/lib/docker /home /tmp"
	if scope != "" {
		if !containsCheck(DiskScopes, scope) {
			return "", fmt.Errorf("unsupported disk inspection scope")
		}
		paths = "'" + scope + "'"
	}
	// Traversal may still read a large directory tree. Limit time and priority,
	// stay on each filesystem, and never elevate privileges.
	return "if ! command -v timeout >/dev/null 2>&1; then echo 'Bounded directory scan requires timeout'; exit 127; fi; if command -v ionice >/dev/null 2>&1 && command -v nice >/dev/null 2>&1; then timeout 12 ionice -c 3 nice -n 19 du -x -k -d 1 " + paths + "; elif command -v nice >/dev/null 2>&1; then timeout 12 nice -n 19 du -x -k -d 1 " + paths + "; else timeout 12 du -x -k -d 1 " + paths + "; fi", nil
}

func inspectionToolsFor(run Run) []map[string]any {
	tools := inspectionTools()
	for _, tool := range tools {
		function := tool["function"].(map[string]any)
		if function["name"] == "inspect_check" {
			checks := append([]string{}, Checks...)
			if run.Workflow == "disk_diagnosis" {
				checks = append(checks, "inodes", "journal", "container_storage")
			}
			if run.Workflow == "service_diagnosis" {
				checks = append(checks, "connectivity")
			}
			function["parameters"].(map[string]any)["properties"].(map[string]any)["check"].(map[string]any)["enum"] = checks
		}
	}
	if run.Workflow == "disk_diagnosis" {
		tools = append(tools, map[string]any{"type": "function", "function": map[string]any{"name": "inspect_disk", "description": "Read directory usage in one fixed scope with a 12-second deadline. No cleanup or elevation.", "parameters": map[string]any{"type": "object", "properties": map[string]any{"scope": map[string]any{"type": "string", "enum": DiskScopes}, "reason": map[string]any{"type": "string", "description": "Why this scope is needed, in the interface language"}}, "required": []string{"scope", "reason"}, "additionalProperties": false}}})
	}
	return tools
}
