import type { types } from "../../wailsjs/go/models";
import type { SplitPane, Tab } from "../types";
import { isWindowsPlatform } from "./clipboard";
import { clampSplitRatio, splitPaneIds } from "./splitPane";

export type WorkspaceItem = { key: string; kind: "profile" | "file"; target: string; title: string; pinned?: boolean; customTitle?: boolean };
export type NamedWorkspace = { id: string; name: string; items: WorkspaceItem[]; active: string; layout: { keys: string[]; direction: SplitPane["direction"]; ratio: number; rowRatio: number } | null; updatedAt: number };
export const WORKSPACES_KEY = "gx:namedWorkspaces:v1";
export const workspacePathKey = (path: string) => { const normalized = path.replace(/\\/g, "/"); return isWindowsPlatform() ? normalized.toLowerCase() : normalized; };

export function captureWorkspace(name: string, tabs: Tab[], profiles: types.Profile[], activeTab: string, split: SplitPane | null): NamedWorkspace {
  const items: WorkspaceItem[] = [];
  const tabKeys = new Map<string, string>();
  for (const tab of tabs) {
    let item: WorkspaceItem | undefined;
    if (tab.type === "markdown" && tab.markdownSource !== "remote" && tab.filePath) item = { key: `f:${workspacePathKey(tab.filePath)}`, kind: "file", target: tab.filePath, title: tab.title };
    else if (!tab.local && tab.type !== "markdown" && profiles.some((p) => p.id === tab.profileId)) item = { key: `p:${tab.profileId}`, kind: "profile", target: tab.profileId, title: tab.title };
    if (!item) continue;
    tabKeys.set(tab.id, item.key);
    if (!items.some((i) => i.key === item.key)) items.push({ ...item, pinned: tab.pinned, customTitle: tab.customTitle });
  }
  if (!name.trim() || name.trim().length > 64) throw new Error("Workspace name must contain 1 to 64 characters");
  if (!items.length || items.length > 30) throw new Error("A workspace must contain 1 to 30 saved servers or local files");
  const keys = splitPaneIds(split).map((id) => tabKeys.get(id) || "");
  const layout = split && keys.length >= 2 && keys.every(Boolean) && new Set(keys).size === keys.length
    ? { keys, direction: split.direction, ratio: clampSplitRatio(split.ratio), rowRatio: clampSplitRatio(split.rowRatio ?? 0.5) } : null;
  return { id: crypto.randomUUID(), name: name.trim(), items, active: tabKeys.get(activeTab) || items[0].key, layout, updatedAt: Date.now() };
}

export function parseWorkspaces(raw: string | null): NamedWorkspace[] {
  const data: unknown = JSON.parse(raw || "[]");
  if (!Array.isArray(data)) throw new Error("Invalid workspace data");
  const result: NamedWorkspace[] = [];
  for (const record of data.slice(0, 30)) {
    if (!record || typeof record.id !== "string" || typeof record.name !== "string" || !record.name.trim() || record.name.length > 64 || !Array.isArray(record.items)) continue;
    const items: WorkspaceItem[] = [];
    for (const item of record.items.slice(0, 30)) {
      if (!item || !["profile", "file"].includes(item.kind) || typeof item.target !== "string" || !item.target || item.target.length > 4096 || typeof item.key !== "string" || item.key.length > 4100 || items.some((i) => i.key === item.key || (i.kind === item.kind && i.target === item.target))) continue;
      items.push({ key: item.key, kind: item.kind, target: item.target, title: typeof item.title === "string" ? item.title.slice(0, 256) : item.target, pinned: item.pinned === true, customTitle: item.customTitle === true });
    }
    if (!items.length || result.some((w) => w.id === record.id)) continue;
    let layout: NamedWorkspace["layout"] = null;
    const candidate = record.layout;
    if (candidate && Array.isArray(candidate.keys) && [2, 4].includes(candidate.keys.length) && new Set(candidate.keys).size === candidate.keys.length && candidate.keys.every((key: unknown) => items.some((i) => i.key === key && i.kind === "profile"))) {
      layout = { keys: candidate.keys, direction: candidate.keys.length === 4 ? "grid" : candidate.direction === "vertical" ? "vertical" : "horizontal", ratio: clampSplitRatio(candidate.ratio), rowRatio: clampSplitRatio(candidate.rowRatio) };
    }
    result.push({ id: record.id, name: record.name.trim(), items, active: items.some((i) => i.key === record.active) ? record.active : items[0].key, layout, updatedAt: Number(record.updatedAt) || 0 });
  }
  return result;
}

// Existing document objects (and their keys) stay intact, preserving editor drafts.
export function applyWorkspace(workspace: NamedWorkspace, current: Tab[], connected: Map<string, string>, granted: string[]): { tabs: Tab[]; active: string; split: SplitPane | null; ids: string[] } {
  const tabs = [...current];
  const resolved = new Map<string, string>();
  const allowed = new Set(granted.map(workspacePathKey));
  for (const item of workspace.items) {
    if (item.kind === "profile") {
      const id = connected.get(item.target);
      let index = tabs.findIndex((tab) => tab.id === id);
      // Authentication for another server can outlast this server's reconnect.
      if (id && index < 0) index = tabs.findIndex((tab) => tab.type !== "markdown" && !tab.local && tab.profileId === item.target && ["connected", "connecting", "restoring", "reconnecting"].includes(tab.state));
      if (id && index >= 0) {
        const tab = tabs[index];
        tabs[index] = { ...tab, pinned: item.pinned, customTitle: item.customTitle, title: item.customTitle || tab.customTitle ? item.title : tab.title };
        resolved.set(item.key, tab.id);
      }
      continue;
    }
    const existing = tabs.find((tab) => tab.type === "markdown" && tab.filePath && workspacePathKey(tab.filePath) === workspacePathKey(item.target));
    if (existing) { resolved.set(item.key, existing.id); continue; }
    if (!allowed.has(workspacePathKey(item.target))) continue;
    const id = `text-${crypto.randomUUID()}`;
    tabs.push({ id, profileId: "", type: "markdown", markdownSource: "local", filePath: item.target, title: item.title, pinned: item.pinned, customTitle: item.customTitle, state: "connected" });
    resolved.set(item.key, id);
  }
  const ids = [...new Set(workspace.items.map((item) => resolved.get(item.key)).filter((id): id is string => !!id))];
  const ordered = ids.map((id) => tabs.find((tab) => tab.id === id)!);
  const rest = tabs.filter((tab) => !ids.includes(tab.id));
  const layoutIds = workspace.layout?.keys.map((key) => resolved.get(key)).filter((id): id is string => !!id) || [];
  const split: SplitPane | null = workspace.layout && layoutIds.length === workspace.layout.keys.length
    ? { left: layoutIds[0], right: layoutIds[1], bottom: layoutIds.length === 4 ? [layoutIds[2], layoutIds[3]] : undefined, direction: workspace.layout.direction, ratio: workspace.layout.ratio, rowRatio: workspace.layout.rowRatio } : null;
  return { tabs: [...ordered, ...rest], active: resolved.get(workspace.active) || ids[0] || "", split, ids };
}
