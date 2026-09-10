# Terminal compatibility

The global terminal settings and each saved profile's terminal override now
include character encoding, TERM, Backspace and Delete preferences.

- UTF-8 remains the default. SSH terminals also support GBK/CP936, GB18030,
  Big5/CP950 and Windows-1252. Input is encoded before entering the write queue;
  stdout and stderr have independent streaming decoders before the UI, session
  logs and asciinema recordings. An unsupported input character reports an error
  instead of substituting a different character in a command.
- Encoding and TERM belong to the SSH connection and take effect after
  reconnecting. TERM defaults to `xterm-256color`; alternatives include `xterm`,
  `vt100`, `vt220`, `ansi`, `linux`, `screen`, `screen-256color` and `dumb`.
  Changing TERM advertises capabilities to the remote PTY; the renderer remains
  xterm.js. Recordings include the negotiated TERM.
- Backspace defaults to DEL (`0x7f`), with Ctrl+H (`0x08`) available. Delete
  defaults to `ESC [ 3 ~`, with DEL and Ctrl+H available. These settings apply
  immediately to unmodified physical keys. Composition, modified shortcuts,
  pasted control bytes and terminal replies retain their existing paths.
  Broadcast maps each target using its own preferences.
- UTF-16 input chunks preserve complete surrogate pairs at bridge boundaries,
  including large pastes containing supplementary Chinese characters or emoji.

Local terminal encoding remains controlled by the local PTY and shell. The
encoding setting covers interactive SSH terminal streams, not SFTP file bytes
or the separate structured CLI command API.

Validation on 2026-09-10:

- Go tests and vet pass. Known-byte codec tests exercise single-byte reads,
  escape sequences and unsupported input. A real loopback SSH server verifies
  wire bytes, TERM negotiation, UTF-8 output, session logs and recordings.
- Frontend tests cover broadcast routing with live preferences and preservation
  of pasted controls, composition/modifier handling and Unicode chunk boundaries.
- `frontend/scripts/smoke-workbench.mjs` checks actual browser Backspace/Delete
  events and per-profile broadcast, alongside the existing workbench checks at
  1440×960, 900×700 and 540×720.
- `wails build -skipbindings -o gxShell-compat.exe` succeeds. With Go 1.26.8
  windows/amd64, the executable is 21,417,984 bytes; the same-build baseline
  `gxShell-before-compat.exe` is 20,919,296 bytes: +498,688 bytes (+2.38%).
  Both are ordinary development binaries in `build/bin`; `frontend/dist` is
  the embedded web bundle. These measurements precede the Markdown changes.

Physical IME and real network-appliance acceptance remain unverified. Local
race detection requires a C compiler that is not available on PATH.
