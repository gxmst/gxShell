package app

import (
	"encoding/json"

	"gxShell/backend/types"
)

// Saved workspaces can outlive their server profiles. Normalize only the export
// snapshot; the user's locally saved workspace remains available for editing.
func prepareBackupWorkspaces(raw string, profiles []types.Profile) (string, []string, error) {
	workspaces, err := parseBackupWorkspaces(raw)
	if err != nil {
		return "", nil, err
	}
	profileIDs := make(map[string]bool, len(profiles))
	for _, profile := range profiles {
		profileIDs[profile.ID] = true
	}
	exported := make([]backupWorkspace, 0, len(workspaces))
	var warnings []string
	for _, workspace := range workspaces {
		items := make([]backupWorkspaceItem, 0, len(workspace.Items))
		keys := make(map[string]bool, len(workspace.Items))
		var removed []backupWorkspaceItem
		for _, item := range workspace.Items {
			if item.Kind == "profile" && !profileIDs[item.Target] {
				removed = append(removed, item)
				continue
			}
			items = append(items, item)
			keys[item.Key] = true
		}
		if len(items) == 0 {
			warnings = append(warnings, "Empty workspace skipped: "+workspace.Name)
			continue
		}
		for _, item := range removed {
			title := item.Title
			if title == "" {
				title = item.Target
			}
			warnings = append(warnings, "Deleted workspace server skipped: "+workspace.Name+" / "+title)
		}
		workspace.Items = items
		if !keys[workspace.Active] {
			workspace.Active = items[0].Key
		}
		if workspace.Layout != nil {
			for _, key := range workspace.Layout.Keys {
				if !keys[key] {
					workspace.Layout = nil
					break
				}
			}
		}
		exported = append(exported, workspace)
	}
	data, err := json.Marshal(exported)
	return string(data), warnings, err
}
