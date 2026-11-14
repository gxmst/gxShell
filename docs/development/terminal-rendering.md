# Terminal resize and rendering

All live-terminal resize paths use `createTerminalResizeScheduler`:

- Container geometry changes wait for 80 ms of stability, then fit on the next
  animation frame. Local reflow and the PTY resize happen together.
- Initial activation, tab changes, font changes and explicit refits can fit on
  the next frame. A `ResizeObserver` handles subsequent geometry changes without
  a duplicate window resize listener.
- Unchanged rows/columns do not send another acknowledged PTY update. Slow
  bridge calls are serialized per session; queued sizes collapse to the latest.
  Failed updates can retry on a subsequent fit.
- Moving a terminal replaces its observer and cancels pending work on the old
  host. Hidden terminals skip fits; disposal cancels timers, animation frames
  and queued PTY updates. An in-flight bridge call cannot be recalled.
- Main-area placeholders register their hosts only while docked. Their stable
  refs clear only their own registration, so parent renders cannot overwrite a
  floating terminal's host or invalidate its observer.
  Floating hosts register during the DOM commit, allowing a restored floating
  layout to initialize xterm directly in its visible host.

During continuous resizing, the existing grid can be clipped or leave background
space until the final fit. Terminal hosts retain their session-specific background.
The WebGL addon's default buffer setting is retained: preserving a drawing buffer
does not preserve its contents when canvas dimensions change.

## Checks

The ordinary frontend test suite covers debounce, activation, hidden hosts,
reattachment, disposal, failed bridge calls and slow bridge replies. A component
integration case mounts TerminalArea, FloatingTerminal and useTerminal together
and covers the first fit, parent renders, pointer resize, observer resize and
resizing again after docking.

For a real-renderer browser smoke check, run from `frontend/`:

```sh
node scripts/check-terminal-resize.mjs
node scripts/check-terminal-resize.mjs --compare-head
```

This uses the existing fictional marketing fixture and requires Playwright on
`NODE_PATH` plus Edge (or `PLAYWRIGHT_CHANNEL`). It starts a temporary local Vite
server, blocks external network requests and checks dark/light terminal rendering,
fit counts and final PTY dimensions. The current implementation also exercises
tear-off, parent renders, floating pointer resize and resizing after docking.
`--compare-head` loads the hook from Git HEAD
as a comparison without modifying the checkout. Temporary screenshots and results
go to the repository's `.tmp/terminal-resize-check/` directory.

The headless smoke check uses software WebGL. It verifies xterm behavior, but
does not measure Win32/WebView2 native-window compositing. Validate native edge
dragging, maximize/restore, splits, floating/docking and full-screen terminal
programs on a desktop build when investigating remaining visual flicker.
