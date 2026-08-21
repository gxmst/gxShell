import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ActionContext,
  ActionRegistry,
  createDefaultActionRegistry,
  shortcutMatches,
} from "./actionRegistry";

function context(event: KeyboardEvent, overrides: Partial<ActionContext> = {}) {
  return {
    event,
    target: null,
    isTerminalInput: false,
    isEditable: false,
    isOverlay: false,
    activeTab: "tab-1",
    activeIsMarkdown: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ActionRegistry", () => {
  it("matches structured modifiers and dispatches exactly once", () => {
    const run = vi.fn();
    const registry = new ActionRegistry().register({
      id: "test.search",
      label: "Search",
      category: "Test",
      scope: "global",
      defaultShortcuts: ["Ctrl+K"],
      shortcuts: [{ key: "k", ctrl: true }],
      run,
    });
    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true });
    const action = registry.dispatch(event, context(event));
    expect(action?.id).toBe("test.search");
    expect(run).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not dispatch an action in a protected overlay or editable field", () => {
    const run = vi.fn();
    const registry = new ActionRegistry().register({
      id: "test.action",
      label: "Action",
      category: "Test",
      scope: "global",
      defaultShortcuts: ["Ctrl+K"],
      shortcuts: [{ key: "k", ctrl: true }],
      run,
    });
    const overlayEvent = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true });
    expect(registry.dispatch(overlayEvent, context(overlayEvent, { isOverlay: true }))).toBeUndefined();
    const formEvent = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true });
    expect(registry.dispatch(formEvent, context(formEvent, { isEditable: true }))).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("reports shortcut conflicts", () => {
    const registry = new ActionRegistry();
    for (const id of ["one", "two"]) {
      registry.register({
        id,
        label: id,
        category: "Test",
        scope: "global",
        defaultShortcuts: ["Ctrl+K"],
        shortcuts: [{ key: "k", ctrl: true }],
        run: () => undefined,
      });
    }
    expect(registry.conflicts().get("ctrl+k")?.map((action) => action.id)).toEqual(["one", "two"]);
  });

  it("preserves the terminal-safe tab and search defaults", () => {
    const callbacks = {
      onGlobalSearch: vi.fn(),
      onTerminalSearch: vi.fn(),
      onCloseTab: vi.fn(),
      onNextTab: vi.fn(),
      onPrevTab: vi.fn(),
      onSelectTab: vi.fn(),
    };
    const registry = createDefaultActionRegistry(callbacks);
    const tabEvent = new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, shiftKey: true, cancelable: true });
    registry.dispatch(tabEvent, context(tabEvent));
    expect(callbacks.onPrevTab).toHaveBeenCalledTimes(1);

    const terminalEvent = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true });
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    terminal.appendChild(document.createElement("textarea"));
    document.body.appendChild(terminal);
    registry.dispatch(terminalEvent, context(terminalEvent, {
      target: terminal.firstElementChild,
      isTerminalInput: true,
    }));
    expect(callbacks.onTerminalSearch).toHaveBeenCalledTimes(1);
  });

  it("recognizes Mod as either Ctrl or Meta", () => {
    expect(shortcutMatches(new KeyboardEvent("keydown", { key: "k", metaKey: true }), { key: "k", mod: true })).toBe(true);
    expect(shortcutMatches(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }), { key: "k", mod: true })).toBe(true);
    expect(shortcutMatches(new KeyboardEvent("keydown", { key: "k" }), { key: "k", mod: true })).toBe(false);
  });
});
