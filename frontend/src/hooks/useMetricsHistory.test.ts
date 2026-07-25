import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMetricsHistory } from "./useMetricsHistory";

// The hook subscribes through Wails' EventsOn. Capturing the registered listener
// lets a test deliver monitor:update payloads exactly as the backend would.
const listeners: ((data: unknown) => void)[] = [];
const unsubscribe = vi.fn();

vi.mock("../../wailsjs/runtime/runtime", () => ({
  EventsOn: (event: string, handler: (data: unknown) => void) => {
    if (event === "monitor:update") listeners.push(handler);
    return unsubscribe;
  },
}));

function emit(payload: Record<string, unknown>) {
  act(() => {
    for (const listener of listeners) listener(payload);
  });
}

function sample(sessionId: string, at: string, over: Record<string, unknown> = {}) {
  return {
    sessionId,
    updatedAt: at,
    cpuPercent: 10,
    memoryPercent: 20,
    diskPercent: 30,
    networkRxPerSec: 1000,
    networkTxPerSec: 500,
    ...over,
  };
}

beforeEach(() => {
  listeners.length = 0;
  unsubscribe.mockClear();
});

describe("useMetricsHistory", () => {
  it("starts empty and records samples for its own session", () => {
    const { result } = renderHook(() => useMetricsHistory("s1"));
    expect(result.current).toEqual([]);

    emit(sample("s1", "2026-07-25T10:00:00Z", { cpuPercent: 42 }));
    expect(result.current).toHaveLength(1);
    expect(result.current[0].cpuPercent).toBe(42);
  });

  it("ignores samples belonging to another session", () => {
    const { result } = renderHook(() => useMetricsHistory("s1"));
    emit(sample("s2", "2026-07-25T10:00:00Z"));
    expect(result.current).toEqual([]);
  });

  // A failed collection arrives with an error and zeroed metrics. Recording it
  // would draw a cliff to zero that never happened on the host.
  it("skips failed collections rather than recording a false drop to zero", () => {
    const { result } = renderHook(() => useMetricsHistory("s1"));
    emit(sample("s1", "2026-07-25T10:00:00Z", { cpuPercent: 55 }));
    emit(sample("s1", "2026-07-25T10:00:05Z", { cpuPercent: 0, error: "not a linux host" }));
    expect(result.current).toHaveLength(1);
    expect(result.current[0].cpuPercent).toBe(55);
  });

  it("drops a repeated tick carrying a timestamp it already recorded", () => {
    const { result } = renderHook(() => useMetricsHistory("s1"));
    emit(sample("s1", "2026-07-25T10:00:00Z"));
    emit(sample("s1", "2026-07-25T10:00:00Z"));
    expect(result.current).toHaveLength(1);
  });

  it("evicts the oldest sample once capacity is reached", () => {
    const { result } = renderHook(() => useMetricsHistory("s1", 3));
    for (let i = 0; i < 5; i++) {
      emit(sample("s1", `2026-07-25T10:00:0${i}Z`, { cpuPercent: i }));
    }
    expect(result.current).toHaveLength(3);
    // The three most recent, in order.
    expect(result.current.map((s) => s.cpuPercent)).toEqual([2, 3, 4]);
  });

  it("clears history when the session changes, so no curve carries across hosts", () => {
    const { result, rerender } = renderHook(({ id }) => useMetricsHistory(id), {
      initialProps: { id: "s1" as string | undefined },
    });
    emit(sample("s1", "2026-07-25T10:00:00Z"));
    expect(result.current).toHaveLength(1);

    rerender({ id: "s2" });
    expect(result.current).toEqual([]);
  });

  it("clamps percentages into 0-100 and floors rates at zero", () => {
    const { result } = renderHook(() => useMetricsHistory("s1"));
    emit(sample("s1", "2026-07-25T10:00:00Z", {
      cpuPercent: 140,
      memoryPercent: -5,
      networkRxPerSec: -1,
    }));
    expect(result.current[0].cpuPercent).toBe(100);
    expect(result.current[0].memoryPercent).toBe(0);
    expect(result.current[0].networkRxPerSec).toBe(0);
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useMetricsHistory("s1"));
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("subscribes to nothing without a session", () => {
    renderHook(() => useMetricsHistory(undefined));
    expect(listeners).toHaveLength(0);
  });
});
