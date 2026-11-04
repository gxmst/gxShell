import { describe, expect, it } from "vitest";
import type { Tab } from "../../types";
import { closeTabTargets, orderTabs, TerminalLabels } from "./tabLayout";

const tab = (id: string, extra: Partial<Tab> = {}): Tab => ({ id, profileId: "db", title: "Database", state: "connected", runtimeId: `db:${id}`, ...extra });

describe("tab presentation", () => {
  it("keeps numbers across pin/reorder/reconnect and removal without replacing custom names", () => {
    const registry = new TerminalLabels();
    const first = tab("a");
    const second = tab("b");
    expect(registry.labels([first]).get("a")).toBe("Database");
    expect([...registry.labels([first, second]).values()]).toEqual(["Database · 1", "Database · 2"]);
    expect(registry.labels([{ ...second, pinned: true }, first]).get("b")).toBe("Database · 2");
    expect(registry.labels([{ ...second, id: "reconnected" }, first]).get("reconnected")).toBe("Database · 2");
    expect(registry.labels([{ ...second, id: "reconnected" }]).get("reconnected")).toBe("Database · 2");
    expect(registry.labels([second, tab("c", { title: "Maintenance", customTitle: true })]).get("c")).toBe("Maintenance");
  });

  it("uses visual order for close-right and always preserves pinned tabs", () => {
    const tabs = orderTabs([tab("a"), tab("p", { pinned: true }), tab("b"), tab("c")]);
    expect(tabs.map((tab) => tab.id)).toEqual(["p", "a", "b", "c"]);
    expect(closeTabTargets(tabs, "b", "right")).toEqual(["c"]);
    expect(closeTabTargets(tabs, "b", "others")).toEqual(["a", "c"]);
    expect(closeTabTargets(tabs, "p", "right")).toEqual(["a", "b", "c"]);
    expect(closeTabTargets(tabs, "missing", "others")).toEqual([]);
  });
});
