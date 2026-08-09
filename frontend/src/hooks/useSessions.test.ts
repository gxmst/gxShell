import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { types } from "../../wailsjs/go/models";
import { restoreProfilesInBatches, useSessions } from "./useSessions";

const appMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  listSessions: vi.fn(),
}));

vi.mock("../../wailsjs/runtime/runtime", () => ({
  EventsOn: vi.fn(() => () => undefined),
}));

vi.mock("../../wailsjs/go/main/App", () => ({
  Connect: appMocks.connect,
  ConnectQuick: vi.fn(),
  ConnectWithSecrets: vi.fn(),
  ConnectLocal: vi.fn(),
  Disconnect: vi.fn(),
  ListSessions: appMocks.listSessions,
  Reconnect: vi.fn(),
  ReconnectWithSecrets: vi.fn(),
  StopMonitor: vi.fn(),
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
    appMocks.listSessions.mockReset();
    appMocks.listSessions.mockResolvedValue([]);
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
});
