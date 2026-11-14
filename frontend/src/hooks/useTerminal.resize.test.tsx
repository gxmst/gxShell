import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { types } from "../../wailsjs/go/models";
import { useTerminal } from "./useTerminal";
import { TerminalArea } from "../components/TerminalArea/TerminalArea";
import { FloatingTerminal } from "../components/FloatingTerminal/FloatingTerminal";
import type { Tab } from "../types";

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
  onScroll() {}
  onData() {}
  attachCustomKeyEventHandler() {}
  focus() {}
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
  it.each([false, true])("keeps floating resize working through component rerenders and docking (initially floating: %s)", async (initiallyFloating) => {
    const settings = new types.AppSettings({ themeName: "Dark", highlightLevel: "off", terminal: { fontFamily: "monospace", fontSize: 14 } });
    const notify = vi.fn();
    const tab: Tab = { id: "a", profileId: "", title: "local", state: "connected", local: true };
    let current!: ReturnType<typeof useTerminal>;
    let mainWidth = 800;
    function Harness({ language }: { language: string }) {
      const [floating, setFloating] = useState(initiallyFloating);
      const terminal = useTerminal("a", true, settings, notify);
      current = terminal;
      useLayoutEffect(() => {
        for (const node of document.querySelectorAll<HTMLDivElement>(".terminal-host, .floating-terminal-body")) {
          const isFloating = node.classList.contains("floating-terminal-body");
          Object.defineProperty(node, "clientWidth", { configurable: true, get: () => isFloating ? parseFloat(node.parentElement!.style.width) : mainWidth });
          Object.defineProperty(node, "clientHeight", { configurable: true, get: () => isFloating ? parseFloat(node.parentElement!.style.height) - 30 : 400 });
        }
      }, [floating]);
      return <>
        <button onClick={() => setFloating(true)}>Float</button>
        <TerminalArea tabs={[tab]} activeTab="a" profiles={[]} terminalHosts={terminal.terminalHosts}
          language={language} floatingTabIds={floating ? ["a"] : []} refitTerminal={terminal.refitTerminal}
          onActive={notify} onClose={notify} onReconnect={notify} onNewConnection={notify} />
        {floating && <FloatingTerminal tab={tab} terminalHosts={terminal.terminalHosts}
          reattachTerminal={terminal.reattachTerminal} refitTerminal={terminal.refitTerminal}
          onDock={() => setFloating(false)} onClose={notify} />}
      </>;
    }
    const view = render(<Harness language="en" />);
    await act(() => vi.advanceTimersByTimeAsync(16));
    const main = view.container.querySelector<HTMLDivElement>(".terminal-host")!;
    const xterm = current.terminalHosts.current.a!.firstElementChild!;
    expect(xterm).not.toBeNull();
    if (!initiallyFloating) {
      expect(current.terminalHosts.current.a).toBe(main);
      expect(mocks.resize).toHaveBeenLastCalledWith("a", 80, 20);

      fireEvent.click(screen.getByRole("button", { name: "Float" }));
      await act(() => vi.advanceTimersByTimeAsync(16));
    }
    const floating = view.container.querySelector<HTMLDivElement>(".floating-terminal-body")!;
    expect(current.terminalHosts.current.a).toBe(floating);
    expect(floating.contains(xterm)).toBe(true);
    expect(mocks.resize).toHaveBeenLastCalledWith("a", 72, 22);

    // Both the first changed-grid hook render and an unrelated parent update
    // must leave the hidden main placeholder out of the active host registry.
    view.rerender(<Harness language="zh-CN" />);
    expect(current.terminalHosts.current.a).toBe(floating);
    const floatingObserver = Observer.instances.at(-1)!;
    const handle = view.container.querySelector<HTMLDivElement>(".floating-terminal-resize")!;
    handle.setPointerCapture = vi.fn();
    mocks.fit.mockClear(); mocks.resize.mockClear();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 720, clientY: 480 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 820, clientY: 520 });
    await act(() => vi.advanceTimersByTimeAsync(16));
    floatingObserver.notify();
    fireEvent.pointerUp(handle, { pointerId: 1 });
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(current.terminalHosts.current.a).toBe(floating);
    expect(mocks.resize).toHaveBeenLastCalledWith("a", 82, 24);
    expect(mocks.fit).toHaveBeenCalledTimes(1);

    // ResizeObserver must also remain attached after the component update.
    floating.parentElement!.style.width = "900px";
    floatingObserver.notify();
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(mocks.resize).toHaveBeenLastCalledWith("a", 90, 24);

    fireEvent.click(screen.getByTitle("Dock back"));
    await act(() => vi.advanceTimersByTimeAsync(16));
    expect(floatingObserver.disconnected).toBe(true);
    expect(current.terminalHosts.current.a).toBe(main);
    expect(main.contains(xterm)).toBe(true);
    expect(mocks.resize).toHaveBeenLastCalledWith("a", 80, 20);
    mainWidth = 1000;
    Observer.instances.at(-1)!.notify();
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(mocks.resize).toHaveBeenLastCalledWith("a", 100, 20);
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

  it("drops the old host's observer and pending work when floating or docking", async () => {
    const { element, result } = mount();
    await act(() => vi.advanceTimersByTimeAsync(16));
    mocks.fit.mockClear(); mocks.resize.mockClear();
    const old = Observer.instances[0];
    Object.defineProperty(element, "clientWidth", { value: 1000, writable: true });
    old.notify();
    const floating = host(600);
    act(() => result.current.reattachTerminal("a", floating));
    expect(old.disconnected).toBe(true);
    old.notify();
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(mocks.fit).toHaveBeenCalledTimes(1);
    expect(mocks.resize).toHaveBeenCalledExactlyOnceWith("a", 60, 20);
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

  it("disconnects a reattached host and ignores late explicit refits after unmount", async () => {
    const { result, unmount } = mount();
    const floating = host(600);
    act(() => result.current.reattachTerminal("a", floating));
    await act(() => vi.advanceTimersByTimeAsync(16));
    mocks.fit.mockClear(); mocks.resize.mockClear();
    const observer = Observer.instances.at(-1)!;
    unmount();
    expect(observer.disconnected).toBe(true);
    Object.defineProperty(floating, "clientWidth", { value: 900, writable: true });
    observer.notify();
    result.current.refitTerminal("a");
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(mocks.fit).not.toHaveBeenCalled();
    expect(mocks.resize).not.toHaveBeenCalled();
  });
});
