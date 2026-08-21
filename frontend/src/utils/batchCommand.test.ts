import { describe, expect, it, vi } from "vitest";
import { batchCommandMessages, sendBatchCommand } from "./batchCommand";

describe("batch commands", () => {
  it("keeps whole commands intact and splits line mode conservatively", () => {
    expect(batchCommandMessages("echo one\necho two", "whole")).toEqual(["echo one\necho two"]);
    expect(batchCommandMessages("echo one\r\n\r\necho two\n", "lines")).toEqual(["echo one", "", "echo two"]);
  });

  it("sends synchronized steps to a fixed, de-duplicated target snapshot", async () => {
    const send = vi.fn(async () => undefined);
    const progress = vi.fn();
    const result = await sendBatchCommand({
      command: "one\ntwo",
      targetIds: ["a", "b", "a"],
      options: { mode: "lines", intervalMs: 0, repeat: 2 },
      send,
      onProgress: progress,
    });
    expect(send.mock.calls).toEqual([
      ["a", "one"], ["b", "one"], ["a", "two"], ["b", "two"],
      ["a", "one"], ["b", "one"], ["a", "two"], ["b", "two"],
    ]);
    expect(result).toEqual({ sent: 8, total: 8, cancelled: false });
    expect(progress).toHaveBeenLastCalledWith(8, 8);
  });

  it("stops before the next step after cancellation", async () => {
    const controller = new AbortController();
    const send = vi.fn(async () => undefined);
    const result = await sendBatchCommand({
      command: "one\ntwo",
      targetIds: ["a", "b"],
      options: { mode: "lines", intervalMs: 0, repeat: 1 },
      send,
      signal: controller.signal,
      onProgress: (sent) => { if (sent === 2) controller.abort(); },
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ sent: 2, total: 4, cancelled: true });
  });
});
