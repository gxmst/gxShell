import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CloseWindow, IsWindowMaximised, MinimiseWindow, ToggleMaximiseWindow } from "../../../wailsjs/go/app/App";
import { AppIcon } from "../../constants";
import { t } from "../../i18n";

// The application's own window chrome: with Frameless set in main.go there is
// no native caption, so this bar carries the brand, the tab bar, and the
// window buttons in one full-width strip.
//
// Dragging is CSS-driven (--wails-draggable, see styles/topbar.css). Wails
// refuses to start a drag on the second click of a double-click, which leaves
// double-click free for the platform's maximize convention — the handler below
// checks the same computed property the drag runtime checks, so a double-click
// only toggles maximize where a single click would have dragged.
export function AppTopBar({ tabbar, language, onMaximizedChange }: { tabbar: ReactNode; language: string; onMaximizedChange?: (maximized: boolean) => void }) {
  const lang = language;
  const [maximized, setMaximized] = useState(false);
  const syncTimer = useRef(0);
  // The maximized state can change outside the app too (Win+Up, snap layouts,
  // dragging to a screen edge), so re-query after every window resize. The
  // short debounce keeps interactive resizes from calling into Go per frame.
  const syncMaximized = useCallback(() => {
    if (syncTimer.current) window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(() => {
      syncTimer.current = 0;
      try {
        // window['go'] is absent under vitest and until Wails injects the
        // bindings; the chrome then simply reports "not maximized".
        IsWindowMaximised().then(setMaximized, () => undefined);
      } catch {
        /* bindings not injected yet */
      }
    }, 120);
  }, []);

  useEffect(() => {
    syncMaximized();
    window.addEventListener("resize", syncMaximized);
    return () => {
      window.removeEventListener("resize", syncMaximized);
      if (syncTimer.current) window.clearTimeout(syncTimer.current);
    };
  }, [syncMaximized]);

  useEffect(() => {
    onMaximizedChange?.(maximized);
  }, [maximized, onMaximizedChange]);

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (window.getComputedStyle(target).getPropertyValue("--wails-draggable").trim() !== "drag") return;
    try {
      ToggleMaximiseWindow().then(setMaximized, () => undefined);
    } catch {
      /* bindings not injected yet */
    }
  };

  const minimise = () => {
    try { MinimiseWindow(); } catch { /* bindings not injected yet */ }
  };
  const toggleMaximise = () => {
    try { ToggleMaximiseWindow().then(setMaximized, () => undefined); } catch { /* bindings not injected yet */ }
  };
  const close = () => {
    try { CloseWindow(); } catch { /* bindings not injected yet */ }
  };

  return (
    <header className="topbar" onDoubleClick={onDoubleClick}>
      <div className="topbar-brand" aria-hidden="true"><AppIcon /></div>
      {tabbar}
      <div className="window-controls">
        <button type="button" aria-label={t(lang, "minimizeWindow")} title={t(lang, "minimizeWindow")} onClick={minimise}>
          <svg viewBox="0 0 10 10"><path d="M1 5h8" /></svg>
        </button>
        <button type="button" aria-label={maximized ? t(lang, "restoreWindow") : t(lang, "maximizeWindow")} title={maximized ? t(lang, "restoreWindow") : t(lang, "maximizeWindow")} onClick={toggleMaximise}>
          {maximized
            ? <svg viewBox="0 0 10 10"><rect x="2.8" y="2.8" width="6" height="6" /><path d="M7 1.2H1.2V7" /></svg>
            : <svg viewBox="0 0 10 10"><rect x="1.2" y="1.2" width="7.6" height="7.6" /></svg>}
        </button>
        <button type="button" className="wc-close" aria-label={t(lang, "close")} title={t(lang, "close")} onClick={close}>
          <svg viewBox="0 0 10 10"><path d="M1.4 1.4l7.2 7.2M8.6 1.4L1.4 8.6" /></svg>
        </button>
      </div>
    </header>
  );
}
