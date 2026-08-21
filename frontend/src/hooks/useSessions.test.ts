import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { types } from "../../wailsjs/go/models";
import { restoreProfilesInBatches, useSessions } from "./useSessions";

const appMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  connectQuick: vi.fn(),
  disconnect: vi.fn(),
  stopMonitor: vi.fn(),
  listSessions: vi.fn(),
  events: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("../../wailsjs/runtime/runtime", () => ({
  EventsOn: vi.fn((name: string, callback: (payload: unknown) => void) => {
    appMocks.events.set(name, callback);
    return () => {
      if (appMocks.events.get(name) === callback) appMocks.events.delete(name);
    };
  }),
}));

vi.mock("../../wailsjs/go/app/App", () => ({
  Connect: appMocks.connect,
  ConnectQuick: appMocks.connectQuick,
  ConnectWithSecrets: vi.fn(),
  ConnectLocal: vi.fn(),
  Disconnect: appMocks.disconnect,
  ListSessions: appMocks.listSessions,
  Reconnect: vi.fn(),
  ReconnectWithSecrets: vi.fn(),
  StopMonitor: appMocks.stopMonitor,
}));

const makeProfile = (id: string) => new types.Profile({
  id,
  name: id,
  group: "Default",
  host: `${id}.test`,
  port: 22,
  username: "root",
  authType: "agent",
  rememberPassword: false,
  description: "",
  tags: [],
  favorite: false,
  cliEnabled: false,
  tunnels: [],
  autoReconnect: false,
});

