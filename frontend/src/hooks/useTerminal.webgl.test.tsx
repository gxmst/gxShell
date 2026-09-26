import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { types } from "../../wailsjs/go/models";
import { useTerminal } from "./useTerminal";
import { resetWebglNotices } from "../utils/terminalWebgl";

const mocks = vi.hoisted(() => ({
  addons: [] as Array<{
    loaded: boolean;
    disposed: boolean;
    contextLoss: (() => void) | null;
  }>,
  loaded: [] as unknown[],
}));

vi.mock("../../wailsjs/go/app/App", () => ({
  WriteToTerminal: vi.fn().mockResolvedValue(undefined),
  ResizeTerminal: vi.fn().mockResolvedValue(undefined),
  LogCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options: Record<string, unknown>;
  element = document.createElement("div");
  unicode = { activeVersion: "6" };
  parser = { registerOscHandler: vi.fn() };
  buffer = { active: { type: "normal", length: 0 } };
  constructor(options: Record<string, unknown>) { this.options = options; }
  loadAddon(addon: unknown) { mocks.loaded.push(addon); }
  open(host: HTMLElement) { host.append(this.element); }
  onScroll() {}
  onData() {}
  attachCustomKeyEventHandler() {}
  focus() {}
  dispose() {}
} }));

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { onDidChangeResults() {} dispose() {} } }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {
  disposed = false;
  contextLoss: (() => void) | null = null;
  constructor() {
    mocks.addons.push(this as unknown as (typeof mocks.addons)[number]);
  }
  onContextLoss(handler: () => void) { this.contextLoss = handler; }
  dispose() { this.disposed = true; }
} }));

const settings = new types.AppSettings({
  themeName: "Light",
  highlightLevel: "off",
  terminal: { themeName: "Light", fontFamily: "monospace", fontSize: 14, lineHeight: 1.25, scrollbackLines: 5000 },
});

/** A host with a real size, which is what tells the hook the terminal is shown. */
function sizedHost() {
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { value: 800 });
  Object.defineProperty(host, "clientHeight", { value: 400 });
  return host;
}

function mountTerminal(notify: (text: string, tone?: string) => void) {
  const { result, rerender } = renderHook(
    ({ active }: { active: boolean }) => useTerminal("a", active, settings, notify as never),
    { initialProps: { active: false } },
  );
  result.current.terminalHosts.current.a = sizedHost();
  rerender({ active: true });
  return result;
}

/**
 * Mounts the hook so the shown tab can change. mountTerminal cannot do this: it
 * pins the id to "a", which is why the budget's behaviour across a tab switch
 * went untested - and the tab switch is the only moment the budget hears that
 * the user is looking somewhere else.
 */
function mountSwitchableTabs(ids: string[]) {
  const { result, rerender } = renderHook(
    ({ active }: { active: string }) => useTerminal(active, true, settings, vi.fn() as never),
    // Start with no tab: the hosts have to exist before the attach effect runs,
    // and the effect only runs again when the shown tab actually changes.
    { initialProps: { active: "" } },
  );
  for (const id of ids) result.current.terminalHosts.current[id] = sizedHost();
  return { result, show: (id: string) => rerender({ active: id }) };
}

beforeEach(() => {
  resetWebglNotices();
  mocks.addons.length = 0;
  mocks.loaded.length = 0;
});

afterEach(() => { vi.restoreAllMocks(); });

describe("terminal WebGL lifecycle", () => {
  it("attaches hardware rendering when the terminal is opened", () => {
    mountTerminal(vi.fn());
    expect(mocks.addons).toHaveLength(1);
    expect(mocks.loaded).toContain(mocks.addons[0]);
  });

  it("names the renderer it actually fell back to, and says it only once", () => {
    const notify = vi.fn();
    mountTerminal(notify);

    act(() => { mocks.addons[0].contextLoss?.(); });

    // The old message claimed a canvas renderer, which xterm has not had since
    // v5 - the fallback is the DOM renderer.
    expect(notify).toHaveBeenCalledWith(
      "The terminal lost its WebGL context and fell back to the DOM renderer.",
      "info",
    );
    expect(mocks.addons[0].disposed).toBe(true);

    act(() => { mocks.addons[0].contextLoss?.(); });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("takes a context back when the terminal is shown again", () => {
    // Losing a context used to be permanent for that terminal: it stayed on the
    // slow renderer for the rest of the session even after a transient GPU reset.
    const result = mountTerminal(vi.fn());
    act(() => { mocks.addons[0].contextLoss?.(); });
    expect(mocks.addons).toHaveLength(1);

    act(() => { result.current.refitTerminal("a"); });

    expect(mocks.addons).toHaveLength(2);
    expect(mocks.addons[1].disposed).toBe(false);
  });

  it("does not ask for another context while it still holds one", () => {
    const result = mountTerminal(vi.fn());
    act(() => { result.current.refitTerminal("a"); });
    act(() => { result.current.refitTerminal("a"); });
    expect(mocks.addons).toHaveLength(1);
  });
});

describe("terminal WebGL budget across tab switches", () => {
  it("takes a context back on a plain tab switch, with no other trigger", () => {
    // Recovery used to need a font-size change, a split or a window resize:
    // refitTerminal is what hands a context back, and switching tabs never
    // called it. A hidden terminal host keeps its box (visibility: hidden, not
    // display: none), so no resize fires either - the tab stayed on the slow
    // renderer for the rest of the session.
    const { show } = mountSwitchableTabs(["a", "b"]);
    show("a");
    show("b");
    expect(mocks.addons).toHaveLength(2);

    act(() => { mocks.addons[0].contextLoss?.(); });
    expect(mocks.addons[0].disposed).toBe(true);

    show("a");

    expect(mocks.addons).toHaveLength(3);
    expect(mocks.addons[2].disposed).toBe(false);
  });

  it("spends the limit on a tab nobody is looking at, not the one on screen", () => {
    // The whole point of the budget is that the evicted context is not the one
    // the user is reading. Recording "recently used" only when a context is
    // created made it "recently created" instead, so the thirteenth terminal
    // evicted the oldest tab even while that tab was the visible one.
    const tabs = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"];
    const { show } = mountSwitchableTabs(tabs);
    for (const id of tabs.slice(0, 12)) show(id);
    expect(mocks.addons).toHaveLength(12);

    show("a");
    show("m");

    expect(mocks.addons).toHaveLength(13);
    expect(mocks.addons[0].disposed).toBe(false);
    expect(mocks.addons[1].disposed).toBe(true);
  });
});
