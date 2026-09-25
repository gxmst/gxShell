# Markdown reading and Mermaid diagrams

The reported Chinese workflow is a valid Mermaid flowchart. Missing labels
came from SVG sanitization removing `foreignObject` HTML labels; the current
Mermaid/DOMPurify combination can remove them inside Mermaid as well. Rendering
now uses native SVG text with strict Mermaid security. The final SVG sanitizer
also supports a small HTML label vocabulary with an explicit namespace boundary;
scripts, handlers, frames and form controls remain filtered.

Mermaid source metadata is URI-encoded before Markdown sanitization. Literal
`-->` in an HTML attribute is rejected by XML-safe sanitization, so storing raw
flowchart source in an attribute lost the source needed for retries and copying.

Reading behavior:

- Graphs follow the application's light/dark theme. Rendering is lazy and
  configuration/rendering share a queue, so concurrent documents cannot exchange
  themes. Cancelled work cannot overwrite a newer document or theme. Successful
  graphs are retained across tab switches and zoom changes.
- Each diagram has zoom, 100%, fit width, source, copy and expanded-view controls.
  Large graphs scroll within their viewport. The expanded dialog uses one SVG
  instance, retains the inline document height and restores its previous zoom
  and scroll position when closed. Escape closes the dialog.
- A parse error retains copyable source, exposes the parser's line information
  and offers retry. Following paragraphs and diagrams remain readable. Temporary
  Mermaid measurement elements are removed on both success and failure.
- The document toolbar shows the file type and Find. Typography groups zoom and
  its reset, line spacing, reading-column width and code wrapping, with the current
  zoom percentage visible on the toolbar. Layout changes retain the reading anchor.
  Find follows asynchronous diagram updates and excludes SVG CSS and controls.
  Search offsets are measured against original Unicode text.
- The document sidebar shares its space between the folder listing and outline.
  Each section folds independently, and the active heading stays in view. A
  standalone viewer without a sidebar retains the internal outline; below 640 px
  that outline opens over the document and closes after selection or Escape.
  Toolbar controls wrap and Find occupies its own row in narrow panes.
- The light theme uses one soft white canvas for the document and toolbar, with
  neutral gray surrounding chrome and no terminal inset frame. Dark/custom themes
  use their existing surface colors. Reading positions persist per file without
  storing the document text.
- Markdown above 1 Mi UTF-16 code units or 12,000 lines opens as virtualized source
  with a simplified-layout notice. Search, copying and heading navigation remain
  available, while rich rendering and diagrams stay within that budget.

Verification:

- On 2026-09-15, the frontend suite and final affected regressions, Go tests and
  Go vet passed. Lint has 0 errors and 52 pre-existing warnings.
  `wails build -skipbindings` passed, including TypeScript, bindings, i18n, version
  and stylesheet checks. Markdown browser smoke passed, as did the document and
  terminal-workbench smoke scripts against the production bundle.
- `frontend/src/test/fixtures/mermaid-workflows.md` preserves the reported
  example. Unit tests cover sanitization, source retention, search, cancellation,
  theme races, cached rendering, copying and retry.
- `frontend/scripts/smoke-markdown.mjs` uses real Mermaid in Microsoft Edge with
  isolated mocked Wails APIs. It checks all 11 Chinese flowchart labels, light
  and dark rendering, 1440/900/540 px layouts, zoom, expanded view, copying,
  search, errors and additional label/diagram forms. Screenshots go to a unique
  system temporary directory. Run from `frontend` with Playwright on Node's
  module search path (as with `scripts/smoke-workbench.mjs`).
- `frontend/scripts/smoke-documents.mjs --preview` checks the production document
  bundle, sidebar outline and saved reading positions, shared surface colors,
  large Markdown fallback, and typography controls in narrow and short windows.

This is a frontend browser check; it does not exercise native Windows file
dialogs. Ordinary builds use `frontend/dist` for the embedded web bundle and
`build/bin/gxShell.exe` for the runnable application. No archive or installer is
created by this workflow.
