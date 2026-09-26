import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { types } from "../../wailsjs/go/models";
import type { SplitPane, Tab } from "../types";
import { useSessions } from "./useSessions";
import { useNamedWorkspaces } from "./useNamedWorkspaces";
import { captureWorkspace, WORKSPACES_KEY } from "../utils/workspaces";

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
    let opening!: Promise<string[] | null>;
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
    let opening!: Promise<string[] | null>;
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
    let opening!: Promise<string[] | null>;
    act(() => { opening = result.current.manager.open(workspace); });
    await waitFor(() => expect(result.current.manager.secretPrompt).not.toBeNull());
    await act(async () => { result.current.manager.cancel(); await opening; });
    expect(result.current.manager.secretPrompt).toBeNull();
    expect(bridge.connect).not.toHaveBeenCalled();
    expect(result.current.sessions.tabs).toEqual([]);
  });

  it("restores separate instances of one profile and their split layout", async () => {
    bridge.connect.mockImplementation(async (id: string, instanceId: string) => new types.SessionInfo({ id: `session-${instanceId}`, profileId: id, instanceId, state: "connected" }));
    const { result } = renderHook(useHarness);
    const tabs = ["first", "second"].map((instanceId) => ({ ...server("a"), id: `session-${instanceId}`, instanceId }));
    const workspace = captureWorkspace("Instances", tabs, profiles, tabs[1].id, { left: tabs[0].id, right: tabs[1].id, direction: "horizontal", ratio: 0.5 });
    let opening!: Promise<string[] | null>;
    act(() => { opening = result.current.manager.open(workspace); });
    await waitFor(() => expect(result.current.manager.secretPrompt).not.toBeNull());
    await act(async () => { await result.current.manager.secretPrompt!.submit("one", ""); });
    await waitFor(() => expect(bridge.connect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.manager.secretPrompt).not.toBeNull());
    await act(async () => { await result.current.manager.secretPrompt!.submit("two", ""); await opening; });
    await waitFor(() => expect(result.current.sessions.tabs).toHaveLength(2));
    expect(result.current.sessions.tabs.map((tab) => tab.instanceId)).toEqual(["first", "second"]);
    expect(result.current.sessions.activeTab).toBe("session-second");
    expect(result.current.split).toMatchObject({ left: "session-first", right: "session-second" });
  });

  it("restores layout when an existing server reconnects while another awaits authentication", async () => {
    const { result } = renderHook(useHarness);
    act(() => result.current.sessions.setTabs([{ ...server("a"), state: "reconnecting" }]));
    const workspace = captureWorkspace("Servers", [server("a"), server("b")], profiles, "session-a", { left: "session-a", right: "session-b", direction: "horizontal", ratio: 0.4 });
    let opening!: Promise<string[] | null>;
    act(() => { opening = result.current.manager.open(workspace); });
    await waitFor(() => expect(result.current.manager.secretPrompt?.profile.id).toBe("b"));
    act(() => bridge.events.get("terminal:cli-session-replaced")?.({ oldSessionId: "session-a", session: new types.SessionInfo({ id: "replacement-a", profileId: "a", state: "connected" }) }));
    await act(async () => { await result.current.manager.secretPrompt!.submit("two", ""); await opening; });
    await waitFor(() => expect(result.current.manager.busy).toBe(false));
    expect(result.current.sessions.activeTab).toBe("replacement-a");
    expect(result.current.split).toMatchObject({ left: "replacement-a", right: "session-b", ratio: 0.4 });
  });
});

// These strings reach the user twice over: `open` returns them and
// WorkspacesModal renders them in a role="alert" region, and the other
// callbacks throw them into the same place. They used to be English literals
// (or zh/en ternaries), so a zh-CN UI showed English. Asserting the localized
// text is what keeps the wiring load-bearing — the English wording is
// unchanged, so an English assertion would pass either way.
function useZhHarness() {
  const sessions = useSessions({ profiles, notify: vi.fn(), reload: vi.fn(async () => undefined), disposeTerminal: vi.fn(), restoreWorkspace: false, language: "zh-CN" });
  const [split, setSplit] = useState<SplitPane | null>(null);
  const manager = useNamedWorkspaces({ sessions, profiles, floating: [], split, setSplit, dock: vi.fn(), language: "zh-CN" });
  return { sessions, manager, split };
}

describe("workspace notices follow the language setting", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    bridge.files.mockReset().mockResolvedValue([]);
    bridge.connect.mockReset().mockImplementation(async (id: string) => new types.SessionInfo({ id: `session-${id}`, profileId: id, state: "connected" }));
  });

  it("reports an unavailable file in the requested locale", async () => {
    const { result } = renderHook(useZhHarness);
    const workspace = captureWorkspace("Files", [document], profiles, document.id, null);
    let opening!: Promise<string[] | null>;
    let issues: string[] | null = null;
    act(() => { opening = result.current.manager.open(workspace); });
    await act(async () => { issues = await opening; });

    expect(issues).toEqual(["/notes.md: 文件不可用或需要重新授权"]);
  });

  it("throws workspace name errors in the requested locale", () => {
    const { result } = renderHook(useZhHarness);

    expect(() => result.current.manager.rename("missing", "")).toThrow("工作区名称需为 1 到 64 个字符");
  });

  it("reports a duplicate workspace name in the requested locale", () => {
    const { result } = renderHook(useZhHarness);
    act(() => result.current.sessions.setTabs([server("a")]));
    act(() => result.current.manager.snapshot("Named"));

    expect(() => result.current.manager.snapshot("named")).toThrow("工作区名称已存在");
  });

  it("reports captureWorkspace rejections in the requested locale", () => {
    const { result } = renderHook(useZhHarness);

    // No eligible tabs, so captureWorkspace rejects before anything is stored.
    expect(() => result.current.manager.snapshot("Empty")).toThrow("工作区需包含 1 到 30 个已保存的服务器或本地文件");
  });

  it("reports invalid stored data in the requested locale", () => {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify({ not: "an array" }));

    const { result } = renderHook(useZhHarness);

    // storageError is String(err) — the same text WorkspacesModal renders.
    expect(result.current.manager.storageError).toBe("Error: 工作区数据无效");
  });

  it("reports a stale preview in the requested locale", async () => {
    const { result } = renderHook(useZhHarness);
    const next = JSON.stringify([captureWorkspace("W", [server("a")], profiles, "session-a", null)]);
    localStorage.setItem(WORKSPACES_KEY, "changed behind the preview");

    await act(async () => {
      await expect(result.current.manager.restoreBackup(null, next, async () => undefined)).rejects.toThrow("工作区在预览后已变化，请重新预览");
    });
  });
});
