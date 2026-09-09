import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { types } from "../../wailsjs/go/models";
import type { SplitPane, Tab } from "../types";
import { useSessions } from "./useSessions";
import { useNamedWorkspaces } from "./useNamedWorkspaces";
import { captureWorkspace } from "../utils/workspaces";

const bridge = vi.hoisted(() => ({ files: vi.fn(), connect: vi.fn(), events: new Map<string, (...args: any[]) => void>() }));
vi.mock("../../wailsjs/go/app/App", () => ({ RestoreTextFiles: bridge.files, Connect: bridge.connect, ConnectWithSecrets: bridge.connect, ConnectTerminal: bridge.connect, ConnectQuick: vi.fn(), ConnectLocal: vi.fn(), Disconnect: vi.fn(), ListSessions: vi.fn(async () => []), Reconnect: vi.fn(), ReconnectWithSecrets: vi.fn(), StopMonitor: vi.fn() }));
vi.mock("../../wailsjs/runtime/runtime", () => ({ EventsOn: (name: string, callback: (...args: any[]) => void) => { bridge.events.set(name, callback); return () => bridge.events.delete(name); } }));
const profiles = ["a", "b"].map((id) => new types.Profile({ id, name: id, host: `${id}.test`, username: "root", authType: "password", rememberPassword: false }));
const server = (id: string): Tab => ({ id: `session-${id}`, profileId: id, title: id, state: "connected" });
const document: Tab = { id: "doc", profileId: "", title: "notes", type: "markdown", filePath: "/notes.md", markdownSource: "local", state: "connected" };
function useHarness() {
  const sessions = useSessions({ profiles, notify: vi.fn(), reload: vi.fn(async () => undefined), disposeTerminal: vi.fn(), restoreWorkspace: false });
  const [split, setSplit] = useState<SplitPane | null>(null);
  const manager = useNamedWorkspaces({ sessions, profiles, floating: [], split, setSplit, dock: vi.fn(), language: "en" });
  return { sessions, manager, split };
}

describe("workspace restoration lifecycle", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    bridge.files.mockReset().mockResolvedValue([]);
    bridge.connect.mockReset().mockImplementation(async (id: string) => new types.SessionInfo({ id: `session-${id}`, profileId: id, state: "connected" }));
  });

  it("does not steal focus or reorder tabs after a later user action", async () => {
    let resolveFiles!: (files: string[]) => void;
    bridge.files.mockReturnValue(new Promise<string[]>((resolve) => { resolveFiles = resolve; }));
    const { result } = renderHook(useHarness);
    act(() => { result.current.sessions.setTabs([server("a"), server("b")]); result.current.sessions.setActiveTab("session-a"); });
    const workspace = captureWorkspace("Files", [document], profiles, document.id, null);
    let opening!: Promise<string[]>;
    act(() => { opening = result.current.manager.open(workspace); });
    act(() => result.current.sessions.setActiveTab("session-b"));
    await act(async () => { resolveFiles(["/notes.md"]); await opening; });
    await waitFor(() => expect(result.current.sessions.tabs).toHaveLength(3));
    expect(result.current.sessions.activeTab).toBe("session-b");
    expect(result.current.sessions.tabs.slice(0, 2).map((t) => t.id)).toEqual(["session-a", "session-b"]);
  });

  it("serializes authentication, preserves existing docs and restores layout", async () => {
    const { result } = renderHook(useHarness);
    act(() => result.current.sessions.setTabs([document]));
    const workspace = captureWorkspace("Servers", [server("a"), server("b"), document], profiles, "session-b", { left: "session-a", right: "session-b", direction: "vertical", ratio: 0.35 });
    let opening!: Promise<string[]>;
    act(() => { opening = result.current.manager.open(workspace); });
    await waitFor(() => expect(result.current.manager.secretPrompt?.profile.id).toBe("a"));
    await act(async () => result.current.manager.secretPrompt!.submit("one", ""));
    await waitFor(() => expect(result.current.manager.secretPrompt?.profile.id).toBe("b"));
    await act(async () => { await result.current.manager.secretPrompt!.submit("two", ""); await opening; });
    await waitFor(() => expect(result.current.sessions.activeTab).toBe("session-b"));
    expect(result.current.sessions.tabs.map((t) => t.id)).toEqual(["session-a", "session-b", "doc"]);
    expect(result.current.sessions.tabs[2]).toBe(document);
    expect(result.current.split).toMatchObject({ left: "session-a", right: "session-b", direction: "vertical", ratio: 0.35 });
    expect(bridge.connect).toHaveBeenCalledTimes(2);
  });

  it("cancels pending authentication without opening the next server", async () => {
    const { result } = renderHook(useHarness);
    const workspace = captureWorkspace("Servers", [server("a"), server("b")], profiles, "session-a", null);
    let opening!: Promise<string[]>;
    act(() => { opening = result.current.manager.open(workspace); });
    await waitFor(() => expect(result.current.manager.secretPrompt).not.toBeNull());
    await act(async () => { result.current.manager.cancel(); await opening; });
    expect(result.current.manager.secretPrompt).toBeNull();
    expect(bridge.connect).not.toHaveBeenCalled();
    expect(result.current.sessions.tabs).toEqual([]);
  });

  it("restores layout when an existing server reconnects while another awaits authentication", async () => {
    const { result } = renderHook(useHarness);
    act(() => result.current.sessions.setTabs([{ ...server("a"), state: "reconnecting" }]));
    const workspace = captureWorkspace("Servers", [server("a"), server("b")], profiles, "session-a", { left: "session-a", right: "session-b", direction: "horizontal", ratio: 0.4 });
    let opening!: Promise<string[]>;
    act(() => { opening = result.current.manager.open(workspace); });
    await waitFor(() => expect(result.current.manager.secretPrompt?.profile.id).toBe("b"));
    act(() => bridge.events.get("terminal:cli-session-replaced")?.({ oldSessionId: "session-a", session: new types.SessionInfo({ id: "replacement-a", profileId: "a", state: "connected" }) }));
    await act(async () => { await result.current.manager.secretPrompt!.submit("two", ""); await opening; });
    await waitFor(() => expect(result.current.manager.busy).toBe(false));
    expect(result.current.sessions.activeTab).toBe("replacement-a");
    expect(result.current.split).toMatchObject({ left: "replacement-a", right: "session-b", ratio: 0.4 });
  });
});
