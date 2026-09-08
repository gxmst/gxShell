import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { types } from "../../wailsjs/go/models";
import { useSessions } from "./useSessions";

const bridge = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(async () => undefined),
  stopMonitor: vi.fn(),
  events: new Map<string, (...args: any[]) => void>(),
}));
vi.mock("../../wailsjs/go/app/App", () => ({
  Connect: bridge.connect,
  ConnectWithSecrets: bridge.connect,
  ConnectQuick: vi.fn(),
  ConnectLocal: vi.fn(),
  Reconnect: vi.fn(),
  ReconnectWithSecrets: vi.fn(),
  Disconnect: bridge.disconnect,
  StopMonitor: bridge.stopMonitor,
  ListSessions: vi.fn(async () => []),
}));
vi.mock("../../wailsjs/runtime/runtime", () => ({
  EventsOn: (name: string, callback: (...args: any[]) => void) => {
    bridge.events.set(name, callback);
    return () => bridge.events.delete(name);
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("disconnects a replacement that completes while closing waits for monitor cleanup", async () => {
  let finishConnect!: (info: types.SessionInfo) => void;
  let finishMonitor!: () => void;
  bridge.connect.mockReturnValue(new Promise<types.SessionInfo>((resolve) => { finishConnect = resolve; }));
  bridge.stopMonitor.mockReturnValue(new Promise<void>((resolve) => { finishMonitor = resolve; }));
  const profile = new types.Profile({ id: "one", name: "one", host: "one.test", username: "ops", authType: "password", rememberPassword: true, autoReconnect: true });
  const { result } = renderHook(() => useSessions({ profiles: [profile], notify: vi.fn(), reload: vi.fn(async () => undefined), disposeTerminal: vi.fn(), restoreWorkspace: false }));
  act(() => {
    result.current.setTabs([{ id: "old", profileId: "one", title: "one", state: "connected" }]);
    result.current.setActiveTab("old");
  });
  act(() => bridge.events.get("terminal:disconnected")?.({ id: "old", state: "disconnected" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(bridge.connect).toHaveBeenCalledTimes(1);
  let closing!: Promise<void>;
  act(() => { closing = result.current.closeTab("old", true); });
  expect(bridge.stopMonitor).toHaveBeenCalledWith("old");
  await act(async () => { finishConnect(new types.SessionInfo({ id: "replacement", profileId: "one", state: "connected" })); });
  await act(async () => { finishMonitor(); await closing; });
  expect(result.current.tabs).toEqual([]);
  expect(bridge.disconnect).toHaveBeenCalledWith("replacement");
});
