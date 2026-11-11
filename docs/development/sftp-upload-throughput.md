# SFTP upload throughput

Uploads now explicitly pipeline up to 64 SFTP write requests (about 2 MiB at the
default 32 KiB packet size). The previous source wrapper hid its length, causing
the library's automatic ReadFrom selection to serialize writes even though the
client had concurrent writes enabled. This affected desktop and CLI uploads,
including the CLI approval hash wrapper.

The fix uses a bounded WriteAt worker pipeline and preserves the existing SSH connection,
proxy and jump-host route, temporary-file promotion and overwrite policy.
Pause/cancel still gate the source reader. Source hashing stays in the stream.

On a write failure, the pipeline cancels paused source reads, waits for every
dispatched write and records the earliest failed offset. This avoids the library
ReaderFrom pipeline waiting indefinitely on a paused reader after a write error.
That offset, rather than the read-ahead count, supplies the
reported confirmed progress and the truncation point. If the server cannot trim
the partial file, retry compares its complete contents against the source and
restarts on any mismatch. The comparison uses ordered concurrent SFTP reads
through WriteTo. Both file positions are reset afterwards, including when a
mismatch restarts the upload at byte zero.

Verification on Windows:

- go test ./... and go vet ./... passed.
- Protocol tests delay replies and assert several write acknowledgements are
  outstanding. They inject a failed middle write followed by later successful
  writes, check the safe truncation boundary, and retry both trimmed and
  untrimmed partials. Final SHA-256 values must match the source.
- Pause/resume, cancellation, matching and mismatching prefixes, and correct and
  incorrect CLI approval hashes are covered.
- A server write failure while the source is paused ends the transfer without
  requiring manual resume and retains the write error.
- The obsolete test that required hiding source length to prevent concurrency
  was replaced with transfer behavior tests.

Run the repeatable comparison with:

    go test ./backend/sftp -run '^$' -bench '^BenchmarkUploadHighLatency$' -benchtime=1x -count=1

Before the WriteAt worker change, a 4 MiB transfer against an isolated in-memory SFTP server with a fixed
50 ms reply delay, the sequential baseline took 10.77 s (0.39 MB/s) and the
pipelined copy took 0.60 s (6.96 MB/s), about 18 times faster. The test server
also has simulated file I/O delays. These are local simulation results, not a
bandwidth guarantee for real servers or proxy/jump-host routes.

Local race detection remains unavailable without a CGO C compiler; CI retains
that check. Ordinary desktop and CLI builds use their existing output locations
and do not create a release archive.
