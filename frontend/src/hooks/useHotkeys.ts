import { useEffect, useRef } from "react";
import {
  ActionContext,
  ActionRegistry,
} from "../actions/actionRegistry";

type HotkeyOptions = {
  activeTab: string;
  activeIsMarkdown: boolean;
  /** The one registry shared by shortcuts, palette, menus, and help UI. */
  registry: ActionRegistry<ActionContext>;
  /** Receives the action id after a registered shortcut is consumed. */
  onActionDispatch?: (actionId: string) => void;
};

export function useHotkeys(options: HotkeyOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const registryRef = useRef<ActionRegistry<ActionContext>>(options.registry);
  registryRef.current = options.registry;

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
      const opts = optionsRef.current;
      const context: ActionContext = {
        event,
        target,
        isTerminalInput,
        isEditable,
        isOverlay,
        activeTab: opts.activeTab,
        activeIsMarkdown: opts.activeIsMarkdown,
      };
      const action = registryRef.current.dispatch(event, context);
      if (action) {
        // The listener runs in capture phase so a claimed app shortcut cannot
        // first be encoded and written by xterm's textarea listener. Stopping
        // propagation is limited to handled actions; unclaimed function keys
        // and control sequences continue to the terminal normally.
        event.stopPropagation();
        opts.onActionDispatch?.(action.id);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
