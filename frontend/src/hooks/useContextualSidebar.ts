import { useLayoutEffect, useRef } from "react";
import type { Drawer, Tab } from "../types";

// Follow document/terminal focus, including restored tabs and keyboard changes.
// A manual navigation choice lasts until focus moves to another document/mode.
export function useContextualSidebar(active: Tab | undefined, drawer: Drawer, setDrawer: (drawer: Drawer) => void) {
  const id = active?.id;
  const document = active?.type === "markdown";
  const previous = useRef<{ id: string; document: boolean } | null>(null);
  const terminalDrawer = useRef<Drawer>(drawer !== "documents" && drawer !== "settings" && drawer !== "ai" ? drawer : "monitor");

  useLayoutEffect(() => {
    if (!id) return;
    const last = previous.current;
    previous.current = { id, document };
    // Settings drafts and the AI conversation stay available across tab changes.
    if (drawer === "settings" || drawer === "ai") return;
    if (last?.id !== id) {
      if (document) {
        if (drawer !== "documents") setDrawer("documents");
        return;
      }
      if (last?.document || drawer === "documents") {
        setDrawer(terminalDrawer.current);
        return;
      }
    }
    if (!document && drawer !== "documents") terminalDrawer.current = drawer;
  }, [id, document, drawer, setDrawer]);
}
