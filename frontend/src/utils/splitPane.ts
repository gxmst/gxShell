import type { SplitPane, Tab } from "../types";

export const splitPaneIds = (split?: SplitPane | null): string[] => split ? [split.left, split.right, ...(split.bottom || [])] : [];
export const clampSplitRatio = (ratio: number): number => Number.isFinite(ratio) ? Math.min(0.8, Math.max(0.2, ratio)) : 0.5;

export function replaceSplitIds(split: SplitPane, ids: string[]): SplitPane {
  return { ...split, left: ids[0], right: ids[1], bottom: ids.length === 4 ? [ids[2], ids[3]] : undefined, direction: ids.length === 4 ? "grid" : split.direction === "grid" ? "horizontal" : split.direction };
}

export function reconcileSplit(split: SplitPane | null, before: Tab[], after: Tab[], floating: string[]): SplitPane | null {
  if (!split) return null;
  const available = after.filter((tab) => !floating.includes(tab.id));
  const ids = splitPaneIds(split).map((id) => {
    if (available.some((tab) => tab.id === id)) return id;
    const old = before.find((tab) => tab.id === id);
    if (!old || old.type === "markdown" || old.local) return "";
    return available.find((tab) => tab.type !== "markdown" && (old.runtimeId ? tab.runtimeId === old.runtimeId : !!old.profileId && tab.profileId === old.profileId))?.id || "";
  }).filter(Boolean);
  const unique = [...new Set(ids)];
  if (unique.length < 2) return null;
  const next = unique.length === 4 ? unique : unique.slice(0, 2);
  return splitPaneIds(split).join("\0") === next.join("\0") ? split : replaceSplitIds(split, next);
}
