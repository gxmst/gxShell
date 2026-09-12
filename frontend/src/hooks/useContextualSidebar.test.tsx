import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { Drawer, Tab } from "../types";
import { useContextualSidebar } from "./useContextualSidebar";

const shell: Tab = { id: "shell", profileId: "server", title: "Server", state: "connected", type: "ssh" };
const doc: Tab = { id: "doc", profileId: "", title: "Notes", state: "connected", type: "markdown", filePath: "/notes.md" };

function useHarness(active?: Tab, initial: Drawer = "monitor") {
  const [drawer, setDrawer] = useState<Drawer>(initial);
  useContextualSidebar(active, drawer, setDrawer);
  return { drawer, setDrawer };
}

describe("contextual sidebar", () => {
  it("selects document navigation for restored tabs and restores the terminal tool on return", () => {
    const initialProps: { active?: Tab } = { active: shell };
    const { result, rerender } = renderHook(({ active }) => useHarness(active, "sftp"), { initialProps });
    expect(result.current.drawer).toBe("sftp");
    rerender({ active: doc });
    expect(result.current.drawer).toBe("documents");
    rerender({ active: shell });
    expect(result.current.drawer).toBe("sftp");
    rerender({ active: undefined });
    rerender({ active: doc });
    expect(result.current.drawer).toBe("documents");
  });

  it("honors manual navigation until another document becomes active", () => {
    const { result, rerender } = renderHook(({ active }) => useHarness(active), { initialProps: { active: doc } });
    act(() => result.current.setDrawer("monitor"));
    rerender({ active: { ...doc, title: "Renamed" } });
    expect(result.current.drawer).toBe("monitor");
    rerender({ active: { ...doc, id: "other-doc" } });
    expect(result.current.drawer).toBe("documents");
  });

  it.each(["settings", "ai"] as Drawer[])("keeps %s open across mode changes", (drawer) => {
    const { result, rerender } = renderHook(({ active }) => useHarness(active, drawer), { initialProps: { active: shell } });
    rerender({ active: doc });
    expect(result.current.drawer).toBe(drawer);
    rerender({ active: shell });
    expect(result.current.drawer).toBe(drawer);
  });
});
