import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { types } from "../../wailsjs/go/models";
import { useTerminal } from "./useTerminal";

const mocks = vi.hoisted(() => ({ fit: vi.fn(), resize: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../wailsjs/go/app/App", () => ({ ResizeTerminal: mocks.resize, WriteToTerminal: vi.fn(), LogCommand: vi.fn() }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options: Record<string, unknown>;
  cols = 80;
  rows = 24;
  element = document.createElement("div");
  unicode = { activeVersion: "6" };
  parser = { registerOscHandler: vi.fn() };
  buffer = { active: { type: "normal", length: 0 } };
  constructor(options: Record<string, unknown>) { this.options = options; }
  loadAddon(addon: { activate?: (term: unknown) => void }) { addon.activate?.(this); }
  open(host: HTMLElement) { host.append(this.element); }
  screen = "";
  write(data: string, callback?: () => void) { setTimeout(() => { this.screen += data; callback?.(); }, 0); }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
  onScroll() {}
  onData() {}
  attachCustomKeyEventHandler() {}
  focus() {}
  dispose() {}
} }));
vi.mock("@xterm/addon-serialize", () => ({ SerializeAddon: class {
  terminal!: { screen: string };
  activate(term: typeof this.terminal) { this.terminal = term; }
  serialize() { return this.terminal.screen; }
  dispose() {}
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {
  terminal!: { cols: number; rows: number; element: HTMLElement };
  activate(term: typeof this.terminal) { this.terminal = term; }
  fit() {
    const host = this.terminal.element.parentElement!;
    this.terminal.cols = Math.floor(host.clientWidth / 10);
    this.terminal.rows = Math.floor(host.clientHeight / 20);
    mocks.fit();
  }
} }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { onDidChangeResults() {} } }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock("../components/TerminalArea/TerminalStatusBar", () => ({ TerminalStatusBar: () => null }));

class Observer {
  static instances: Observer[] = [];
  host?: Element;
  disconnected = false;
  constructor(readonly callback: ResizeObserverCallback) { Observer.instances.push(this); }
  observe(host: Element) { this.host = host; }
  disconnect() { this.disconnected = true; }
  notify() { this.callback([], this as unknown as ResizeObserver); }
}
function host(width = 800) {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { value: width, writable: true });
  Object.defineProperty(element, "clientHeight", { value: 400, writable: true });
  return element;
}
function mount() {
  const settings = new types.AppSettings({ themeName: "Dark", highlightLevel: "off", terminal: { fontFamily: "monospace", fontSize: 14 } });
  const hook = renderHook(({ active }) => {
    const terminal = useTerminal("a", active, settings, vi.fn());
    return { ...terminal, dimensions: terminal.getDimensions("a") };
  }, { initialProps: { active: false } });
  const element = host();
  hook.result.current.terminalHosts.current.a = element;
  hook.rerender({ active: true });
  return { ...hook, element };
}
beforeEach(() => {
  vi.useFakeTimers();
  mocks.fit.mockClear();
  mocks.resize.mockClear();
  Observer.instances = [];
  vi.stubGlobal("ResizeObserver", Observer);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => window.clearTimeout(id));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("terminal host resize lifecycle", () => {
  it("hands off the parsed screen before output queued during native window creation", async () => {
    const { result } = mount();
    const messages: string[] = [];
    result.current.writeOutput("a", "before");
    const off = result.current.mirrorTerminal("a", state => messages.push(state.screen), data => messages.push(data));
    result.current.writeOutput("a", "during");
    await act(() => vi.advanceTimersByTimeAsync(25));
    result.current.writeOutput("a", "after");
    expect(messages).toEqual(["before", "during", "after"]);
    off?.();
    result.current.writeOutput("a", "docked");
    expect(messages).toHaveLength(3);
  });

  it("resends the workbench PTY size after another window resized the session", async () => {
    const { result } = mount();
    await act(() => vi.advanceTimersByTimeAsync(16));
    mocks.resize.mockClear();
    result.current.resizeMirror("a", 56, 15);
    act(() => result.current.refitTerminal("a"));
    await act(() => vi.advanceTimersByTimeAsync(16));
    expect(mocks.resize).toHaveBeenCalledExactlyOnceWith("a", 80, 20);
  });

  it("coalesces window geometry changes and synchronizes PTY only after local reflow", async () => {
    const { element, result } = mount();
    await act(() => vi.advanceTimersByTimeAsync(16));
    expect(mocks.resize).toHaveBeenCalledExactlyOnceWith("a", 80, 20);
    mocks.fit.mockClear(); mocks.resize.mockClear();
    const observer = Observer.instances[0];
    for (let width = 810; width <= 1000; width += 10) {
      Object.defineProperty(element, "clientWidth", { value: width, writable: true });
      observer.notify();
      await act(() => vi.advanceTimersByTimeAsync(12));
    }
    expect(mocks.fit).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(mocks.fit).toHaveBeenCalledTimes(1);
    expect(mocks.resize).toHaveBeenCalledExactlyOnceWith("a", 100, 20);
    expect(result.current.getDimensions("a")).toEqual({ cols: 100, rows: 20 });
    expect(result.current.dimensions).toEqual({ cols: 100, rows: 20 });
  });

  it("avoids fitting hidden terminals and fits them when shown again", async () => {
    const { element, result } = mount();
    await act(() => vi.advanceTimersByTimeAsync(16));
    mocks.fit.mockClear();
    element.classList.add("terminal-hidden");
    act(() => result.current.refitTerminal("a"));
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(mocks.fit).not.toHaveBeenCalled();
    element.classList.remove("terminal-hidden");
    act(() => result.current.refitTerminal("a"));
    await act(() => vi.advanceTimersByTimeAsync(16));
    expect(mocks.fit).toHaveBeenCalledTimes(1);
  });

  it("cancels resize work on unmount", async () => {
    const { element, unmount } = mount();
    await act(() => vi.advanceTimersByTimeAsync(16));
    mocks.fit.mockClear(); mocks.resize.mockClear();
    Object.defineProperty(element, "clientWidth", { value: 1000, writable: true });
    Observer.instances[0].notify();
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(mocks.fit).not.toHaveBeenCalled();
    expect(mocks.resize).not.toHaveBeenCalled();
  });

  it("cancels host resize work when disposing a terminal", async () => {
    const { element, result } = mount();
    await act(() => vi.advanceTimersByTimeAsync(16));
    mocks.fit.mockClear(); mocks.resize.mockClear();
    const observer = Observer.instances[0];
    Object.defineProperty(element, "clientWidth", { value: 1000, writable: true });
    observer.notify();
    act(() => result.current.disposeTerminal("a"));
    expect(observer.disconnected).toBe(true);
    expect(result.current.terminalHosts.current.a).toBeUndefined();
    observer.notify();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(mocks.fit).not.toHaveBeenCalled();
    expect(mocks.resize).not.toHaveBeenCalled();
  });

  it("ignores late explicit refits after unmount", async () => {
    const { result, unmount } = mount();
    const refit = result.current.refitTerminal;
    unmount();
    refit("a");
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(mocks.resize).not.toHaveBeenCalled();
  });
});
