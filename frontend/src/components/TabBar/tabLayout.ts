import type { Tab } from "../../types";

export function orderTabs(tabs: Tab[]): Tab[] {
  return [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
}

export function closeTabTargets(tabs: Tab[], anchorId: string, side: "others" | "right"): string[] {
  const index = tabs.findIndex((tab) => tab.id === anchorId);
  if (index < 0) return [];
  return tabs.filter((tab, position) => !tab.pinned && tab.id !== anchorId && (side === "others" || position > index)).map((tab) => tab.id);
}

// Keep a terminal's number across reorders and physical SSH replacements.
// Names are presentation only: saved names and custom titles remain intact.
export class TerminalLabels {
  private groups = new Map<string, { numbers: Map<string, number>; numbered: boolean; next: number }>();

  labels(tabs: Tab[]): Map<string, string> {
    const terminals = new Map<string, Tab[]>();
    for (const tab of tabs) {
      if (tab.type === "markdown" || tab.local || !tab.profileId) continue;
      const group = terminals.get(tab.profileId) || [];
      group.push(tab);
      terminals.set(tab.profileId, group);
    }
    for (const id of this.groups.keys()) if (!terminals.has(id)) this.groups.delete(id);
    const labels = new Map(tabs.map((tab) => [tab.id, tab.title]));
    for (const [id, tabs] of terminals) {
      const group = this.groups.get(id) || { numbers: new Map<string, number>(), numbered: false, next: 1 };
      if (tabs.length > 1) group.numbered = true;
      const liveKeys = new Set<string>();
      for (const tab of tabs) {
        const key = tab.runtimeId || (tab.instanceId !== undefined ? `${id}:${tab.instanceId}` : tab.id);
        liveKeys.add(key);
        if (!group.numbers.has(key)) group.numbers.set(key, group.next++);
        if (group.numbered && !tab.customTitle) labels.set(tab.id, `${tab.title} · ${group.numbers.get(key)}`);
      }
      for (const key of group.numbers.keys()) if (!liveKeys.has(key)) group.numbers.delete(key);
      this.groups.set(id, group);
    }
    return labels;
  }
}
