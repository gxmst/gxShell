# Session log retention

Session output logging and historical log cleanup have separate switches.
Both default to off. Logging keeps its per-file and per-connection limits.
In **Settings → Terminal**, enable **Automatically clean up historical session
logs (all servers)** to set a retention period and total size limit. The initial
values are 30 days and 1,024 MB; cleanup starts only after the settings are saved.
Size values use 1,024 × 1,024 bytes per MB, matching existing log limits.

The policy belongs to this computer. Server overrides do not change it, and
restoring a backup preserves it. Invalid enabled values are rejected when
saving; invalid persisted values disable cleanup instead of silently reducing
the quota. A failed settings save does not change the running policy.

Cleanup runs at startup, after saving the policy, and when a logged connection
opens or closes. It deletes expired closed-session logs first, then the oldest
remaining closed logs until the total is below the limit. Every rotated part
of an active session is protected, so active sessions can temporarily exceed
the total limit. Once a session closes, its files become eligible.

Only regular files with the writer's complete filename pattern are eligible.
Other files, directories and symbolic links are left alone. File creation,
active-session registration and cleanup share a lock, and deletion rechecks
file identity inside an `os.Root` confined to the session-log directory.
Cleanup errors are reported separately and do not prevent a new session from
recording output when its own log file can still be opened.

Tests use temporary directories and cover opt-in defaults, invalid policies,
age and size limits, active rotated files, concurrent policy changes and
connections, and symbolic-link handling. Browser smoke checks cover the
settings at narrow widths and saving an explicit policy with a mocked backend.

Verified on 2026-09-12 with the full Go test suite and vet, the 351 frontend
tests, both browser smoke scripts, and the Windows desktop build. All passed.
The local Windows environment has no C compiler for the race detector;
`go test -race ./...` remains a CI check.
