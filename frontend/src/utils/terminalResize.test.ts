import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalResizeScheduler } from "./terminalResize";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => window.clearTimeout(id));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture() {
  const fit = vi.fn(() => ({ cols: 80, rows: 24 }));
  const resize = vi.fn().mockResolvedValue(undefined);
  const scheduler = createTerminalResizeScheduler({ fit, resize });
  return { fit, resize, scheduler };
}

describe("terminal resize scheduling", () => {
  it("keeps a live drag stable and fits only its latest dimensions after settling", async () => {
    const { fit, resize, scheduler } = fixture();
    for (let cols = 80; cols < 100; cols++) {
      fit.mockReturnValue({ cols, rows: 24 });
      scheduler.request("a");
      await vi.advanceTimersByTimeAsync(12);
    }
    expect(fit).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledExactlyOnceWith("a", { cols: 99, rows: 24 });
  });

  it("fits activation next frame and avoids another PTY update for unchanged rows and columns", async () => {
    const { resize, scheduler } = fixture();
    scheduler.request("a", true);
    await vi.advanceTimersByTimeAsync(16);
    expect(resize).toHaveBeenCalledTimes(1);
    scheduler.request("a");
    await vi.advanceTimersByTimeAsync(100);
    expect(resize).toHaveBeenCalledTimes(1);
  });

  it("serializes slow PTY calls and skips intermediate queued dimensions", async () => {
    const { fit, resize, scheduler } = fixture();
    let finish!: () => void;
    resize.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    scheduler.request("a", true);
    await vi.advanceTimersByTimeAsync(16);
    fit.mockReturnValue({ cols: 90, rows: 24 });
    scheduler.request("a", true);
    await vi.advanceTimersByTimeAsync(16);
    fit.mockReturnValue({ cols: 100, rows: 30 });
    scheduler.request("a", true);
    await vi.advanceTimersByTimeAsync(16);
    expect(resize).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(resize).toHaveBeenCalledTimes(2);
    expect(resize).toHaveBeenLastCalledWith("a", { cols: 100, rows: 30 });
  });

  it("retries a failed PTY update on a subsequent fit", async () => {
    const { resize, scheduler } = fixture();
    resize.mockRejectedValueOnce(new Error("bridge unavailable"));
    scheduler.request("a", true);
    await vi.advanceTimersByTimeAsync(16);
    expect(resize).toHaveBeenCalledTimes(1);
    scheduler.request("a", true);
    await vi.advanceTimersByTimeAsync(16);
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it("cancels both the settle timer and pending frame on disposal", async () => {
    const { fit, scheduler } = fixture();
    scheduler.request("a");
    scheduler.request("b", true);
    scheduler.disposeAll();
    await vi.advanceTimersByTimeAsync(500);
    expect(fit).not.toHaveBeenCalled();
  });

  it("does not deliver queued dimensions from a closed terminal after a bridge reply", async () => {
    const { fit, resize, scheduler } = fixture();
    let finish!: () => void;
    resize.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    scheduler.request("a", true);
    await vi.advanceTimersByTimeAsync(16);
    fit.mockReturnValue({ cols: 100, rows: 30 });
    scheduler.request("a", true);
    await vi.advanceTimersByTimeAsync(16);
    scheduler.dispose("a");
    finish();
    await vi.advanceTimersByTimeAsync(100);
    expect(resize).toHaveBeenCalledTimes(1);
  });
});
