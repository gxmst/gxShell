import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { types } from "../../wailsjs/go/models";
import { useSessions } from "./useSessions";

const bridge = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn<(id: string) => Promise<void>>(),
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
  bridge.connect.mockReset();
  bridge.disconnect.mockReset().mockResolvedValue(undefined);
  bridge.stopMonitor.mockReset().mockResolvedValue(undefined);
  bridge.events.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["monitor cleanup", "old-session disconnect", "tab removal"])("disconnects a replacement that completes during %s", async (phase) => {
  let finishConnect!: (info: types.SessionInfo) => void;
  let finishCleanup!: () => void;
  bridge.connect.mockReturnValue(new Promise<types.SessionInfo>((resolve) => { finishConnect = resolve; }));
  const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
  if (phase === "monitor cleanup") bridge.stopMonitor.mockReturnValue(cleanup);
  bridge.disconnect.mockImplementation(async (id: string) => {
    if (id !== "old") return;
    bridge.events.get("terminal:disconnected")?.({ id: "old", state: "disconnected" });
    if (phase === "old-session disconnect") await cleanup;
  });
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
  await act(async () => { if (phase === "tab removal") await closing; });
  expect(bridge.stopMonitor).toHaveBeenCalledWith("old");
  if (phase !== "tab removal") expect(result.current.tabs[0]?.id).toBe("old");
  await act(async () => { finishConnect(new types.SessionInfo({ id: "replacement", profileId: "one", state: "connected" })); });
  await act(async () => { finishCleanup(); await closing; });
  expect(result.current.tabs).toEqual([]);
  expect(result.current.activeTab).toBe("");
  expect(bridge.disconnect).toHaveBeenCalledWith("replacement");
  expect(bridge.disconnect).toHaveBeenCalledTimes(2);
});

it.each(["another tab", "a pending connection"])("preserves a replacement claimed by %s after closing", async (owner) => {
  let finishConnect!: (info: types.SessionInfo) => void;
  let finishMonitor!: () => void;
  bridge.connect.mockReturnValue(new Promise<types.SessionInfo>((resolve) => { finishConnect = resolve; }));
  bridge.stopMonitor.mockReturnValue(new Promise<void>((resolve) => { finishMonitor = resolve; }));
  const profile = new types.Profile({ id: "one", name: "one", host: "one.test", username: "ops", authType: "password", rememberPassword: true, autoReconnect: true });
  const { result } = renderHook(() => useSessions({ profiles: [profile], notify: vi.fn(), reload: vi.fn(async () => undefined), disposeTerminal: vi.fn(), restoreWorkspace: false }));
  act(() => result.current.setTabs([{ id: "old", profileId: "one", title: "one", state: "connected" }]));
  act(() => bridge.events.get("terminal:disconnected")?.({ id: "old", state: "disconnected" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  const replacement = new types.SessionInfo({ id: "replacement", profileId: "one", state: "connected" });
  let closing!: Promise<void>;
  let connecting: Promise<void> | undefined;
  act(() => { closing = result.current.closeTab("old", true); });
  if (owner === "another tab") {
    act(() => bridge.events.get("terminal:cli-session")?.(replacement));
  } else {
    await act(async () => { finishMonitor(); await closing; });
    act(() => { connecting = result.current.connectProfile(profile); });
    expect(bridge.connect).toHaveBeenCalledTimes(2);
  }
  await act(async () => { finishConnect(replacement); await connecting; });
  await act(async () => { finishMonitor(); await closing; });
  expect(result.current.tabs.map((tab) => tab.id)).toEqual(["replacement"]);
  expect(bridge.disconnect).not.toHaveBeenCalledWith("replacement");
});
