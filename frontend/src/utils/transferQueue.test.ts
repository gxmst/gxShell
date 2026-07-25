import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TRANSFER_CONCURRENCY, runQueue } from "./transferQueue";

/** A promise plus its resolver, so a test can hold a task open deliberately. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("runQueue", () => {
  it("runs every item", async () => {
    const seen: number[] = [];
    await runQueue([1, 2, 3, 4, 5], async (n) => { seen.push(n); });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns results in input order, not completion order", async () => {
    // Later items finish first, so input order is genuinely different from the
    // order the workers resolved in.
    const results = await runQueue(["slow", "fast"], async (name) => {
      if (name === "slow") await new Promise((r) => setTimeout(r, 20));
    }, { concurrency: 2 });
    expect(results.map((r) => r.item)).toEqual(["slow", "fast"]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await runQueue(Array.from({ length: 12 }, (_, i) => i), async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    }, { concurrency: 3 });
    expect(peak).toBe(3);
  });

  it("actually runs work in parallel", async () => {
    // Three tasks that only resolve once all three have started. If the queue
    // were serial this would deadlock, so reaching the assertion proves overlap.
    const started: number[] = [];
    const gate = deferred();
    const promise = runQueue([0, 1, 2], async (n) => {
      started.push(n);
      if (started.length === 3) gate.resolve();
      await gate.promise;
    }, { concurrency: 3 });
    await gate.promise;
    expect(started).toHaveLength(3);
    await promise;
  });

  it("keeps going when one item fails, and reports which", async () => {
    const results = await runQueue(["ok-1", "bad", "ok-2"], async (name) => {
      if (name === "bad") throw new Error("unreadable");
    }, { concurrency: 2 });

    expect(results).toHaveLength(3);
    const failed = results.filter((r) => r.error);
    expect(failed).toHaveLength(1);
    expect(failed[0].item).toBe("bad");
    expect(String((failed[0].error as Error).message)).toContain("unreadable");
    // The other two must have succeeded rather than being abandoned.
    expect(results.filter((r) => !r.error).map((r) => r.item)).toEqual(["ok-1", "ok-2"]);
  });

  it("does not reject when every item fails", async () => {
    const results = await runQueue([1, 2], async () => { throw new Error("nope"); });
    expect(results.every((r) => r.error)).toBe(true);
  });

  it("handles an empty list without starting a worker", async () => {
    const worker = vi.fn();
    const results = await runQueue([], worker);
    expect(worker).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("stops starting new work once cancelled", async () => {
    const signal = { cancelled: false };
    const seen: number[] = [];
    await runQueue(Array.from({ length: 20 }, (_, i) => i), async (n) => {
      seen.push(n);
      if (seen.length === 2) signal.cancelled = true;
      await new Promise((r) => setTimeout(r, 1));
    }, { concurrency: 1, signal });

    // The exact count depends on how many were already in flight; the guarantee
    // is that it stopped well short of all 20.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.length).toBeLessThan(20);
  });

  it("treats a concurrency below 1 as serial rather than stalling", async () => {
    const seen: number[] = [];
    await runQueue([1, 2, 3], async (n) => { seen.push(n); }, { concurrency: 0 });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("defaults to a small bound", () => {
    // The value is a deliberate tradeoff (see the module comment), so pin it:
    // a silent bump would change how hard a single SSH connection is pushed.
    expect(DEFAULT_TRANSFER_CONCURRENCY).toBe(3);
  });
});
