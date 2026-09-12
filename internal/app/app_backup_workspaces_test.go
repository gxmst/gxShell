package app

import (
	"encoding/json"
	"path/filepath"
	"reflect"
	"testing"

	"gxShell/backend/types"
)

func TestBackupExportAfterDeletingWorkspaceServer(t *testing.T) {
	a := backupTestApp(t)
	profile := backupTestPayload().Profiles[0]
	deleted := profile
	deleted.ID, deleted.Host = "gone", "deleted.test"
	if err := a.store.SaveProfiles([]types.Profile{profile, deleted}); err != nil {
		t.Fatal(err)
	}
	primary := backupWorkspaceItem{Key: "p:source", Kind: "profile", Target: "source", Title: "Main", Pinned: true, CustomTitle: true}
	second := backupWorkspaceItem{Key: "p:source:terminal:second", Kind: "profile", Target: "source", InstanceID: "second", Title: "Logs"}
	missing := backupWorkspaceItem{Key: "p:gone", Kind: "profile", Target: "gone", Title: "Deleted server"}
	file := backupWorkspaceItem{Key: "f:notes", Kind: "file", Target: filepath.Join(t.TempDir(), "notes.md"), Title: "Notes"}
	saved := []backupWorkspace{
		{ID: "mixed", Name: "Mixed", Items: []backupWorkspaceItem{primary, file, missing}, Active: missing.Key, Layout: &backupWorkspaceLayout{Keys: []string{primary.Key, missing.Key}, Direction: "horizontal", Ratio: 0.4, RowRatio: 0.5}},
		{ID: "empty", Name: "Only deleted", Items: []backupWorkspaceItem{missing}, Active: missing.Key},
		{ID: "intact", Name: "Independent terminals", Items: []backupWorkspaceItem{primary, second, missing}, Active: second.Key, Layout: &backupWorkspaceLayout{Keys: []string{primary.Key, second.Key}, Direction: "vertical", Ratio: 0.6, RowRatio: 0.5}},
	}
	raw, err := json.Marshal(saved)
	if err != nil {
		t.Fatal(err)
	}
	original, err := a.collectBackup(string(raw), false, false)
	if err != nil || len(original.ExportWarnings) != 0 {
		t.Fatalf("valid workspace export failed: %v", err)
	}
	// Profile deletion leaves the browser's saved workspace snapshot unchanged.
	if err := a.store.SaveProfiles([]types.Profile{profile}); err != nil {
		t.Fatal(err)
	}
	before, err := a.store.SnapshotFiles("profiles.json", "commands.json", "settings.json", "known_hosts")
	if err != nil {
		t.Fatal(err)
	}
	payload, err := a.collectBackup(string(raw), false, false)
	if err != nil {
		t.Fatal(err)
	}
	workspaces, err := parseBackupWorkspaces(payload.Workspaces)
	if err != nil || len(workspaces) != 2 {
		t.Fatalf("surviving workspaces were lost: %v", err)
	}
	if !reflect.DeepEqual(workspaces[0].Items, []backupWorkspaceItem{primary, file}) || workspaces[0].Active != primary.Key || workspaces[0].Layout != nil {
		t.Fatal("removed server left invalid workspace focus or layout")
	}
	if !reflect.DeepEqual(workspaces[1].Items, []backupWorkspaceItem{primary, second}) || workspaces[1].Active != second.Key || !reflect.DeepEqual(workspaces[1].Layout, saved[2].Layout) {
		t.Fatal("unaffected terminals or layout changed")
	}
	expectedWarnings := []string{
		"Deleted workspace server skipped: Mixed / Deleted server",
		"Empty workspace skipped: Only deleted",
		"Deleted workspace server skipped: Independent terminals / Deleted server",
	}
	if !reflect.DeepEqual(payload.ExportWarnings, expectedWarnings) {
		t.Fatalf("workspace omissions were not reported: %v", payload.ExportWarnings)
	}
	after, err := a.store.SnapshotFiles("profiles.json", "commands.json", "settings.json", "known_hosts")
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("export changed local configuration: %v", err)
	}
	// Warning metadata must also survive serialization and appear at import.
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var restored backupPayload
	if err := json.Unmarshal(encoded, &restored); err != nil {
		t.Fatal(err)
	}
	plan, err := backupTestApp(t).planBackup(restored, "[]", "keep", false)
	if err != nil {
		t.Fatal(err)
	}
	if plan.preview.WorkspacesAdded != 2 || len(plan.preview.Warnings) < len(expectedWarnings) || !reflect.DeepEqual(plan.preview.Warnings[:len(expectedWarnings)], expectedWarnings) {
		t.Fatal("normalized workspaces or omission warnings did not reach import preview")
	}
}

func TestBackupExportWithOnlyDeletedWorkspaceServers(t *testing.T) {
	a := backupTestApp(t)
	raw := `[{"id":"old","name":"Old","items":[{"key":"p:gone","kind":"profile","target":"gone","title":"Deleted"}],"active":"p:gone"}]`
	payload, err := a.collectBackup(raw, false, false)
	if err != nil || payload.Workspaces != "[]" || !reflect.DeepEqual(payload.ExportWarnings, []string{"Empty workspace skipped: Old"}) {
		t.Fatalf("an obsolete workspace blocked an otherwise valid backup: %v", err)
	}
	invalid := `[{"id":"old","name":"Old","items":[{"key":"p:gone","kind":"profile","target":"gone"}],"active":"not-an-item"}]`
	if _, err := a.collectBackup(invalid, false, false); err == nil {
		t.Fatal("workspace normalization silently accepted malformed data")
	}
}