describe("useSessions workspace restore", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, String(value)); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => { values.clear(); },
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() { return values.size; },
    });
    appMocks.connect.mockReset();
    appMocks.connectQuick.mockReset();
    appMocks.disconnect.mockReset();
    appMocks.stopMonitor.mockReset();
    appMocks.stopMonitor.mockResolvedValue(undefined);
    appMocks.listSessions.mockReset();
    appMocks.listSessions.mockResolvedValue([]);
    appMocks.events.clear();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("removes legacy workspace state when restore is disabled", async () => {
    localStorage.setItem("gx:workspaceProfiles", JSON.stringify(["one"]));
    localStorage.setItem("gx:workspaceActiveProfile", "one");

    renderHook(() => useSessions({
      profiles: [makeProfile("one")],
      notify: vi.fn(),
      reload: vi.fn(async () => undefined),
      disposeTerminal: vi.fn(),
      restoreWorkspace: false,
      language: "en",
    }));

    await waitFor(() => expect(localStorage.getItem("gx:workspaceProfiles")).toBeNull());
    expect(localStorage.getItem("gx:workspaceActiveProfile")).toBeNull();
    expect(appMocks.connect).not.toHaveBeenCalled();
  });

  it("restores at most three profiles concurrently", async () => {
    const profiles = Array.from({ length: 7 }, (_, index) => makeProfile(`profile-${index + 1}`));

    let inFlight = 0;
    let maxInFlight = 0;
    const pending: Array<() => void> = [];
    const connect = vi.fn((_profile: types.Profile) => new Promise<void>((resolve) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      pending.push(() => {
        inFlight -= 1;
        resolve();
      });
    }));

    const restoring = restoreProfilesInBatches(profiles, connect);

    expect(connect).toHaveBeenCalledTimes(3);
    pending.splice(0, 3).forEach((resolve) => resolve());
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(6));
    pending.splice(0, 3).forEach((resolve) => resolve());
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(7));
    pending.splice(0, 1).forEach((resolve) => resolve());
    await restoring;

    expect(maxInFlight).toBe(3);
  });

  it("ignores terminal events from an older transport generation", async () => {
    const notify = vi.fn();
    const { result } = renderHook(() => useSessions({
      profiles: [makeProfile("one")],
      notify,
      reload: vi.fn(async () => undefined),
      disposeTerminal: vi.fn(),
      restoreWorkspace: false,
      language: "en",
    }));

    await waitFor(() => expect(appMocks.events.has("terminal:connected")).toBe(true));
    act(() => {
      result.current.setTabs([{
        id: "session-new",
        profileId: "one",
        title: "one",
        state: "connecting",
        runtimeId: "profile:one",
        connectionGeneration: 1,
      }]);
      appMocks.events.get("terminal:connected")?.({
        id: "session-new",
        profileId: "one",
        name: "one",
        state: "connected",
        runtimeId: "profile:one",
        generation: 2,
      });
    });
    await waitFor(() => expect(result.current.tabs[0]?.state).toBe("connected"));

    act(() => {
      appMocks.events.get("terminal:error")?.({
        sessionId: "session-new",
        runtimeId: "profile:one",
        generation: 1,
        error: "late error from old socket",
      });
      appMocks.events.get("terminal:disconnected")?.({
        id: "session-new",
        runtimeId: "profile:one",
        generation: 1,
        state: "disconnected",
      });
    });

    await waitFor(() => expect(result.current.tabs[0]?.state).toBe("connected"));
    expect(result.current.tabs[0]?.error).toBeUndefined();
    expect(notify).not.toHaveBeenCalledWith("late error from old socket", "error");
    expect(result.current.isCurrentRuntimeEvent({ runtimeId: "profile:one", generation: 1 })).toBe(false);
  });

  it.each(["reconnecting", "restoring"])("does not duplicate a profile while it is %s", async (state) => {
    const notify = vi.fn();
    const profile = makeProfile("one");
    const { result } = renderHook(() => useSessions({
      profiles: [profile],
      notify,
      reload: vi.fn(async () => undefined),
      disposeTerminal: vi.fn(),
      restoreWorkspace: false,
      language: "en",
    }));

    act(() => {
      result.current.setTabs([{
        id: "session-existing",
        profileId: profile.id,
        title: profile.name,
        state,
      }]);
    });
    await waitFor(() => expect(result.current.tabs[0]?.state).toBe(state));

    await act(async () => result.current.connectProfile(profile));

    expect(appMocks.connect).not.toHaveBeenCalled();
    expect(result.current.activeTab).toBe("session-existing");
    expect(notify).toHaveBeenCalledWith(`${profile.name}: connection already in progress`, "info");
  });

  it("drops the live transport before reconnecting a quick-connect tab", async () => {
    const calls: string[] = [];
    let sessions = 0;
    appMocks.disconnect.mockImplementation(async () => { calls.push("disconnect"); });
    appMocks.connectQuick.mockImplementation(async () => {
      sessions += 1;
      calls.push("connect");
      return {
        id: `session-${sessions}`,
        profileId: "quick-1",
        name: "quick",
        state: "connected",
        runtimeId: "profile:quick-1",
        generation: sessions,
      };
    });
    const profile = makeProfile("quick-1");
    const { result } = renderHook(() => useSessions({
      profiles: [],
      notify: vi.fn(),
      reload: vi.fn(async () => undefined),
      disposeTerminal: vi.fn(),
      restoreWorkspace: false,
      language: "en",
    }));

    await act(async () => { await result.current.connectQuick(profile); });
    await waitFor(() => expect(result.current.tabs).toHaveLength(1));

    await act(async () => { await result.current.reconnectTab(result.current.tabs[0]); });

    // The backend hands a caller the existing session while one is healthy, so
    // a reconnect that did not disconnect first would come back with the same
    // session and only replay its post-connect actions.
    expect(calls).toEqual(["connect", "disconnect", "connect"]);
    expect(result.current.tabs[0]?.id).toBe("session-2");
  });

  it("cleans up a reconnect session when its tab is closed while connecting", async () => {
    const calls: string[] = [];
    let resolveReconnect: ((info: types.SessionInfo) => void) | undefined;
    let sessions = 0;
    appMocks.disconnect.mockImplementation(async (id: string) => { calls.push(`disconnect:${id}`); });
    appMocks.connectQuick.mockImplementation(async () => {
      sessions += 1;
      calls.push(`connect:${sessions}`);
      if (sessions === 1) {
        return {
          id: "session-1",
          profileId: "quick-1",
          name: "quick",
          state: "connected",
          runtimeId: "profile:quick-1",
          generation: 1,
        };
      }
        return new Promise<types.SessionInfo>((resolve) => { resolveReconnect = resolve; });
    });
    const profile = makeProfile("quick-1");
    const { result } = renderHook(() => useSessions({
      profiles: [],
      notify: vi.fn(),
      reload: vi.fn(async () => undefined),
      disposeTerminal: vi.fn(),
      restoreWorkspace: false,
      language: "en",
    }));

    await act(async () => { await result.current.connectQuick(profile); });
    await waitFor(() => expect(result.current.tabs).toHaveLength(1));

    let reconnectPromise: Promise<void>;
    await act(async () => {
      reconnectPromise = result.current.reconnectTab(result.current.tabs[0]);
    });
    await waitFor(() => expect(calls).toEqual(["connect:1", "disconnect:session-1", "connect:2"]));

    await act(async () => { await result.current.closeTab("session-1"); });
    await act(async () => {
      resolveReconnect?.(new types.SessionInfo({
        id: "session-2",
        profileId: "quick-1",
        name: "quick",
        state: "connected",
        runtimeId: "profile:quick-1",
        generation: 2,
        cols: 120,
        rows: 36,
        startedAt: new Date().toISOString(),
      }));
      await reconnectPromise;
    });

    expect(result.current.tabs).toHaveLength(0);
    expect(calls).toEqual(["connect:1", "disconnect:session-1", "connect:2", "disconnect:session-1", "disconnect:session-2"]);
  });
});
