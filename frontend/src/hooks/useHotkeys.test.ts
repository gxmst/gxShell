import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHotkeys } from "./useHotkeys";

// Builds the DOM shape a keystroke really originates from, so the guards in
// useHotkeys are exercised against the same `event.target` the app sees.
function mountTarget(html: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild!;
}

function press(target: EventTarget, key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

function setup(overrides: Partial<Parameters<typeof useHotkeys>[0]> = {}) {
  const handlers = {
    onGlobalSearch: vi.fn(),
    onTerminalSearch: vi.fn(),
    onCloseTab: vi.fn(),
    onNextTab: vi.fn(),
    onPrevTab: vi.fn(),
    onSelectTab: vi.fn(),
  };
  renderHook(() => useHotkeys({
    activeTab: "session-1",
    activeIsMarkdown: false,
    ...handlers,
    ...overrides,
  }));
  return handlers;
}

// A focused xterm terminal: keystrokes arrive through a real <textarea> that
// xterm keeps inside .xterm to receive input.
const TERMINAL_HTML = '<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>';

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useHotkeys", () => {
  it("opens the global search on Ctrl+K", () => {
    const handlers = setup();
    press(window, "k", { ctrl: true });
    expect(handlers.onGlobalSearch).toHaveBeenCalledTimes(1);
  });

  it("ignores a bare k with no modifier", () => {
    const handlers = setup();
    press(window, "k");
    expect(handlers.onGlobalSearch).not.toHaveBeenCalled();
  });

  it("leaves Ctrl+K alone while a form field has focus", () => {
    const handlers = setup();
    const input = mountTarget('<input type="text" />');
    press(input, "k", { ctrl: true });
    expect(handlers.onGlobalSearch).not.toHaveBeenCalled();
  });

  it("leaves shortcuts alone inside a dialog", () => {
    const handlers = setup();
    const dialog = mountTarget('<div role="dialog"><button>ok</button></div>');
    press(dialog.querySelector("button")!, "k", { ctrl: true });
    expect(handlers.onGlobalSearch).not.toHaveBeenCalled();
  });

  it("closes the active tab on Ctrl+Shift+W", () => {
    const handlers = setup();
    press(window, "w", { ctrl: true, shift: true });
    expect(handlers.onCloseTab).toHaveBeenCalledWith("session-1");
  });

  // Regression: the form-field guard used to match xterm's helper <textarea>,
  // so Ctrl+F was dead in exactly the place it is meant to work — a focused
  // terminal. Every shortcut was suppressed whenever a terminal had focus.
  it("opens the terminal search on Ctrl+F from a focused terminal", () => {
    const handlers = setup();
    const terminal = mountTarget(TERMINAL_HTML);
    press(terminal.querySelector("textarea")!, "f", { ctrl: true });
    expect(handlers.onTerminalSearch).toHaveBeenCalledTimes(1);
  });

  it("still reaches Ctrl+K from a focused terminal", () => {
    const handlers = setup();
    const terminal = mountTarget(TERMINAL_HTML);
    press(terminal.querySelector("textarea")!, "k", { ctrl: true });
    expect(handlers.onGlobalSearch).toHaveBeenCalledTimes(1);
  });

  it("does not open the terminal search when a markdown tab is active", () => {
    const handlers = setup({ activeIsMarkdown: true });
    const terminal = mountTarget(TERMINAL_HTML);
    press(terminal.querySelector("textarea")!, "f", { ctrl: true });
    expect(handlers.onTerminalSearch).not.toHaveBeenCalled();
  });

  it("does not open the terminal search from outside a terminal", () => {
    const handlers = setup();
    const panel = mountTarget('<div class="sidebar"><span>x</span></div>');
    press(panel.querySelector("span")!, "f", { ctrl: true });
    expect(handlers.onTerminalSearch).not.toHaveBeenCalled();
  });

  it("ignores keystrokes another handler already claimed", () => {
    const handlers = setup();
    // Mark the event as handled before dispatching, which is the state
    // useHotkeys checks via event.defaultPrevented.
    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(handlers.onGlobalSearch).not.toHaveBeenCalled();
  });

  describe("tab navigation", () => {
    it("moves to the next tab on Ctrl+Tab", () => {
      const handlers = setup();
      press(window, "Tab", { ctrl: true });
      expect(handlers.onNextTab).toHaveBeenCalledTimes(1);
      expect(handlers.onPrevTab).not.toHaveBeenCalled();
    });

    it("moves to the previous tab on Ctrl+Shift+Tab", () => {
      const handlers = setup();
      press(window, "Tab", { ctrl: true, shift: true });
      expect(handlers.onPrevTab).toHaveBeenCalledTimes(1);
      expect(handlers.onNextTab).not.toHaveBeenCalled();
    });

    it("selects a tab by position on Alt+digit, zero-based", () => {
      const handlers = setup();
      press(window, "3", { alt: true });
      expect(handlers.onSelectTab).toHaveBeenCalledWith(2);
    });

    // Alt+digit rather than Ctrl+digit: Ctrl+3 and Ctrl+8 are the control bytes
    // ESC and DEL, which a terminal has to keep receiving.
    it("does not select a tab on Ctrl+digit", () => {
      const handlers = setup();
      press(window, "3", { ctrl: true });
      expect(handlers.onSelectTab).not.toHaveBeenCalled();
    });

    it("ignores Alt+0, which has no first tab to select", () => {
      const handlers = setup();
      press(window, "0", { alt: true });
      expect(handlers.onSelectTab).not.toHaveBeenCalled();
    });

    // Switching tabs edits no text, so it stays available from a focused input
    // and from a terminal.
    it("switches tabs even while a form field has focus", () => {
      const handlers = setup();
      const input = mountTarget('<input type="text" />');
      press(input, "Tab", { ctrl: true });
      press(input, "2", { alt: true });
      expect(handlers.onNextTab).toHaveBeenCalledTimes(1);
      expect(handlers.onSelectTab).toHaveBeenCalledWith(1);
    });

    it("switches tabs from a focused terminal", () => {
      const handlers = setup();
      const terminal = mountTarget(TERMINAL_HTML);
      press(terminal.querySelector("textarea")!, "Tab", { ctrl: true });
      expect(handlers.onNextTab).toHaveBeenCalledTimes(1);
    });

    it("leaves tab navigation alone inside a dialog", () => {
      const handlers = setup();
      const dialog = mountTarget('<div role="dialog"><button>ok</button></div>');
      press(dialog.querySelector("button")!, "Tab", { ctrl: true });
      press(dialog.querySelector("button")!, "2", { alt: true });
      expect(handlers.onNextTab).not.toHaveBeenCalled();
      expect(handlers.onSelectTab).not.toHaveBeenCalled();
    });

    // Ctrl+Tab is the browser's own tab-cycling shortcut, and Alt+digit is a
    // WebView2 accelerator, so both have to be claimed to reach the app.
    it("claims the keystrokes it handles", () => {
      setup();
      expect(press(window, "Tab", { ctrl: true }).defaultPrevented).toBe(true);
      expect(press(window, "4", { alt: true }).defaultPrevented).toBe(true);
    });
  });
});
