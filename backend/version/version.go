// Package version is the single source of truth for the application version.
//
// The version used to be written out in four places (app_utils.go, wails.json,
// frontend/package.json and cmd/gxshell-cli/main.go) and had already drifted:
// the desktop app reported 1.3.0 while the CLI reported 1.4.0. Both binaries now
// read Version from here. wails.json and package.json still carry their own copy
// because their build tools require a literal, so scripts/check-version.mjs
// compares them against this constant during the frontend build.
package version

// Version is the release version, without a leading "v".
const Version = "1.5.0"

// Repository is the canonical upstream, used to look up published releases.
const Repository = "gxmst/gxShell"
