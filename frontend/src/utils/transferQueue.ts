/**
 * Runs async tasks with a bounded number in flight.
 *
 * Multi-file transfers used to run strictly one at a time: each `await` in the
 * loop left the SSH connection idle for a full round trip between files, which
 * is most of the wall time when the files are small. Running a few at once fills
 * that gap.
 *
 * The bound matters as much as the concurrency. Every in-flight transfer holds
 * an SFTP request pipeline on the same connection, so an unbounded fan-out would
 * compete with itself for bandwidth, multiply memory for read-ahead buffers, and
 * make per-file progress meaningless. A small fixed ceiling captures the win
 * without those costs.
 */

/**
 * Default number of simultaneous transfers.
 *
 * Three is deliberately conservative: the gain over serial is large (the idle
 * round trip between files disappears), while the gain from more than a handful
 * is small, because a single SSH connection is the shared bottleneck and the
 * sftp client already pipelines requests *within* one file.
 */
export const DEFAULT_TRANSFER_CONCURRENCY = 3;

export type QueueResult<T> = {
  item: T;
  error?: unknown;
};

/**
 * Runs `worker` over `items`, at most `concurrency` at a time.
 *
 * Every item is attempted even if others fail, and the failures come back in the
 * results rather than as a thrown error: a batch of ten uploads where one file is
 * unreadable should still transfer the other nine, and the caller needs to know
 * which one failed. Results are returned in input order regardless of the order
 * they finish, so a caller can pair them back up with what it submitted.
 */
export async function runQueue<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  options: { concurrency?: number; signal?: { cancelled: boolean } } = {},
): Promise<QueueResult<T>[]> {
  const limit = Math.max(1, options.concurrency ?? DEFAULT_TRANSFER_CONCURRENCY);
  const results: QueueResult<T>[] = new Array(items.length);
  let next = 0;

  // Each runner pulls the next index rather than taking a pre-sliced chunk, so
  // one slow file does not leave its lane idle while others still have work.
  const runner = async () => {
    for (;;) {
      // `signal` lets a caller stop starting new work when its context goes away
      // (the panel closed, the session changed). Transfers already in flight are
      // left to the backend's own cancellation path.
      if (options.signal?.cancelled) return;
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      try {
        await worker(item);
        results[index] = { item };
      } catch (error) {
        results[index] = { item, error };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  // Items skipped after cancellation leave holes; drop them so callers only see
  // work that actually ran.
  return results.filter((entry) => entry !== undefined);
}
