import { useEffect, useRef } from "react";

type HotkeyOptions = {
  activeTab: string;
  activeIsMarkdown: boolean;
  onGlobalSearch: () => void;
  onTerminalSearch: () => void;
  onCloseTab: (id: string) => void;
  /** Move to the next/previous tab, wrapping at the ends. */
  onNextTab: () => void;
  onPrevTab: () => void;
  /** Activate a tab by its zero-based position; a no-op when out of range. */
  onSelectTab: (index: number) => void;
};

export function useHotkeys(options: HotkeyOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      // xterm receives keystrokes through a real <textarea>, so a focused
      // terminal reports one as event.target. Treating it as a form field
      // disabled every shortcut precisely when a terminal had focus — which is
      // where Ctrl+F is *supposed* to work. style/base.css draws the same
      // distinction for focus rings.
      const isTerminalInput = !!target?.closest(".xterm");
      const isEditable = !isTerminalInput
        && !!target?.closest("input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only']");
      const isOverlay = !!target?.closest("[role='dialog'], .ctx-menu, .tab-action-dropdown");
      // A dialog owns the keyboard entirely: switching tabs behind an open modal
      // would leave it pointing at a session the user can no longer see.
      if (isOverlay) return;

      const opts = optionsRef.current;

      // Tab navigation runs ahead of the form-field guard. Ctrl+Tab and Alt+digit
      // edit no text, so they stay available from a focused input, and Alt+digit
      // in particular is the terminal-emulator convention: Ctrl+digit would
      // shadow the control bytes a terminal sends (Ctrl+3 is ESC, Ctrl+8 is DEL).
      if (event.ctrlKey && event.key === "Tab") {
        event.preventDefault();
        if (event.shiftKey) opts.onPrevTab();
        else opts.onNextTab();
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-9]$/.test(event.key)) {
        event.preventDefault();
        opts.onSelectTab(Number(event.key) - 1);
        return;
      }

      // Form controls own the rest of their keystrokes. In particular Ctrl+F
      // must not erase a field's native find/edit behavior.
      if (isEditable) return;

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
