import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { types } from "../../wailsjs/go/models";
import { useTerminal } from "./useTerminal";

const mocks = vi.hoisted(() => ({
  write: vi.fn().mockResolvedValue(undefined),
  instances: [] as Array<{ key: (event: KeyboardEvent) => boolean; input: (value: string) => void; displayWrites: ReturnType<typeof vi.fn>; options: Record<string, unknown> }>,
}));

vi.mock("../../wailsjs/go/app/App", () => ({
  WriteToTerminal: mocks.write,
  ResizeTerminal: vi.fn().mockResolvedValue(undefined),
  LogCommand: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options: Record<string, unknown>;
  displayWrites = vi.fn();
  element = document.createElement("div");
  unicode = { activeVersion: "6" };
  parser = { registerOscHandler: vi.fn() };
  buffer = { active: { type: "normal", length: 0 } };
  key = (_event: KeyboardEvent) => true;
  data = (_value: string) => {};
  constructor(options: Record<string, unknown>) {
    this.options = new Proxy({ ...options }, { set: (target, key, value) => {
      this.displayWrites(key, value);
      return Reflect.set(target, key, value);
    } });
    mocks.instances.push(this);
  }
  loadAddon() {}
  open(host: HTMLElement) { host.append(this.element); }
  onScroll() {}
  onData(callback: (data: string) => void) { this.data = callback; }
  attachCustomKeyEventHandler(callback: (event: KeyboardEvent) => boolean) { this.key = callback; }
  input(value: string) { this.data(value); }
  focus() {}
  dispose() {}
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { onDidChangeResults() {} dispose() {} } }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));

afterEach(() => { vi.useRealTimers(); mocks.instances.length = 0; mocks.write.mockClear(); });

describe("terminal keyboard routing", () => {
  it("does not rebuild unchanged terminals when the tab preferences map is recreated", () => {
    vi.useFakeTimers();
    const settings = new types.AppSettings({ themeName: "Light", highlightLevel: "off", terminal: { themeName: "Light", fontFamily: "monospace", fontSize: 14, lineHeight: 1.25, scrollbackLines: 5000 } });
    let overrides = { a: settings.terminal, b: new types.TerminalSettings({ ...settings.terminal, fontSize: 18 }) };
    const frames = vi.spyOn(window, "requestAnimationFrame");
    const { result, rerender, unmount } = renderHook(({ active, id }) => useTerminal(id, active, settings, vi.fn(), null, undefined, undefined, undefined, undefined, undefined, overrides), { initialProps: { active: false, id: "a" } });
    result.current.terminalHosts.current.a = document.createElement("div");
    result.current.terminalHosts.current.b = document.createElement("div");
    rerender({ active: true, id: "a" });
    rerender({ active: true, id: "b" });
    overrides = { ...overrides };
    rerender({ active: true, id: "b" });
    act(() => vi.advanceTimersByTime(500));
    const [first, second] = mocks.instances;
    first.displayWrites.mockClear();
    second.displayWrites.mockClear();
    frames.mockClear();
    overrides = { a: new types.TerminalSettings(overrides.a), b: new types.TerminalSettings(overrides.b) };
    rerender({ active: true, id: "b" });
    expect(first.displayWrites).not.toHaveBeenCalled();
    expect(second.displayWrites).not.toHaveBeenCalled();
    expect(frames).not.toHaveBeenCalled();
    overrides = { ...overrides, a: new types.TerminalSettings({ ...overrides.a, fontSize: 20 }) };
    rerender({ active: true, id: "b" });
    expect(first.options.fontSize).toBe(20);
    expect(first.displayWrites).toHaveBeenCalled();
    expect(second.displayWrites).not.toHaveBeenCalled();
    act(() => { result.current.disposeTerminal("a"); result.current.disposeTerminal("b"); });
    unmount();
  });

  it("maps each broadcast target, applies live settings and leaves pasted controls unchanged", () => {
    vi.useFakeTimers();
    const settings = new types.AppSettings({ themeName: "Light", highlightLevel: "off", terminal: { themeName: "Light", fontSize: 14, lineHeight: 1.25, scrollbackLines: 5000 } });
    const broadcast = { current: { enabled: true, targets: ["a", "b"] } };
    let overrides = { b: new types.TerminalSettings({ backspaceKey: "ctrl-h", deleteKey: "del" }) };
    const { result, rerender, unmount } = renderHook(({ active }) => useTerminal("a", active, settings, vi.fn(), null, broadcast, undefined, undefined, undefined, undefined, overrides), { initialProps: { active: false } });
    result.current.terminalHosts.current.a = document.createElement("div");
    rerender({ active: true });
    const term = mocks.instances[0];
    const key = (name: string) => {
      act(() => {
        expect(term.key(new KeyboardEvent("keydown", { key: name, cancelable: true }))).toBe(false);
        vi.advanceTimersByTime(5);
      });
    };
    key("Backspace");
    expect(mocks.write.mock.calls).toEqual([["a", "\x7f"], ["b", "\x08"]]);
    mocks.write.mockClear();
    key("Delete");
    expect(mocks.write.mock.calls).toEqual([["a", "\x1b[3~"], ["b", "\x7f"]]);
    mocks.write.mockClear();
    act(() => { term.input("\x08\x7f\x1b[3~"); vi.advanceTimersByTime(5); });
    expect(mocks.write.mock.calls).toEqual([["a", "\x08\x7f\x1b[3~"], ["b", "\x08\x7f\x1b[3~"]]);
    mocks.write.mockClear();
    overrides = { b: new types.TerminalSettings({ backspaceKey: "del", deleteKey: "ctrl-h" }) };
    rerender({ active: true });
    key("Delete");
    expect(mocks.write.mock.calls).toEqual([["a", "\x1b[3~"], ["b", "\x08"]]);
    act(() => result.current.disposeTerminal("a"));
    unmount();
  });
});
