import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { types } from "../../wailsjs/go/models";
import type { Tab } from "../types";
import type { useProfiles } from "./useProfiles";
import type { useTerminal } from "./useTerminal";

// Sidebar panel width bounds. The rail is fixed chrome and is added on top of
// this, so these numbers describe the panel alone (see theme.css). The lower
// bound is where the settings panel's multi-column grids start to look cramped —
// its container query breaks at 300px — and the upper bound is a fraction of the
// viewport rather than a constant so a chosen width still yields to a small
// window instead of crowding the terminal out.
const SIDEBAR_PANEL_DEFAULT = 328;
const SIDEBAR_PANEL_MIN = 240;
const SIDEBAR_PANEL_MAX_VW = 0.32;

function clampSidebarPanelWidth(value: number, viewportWidth: number): number {
  const max = Math.max(SIDEBAR_PANEL_MIN, Math.round(viewportWidth * SIDEBAR_PANEL_MAX_VW));
  return Math.round(Math.min(Math.max(value, SIDEBAR_PANEL_MIN), max));
}

export function useSidebarResize({
  settings: profileSettings, saveSettings: profileSaveSettings, tabsRef, refitTerminal,
}: {
  settings: ReturnType<typeof useProfiles>["settings"];
  saveSettings: ReturnType<typeof useProfiles>["saveSettings"];
  tabsRef: RefObject<Tab[]>;
  refitTerminal: ReturnType<typeof useTerminal>["refitTerminal"];
}) {
  const [sidebarPanelWidth, setSidebarPanelWidth] = useState(SIDEBAR_PANEL_DEFAULT);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const effectiveSidebarWidth = clampSidebarPanelWidth(sidebarPanelWidth, viewportWidth);
  const sidebarPanelWidthRef = useRef(effectiveSidebarWidth);
  const refitTimer = useRef<number>();
  sidebarPanelWidthRef.current = effectiveSidebarWidth;
  // Stored in AppSettings.sidebarWidth, the same place the vertical split ratio
  // lives, so the layout is restored per install rather than per browser profile.
  useEffect(() => {
    const stored = profileSettings?.sidebarWidth;
    if (!stored || stored <= 0) return;
    setSidebarPanelWidth(stored);
  }, [profileSettings?.sidebarWidth]);

  // Keep the preferred width when the window shrinks. Both modes use the same
  // effective width, and enlarging the window restores the user's preference.
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // width, when given, is the value the caller already committed with
  // setSidebarPanelWidth in the same tick — React state updates are batched,
  // so reading sidebarPanelWidthRef right after setting state still yields the
  // pre-change width (the double-click reset would otherwise persist nothing,
  // or the stale value).
  const finishSidebarResize = useCallback((width?: number) => {
    // xterm reflows on a real size change only, so refit after the grid settles
    // rather than on every pointer move — a reflow per pixel is far too costly.
    window.clearTimeout(refitTimer.current);
    refitTimer.current = window.setTimeout(() => {
      refitTimer.current = undefined;
      for (const tab of tabsRef.current || []) refitTerminal(tab.id);
    }, 60);
    const settings = profileSettings;
    if (!settings) return;
    const effective = width ?? sidebarPanelWidthRef.current;
    if (settings.sidebarWidth === effective) return;
    profileSaveSettings(new types.AppSettings({ ...settings, sidebarWidth: effective })).catch(() => {
      // A failed write only costs the restored width next launch.
    });
  }, [profileSettings, profileSaveSettings, refitTerminal, tabsRef]);

  useEffect(() => () => window.clearTimeout(refitTimer.current), []);

  const beginSidebarResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const rail = document.querySelector<HTMLElement>(".left-rail");
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (!rail || !shell) return;
    const startX = event.clientX;
    const startWidth = sidebarPanelWidthRef.current;
    const handle = event.currentTarget;
    // Pointer capture retargets the move/up events to the handle, so the drag
    // survives the cursor outracing the panel edge or leaving the window.
    handle.setPointerCapture(event.pointerId);
    setSidebarResizing(true);

    const onMove = (moveEvent: PointerEvent) => {
      setSidebarPanelWidth(clampSidebarPanelWidth(startWidth + (moveEvent.clientX - startX), window.innerWidth));
    };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      try { handle.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      setSidebarResizing(false);
      finishSidebarResize();
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
    event.preventDefault();
  }, [finishSidebarResize]);

  const resetSidebarResize = useCallback(() => {
    const width = clampSidebarPanelWidth(SIDEBAR_PANEL_DEFAULT, window.innerWidth);
    setSidebarPanelWidth(width);
    // Pass the target width explicitly: the ref still holds the pre-reset
    // value until the next render, and a plain finishSidebarResize() would
    // persist that stale value instead of the default.
    finishSidebarResize(width);
  }, [finishSidebarResize]);

  // Keyboard resize (see the rail resizer in Sidebar): compute from the ref,
  // commit, and persist in one step — same contract as finishing a drag.
  const adjustSidebarWidth = useCallback((delta: number) => {
    const max = Math.max(SIDEBAR_PANEL_MIN, Math.round(window.innerWidth * SIDEBAR_PANEL_MAX_VW));
    const width = Math.round(Math.min(Math.max(sidebarPanelWidthRef.current + delta, SIDEBAR_PANEL_MIN), max));
    setSidebarPanelWidth(width);
    finishSidebarResize(width);
  }, [finishSidebarResize]);

  return {
    effectiveSidebarWidth, sidebarResizing, beginSidebarResize, resetSidebarResize, adjustSidebarWidth,
    sidebarPanelMin: SIDEBAR_PANEL_MIN,
    sidebarPanelMax: Math.max(SIDEBAR_PANEL_MIN, Math.round(viewportWidth * SIDEBAR_PANEL_MAX_VW)),
  };
}
