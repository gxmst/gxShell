import { useEffect, useRef } from "react";

type HotkeyOptions = {
  activeTab: string;
  activeIsMarkdown: boolean;
  onGlobalSearch: () => void;
  onTerminalSearch: () => void;
  onCloseTab: (id: string) => void;
};

export function useHotkeys(options: HotkeyOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      const isEditable = !!target?.closest("input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only']");
      const isOverlay = !!target?.closest("[role='dialog'], .ctx-menu, .tab-action-dropdown");
      // Form controls, command palettes and dialogs own their keystrokes. In
      // particular Ctrl+F must not erase a field's native find/edit behavior.
      if (isEditable || isOverlay) return;

      const opts = optionsRef.current;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        opts.onGlobalSearch();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        // When a markdown tab is active, its viewer owns Ctrl+F (in-document
        // find). Yield so we neither open the terminal search nor fight it.
        if (opts.activeIsMarkdown || !opts.activeTab) return;
        // Terminal find is scoped to a focused/clicked terminal. Sidebar and
        // tool panels keep the browser/platform shortcut semantics instead.
        const terminalFocused = !!target?.closest(".xterm, .terminal-host, .floating-terminal");
        if (!terminalFocused) return;
        event.preventDefault();
        opts.onTerminalSearch();
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "w" && opts.activeTab) {
        event.preventDefault();
        opts.onCloseTab(opts.activeTab);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
