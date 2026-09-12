package types

// BackupExportResult reports a completed export and any workspace omissions.
// A cancelled file dialog leaves Path empty.
type BackupExportResult struct {
	Path     string   `json:"path"`
	Warnings []string `json:"warnings"`
}
