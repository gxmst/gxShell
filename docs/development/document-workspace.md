# Document navigation and sidebar geometry

The document navigator is a sibling of Connections, Files (SFTP), and Tools in
the activity rail. It lists supported documents in the active file's directory,
with a path, source indicator, filter, refresh and reveal-current actions.
Recent documents are folded while reading so the current folder gets the space.

`useContextualSidebar` follows all active-tab changes, including startup restore
and keyboard navigation. Document focus selects Documents; returning to a
terminal restores its previous tool. Manual navigation lasts until the next
document or mode change. Settings drafts and AI conversations remain visible
across tab changes. Sidebar collapse stays a shared user preference.

The preferred panel width is separate from its viewport-clamped width. All
panels and the resize grip use the same effective value. Resizing a window does
not overwrite the preference, and the activity rail always occupies 48 pixels.
The sidebar border is accounted for separately so it does not clip panel content.

Sidebar toggles commit the final grid width once and use a 120 ms opacity
transition when expanding; initial mount does not play the transition.
The former grid-track animation resized xterm/WebGL and reflowed document text
on every frame. The redundant delayed xterm fit was removed; ResizeObserver
handles actual geometry changes. The four-pane browser smoke recreates the
former CSS in isolation and measures both behaviors. One run observed four
distinct pane widths with the old transition and one with each new toggle;
this is a geometry-change measurement, not an FPS guarantee.

Sibling listings are keyed by local folder or remote session and folder. A
previous folder's files are hidden immediately while a new request is pending,
and stale responses cannot replace the current list. Moving among siblings
reuses the listing; Refresh reloads it explicitly. Failures remain visible with
a retry action. Listing files still grants only session-scoped local access.
The sorted listing is reused while filtering, using one locale collator. Only
200 rows render at a time; pagination keeps the full count, filtering searches
the full listing, and revealing the active document selects its page directly.

Tabs use bounded content widths with extra room for the active title. A resize
observer keeps the active tab inside the strip without scrolling the workspace.
The all-tabs menu is clamped to the viewport, wraps complete names and displays
host/path details, with filtering by title, hostname, path or server group.
The picker is a non-modal dialog containing a search field and ordinary buttons.
Arrows and Home/End move through results; Enter selects, and Escape returns focus.
Composition events (including the key-code 229 fallback) do not select, navigate
or dismiss the picker. Its entire height is bounded by the space below its
anchor, with only the result list scrolling.

The document allowlists include common deployment filenames and source text.
Local/remote reads, file dialogs and Markdown links share the same rules;
existing file authorization, size, encoding and relative-path checks remain.
HTML documents display escaped source. JSONC validation permits comments and
trailing commas, while formatting changes whitespace only and keeps numeric
tokens intact. NDJSON is treated as JSON Lines. PDF remains read-only.

Large JSON/JSONC/JSONL validation and formatting use a dedicated, cancellable
worker above 256 Ki UTF-16 code units, matching the live-validation threshold.
Each operation releases its worker on completion, failure, timeout or abort.
The save snapshot remains fixed during parsing; an SSH replacement during
validation updates the transport used for the eventual save. Formatting results are discarded
if the draft changed, and document teardown cancels pending jobs before they can
write or update another document. There is no synchronous large-file fallback.

Plain-text previews above 256 Ki UTF-16 code units use CodeMirror's viewport
rendering in read-only mode. A single 100,000-line `<pre>` stalled Chromium's
compositor in a minimal browser reproduction, before any JSON processing began.
The source preview renders only visible lines while retaining the full document
for search, selection and copying. Editing must be entered explicitly, and find
navigation keeps focus in the search field. Small text previews remain unchanged.

Startup restores the saved server selection in an effect after the restored
tabs have committed. It no longer races a zero-delay timer against React's
batched updates, and later user selections still take precedence.

Local access records the authorized directory identity for the current session.
Regular-file checks and `os.Root` operations protect reads, PDF asset streams,
relative resources and temporary-file replacement from link or directory swaps.
Directory listings do not grant access to links or special files. Text reads and
writes reject invalid UTF-8 and binary controls; saves also inspect existing
bytes so a stale editor cannot overwrite a binary replacement. Remote saves
perform an extra SFTP read for this check; concurrent remote writes are not
transactionally locked by this reread.

Regression coverage includes mode navigation, settings/AI continuity, remote
listing isolation, directory filtering, long-title lookup, named-file access
control, HTML source handling and JSONC round trips. The workbench browser smoke
also verifies equal sidebar dimensions at 1440, 900 and 540 px, restored width,
active-tab visibility, narrow menus and JSONC editing/saving with a mocked
backend. Markdown smoke retains theme, diagram and collapsed-rail coverage.
Follow-up coverage adds IME key handling, a 260 px-high tab picker, a 5,001-file
listing with 200 visible rows, and actual worker processing/saving of a 5 MB,
100,000-line NDJSON document. It checks read-only preview virtualization, full
document search and copying of offscreen lines. Regression tests cover cancelled parsing, edits
during formatting/saving, binary rejection and directory/link replacement.
Symlink tests skip on Windows without the required privilege; the Linux desktop
CI job runs the document safety tests with the race detector to cover them.

Validation on 2026-09-12 passed the full frontend suite (381 tests in 58 files),
the affected follow-up tests, `go test ./...`, `go vet ./...`, and both browser
smoke scripts. The workbench smoke also passed against the production bundle
with `node scripts/smoke-workbench.mjs --preview`, including actual worker assets,
large read-only previews, copying offscreen lines and search across mode changes.
ESLint reported no errors and 52 existing warnings. The browser
checks use a mocked backend; they do not assert live SSH or native WebView FPS.
The local environment has no C compiler for Go's race detector; CI retains that
check.

`wails build -skipbindings` completed successfully for Windows amd64, including
TypeScript, i18n parity, version, bindings, CSS and Vite checks. The normal
development executable is `build/bin/gxShell.exe`; `frontend/dist` contains the
frontend bundle embedded by Wails. No release archive was created.
