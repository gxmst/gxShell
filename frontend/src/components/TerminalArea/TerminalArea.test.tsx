import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../../types";
import { TerminalArea } from "./TerminalArea";
import { TerminalStatusBar } from "./TerminalStatusBar";

// The terminal chrome (state banners, split-divider labels, status strip) used
// to pick its wording with an inline `lang === "zh-CN"` ternary, so it stayed
// Chinese no matter which language the rest of the app was using. These cases
// pin the localized text; the English side is covered by the split-drag suite.

const appMocks = vi.hoisted(() => ({ getLatestMetrics: vi.fn() }));

vi.mock("../../../wailsjs/go/app/App", () => ({
  GetLatestMetrics: appMocks.getLatestMetrics,
}));

vi.mock("../../../wailsjs/runtime/runtime", () => ({
  EventsOn: vi.fn(() => () => undefined),
}));

function baseProps(tabs: Tab[], activeTab: string) {
  return {
    tabs,
    activeTab,
    profiles: [],
    terminalHosts: { current: {} },
    onActive: vi.fn(),
    onClose: vi.fn(),
    onReconnect: vi.fn(),
    onNewConnection: vi.fn(),
  };
}

describe("TerminalArea locale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appMocks.getLatestMetrics.mockResolvedValue(null);
  });

  it.each([
    ["reconnecting", "正在重连 worker…"],
    ["restoring", "正在恢复 worker…"],
    ["connecting", "正在连接 worker…"],
  ] as const)("describes the %s banner in the interface language", (state, expected) => {
    render(
      <TerminalArea
        {...baseProps([{ id: "t1", profileId: "p1", title: "worker", state } as Tab], "t1")}
        language="zh-CN"
      />,
    );

    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
  });

  it("labels a closed connection and its reconnect action in the interface language", () => {
    render(
      <TerminalArea
        {...baseProps([{ id: "t1", profileId: "p1", title: "worker", state: "disconnected" } as Tab], "t1")}
        language="zh-CN"
      />,
    );

    expect(screen.getByText("连接已断开")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重连" })).toBeInTheDocument();
  });

  it("names the split dividers in the interface language", () => {
    const tabs = ["a", "b", "c", "d"].map((id) => ({ id, profileId: id, title: id, state: "connected" })) as Tab[];
    render(
      <TerminalArea
        {...baseProps(tabs, "a")}
        language="zh-CN"
        splitPane={{ left: "a", right: "b", bottom: ["c", "d"] as [string, string], direction: "grid", ratio: 0.5, rowRatio: 0.5 }}
        onSplitChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("separator", { name: "调整窗格高度" })).toBeInTheDocument();
  });
});

describe("TerminalStatusBar locale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appMocks.getLatestMetrics.mockResolvedValue(null);
  });

  it.each([
    ["connected", "已连接"],
    ["connecting", "连接中"],
    ["reconnecting", "重连中"],
    ["restoring", "恢复中"],
    ["error", "错误"],
    ["disconnected", "已断开"],
  ] as const)("names the %s state in the interface language", (state, expected) => {
    render(
      <TerminalStatusBar
        tabId="t1"
        tab={{ id: "t1", profileId: "p1", title: "worker", state } as Tab}
        sessionCount={1}
        language="zh-CN"
      />,
    );

    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("counts sessions in the interface language", () => {
    const { rerender } = render(
      <TerminalStatusBar
        tabId="t1"
        tab={{ id: "t1", profileId: "p1", title: "worker", state: "connected" } as Tab}
        sessionCount={3}
        language="zh-CN"
      />,
    );

    expect(screen.getByText("3 个会话")).toBeInTheDocument();

    rerender(
      <TerminalStatusBar
        tabId="t1"
        tab={{ id: "t1", profileId: "p1", title: "worker", state: "connected" } as Tab}
        sessionCount={1}
        language="en"
      />,
    );

    expect(screen.getByText("1 session")).toBeInTheDocument();
  });

  it("calls a local terminal ready and names it in the interface language", () => {
    render(
      <TerminalStatusBar
        tabId="t1"
        tab={{ id: "t1", profileId: "", title: "Local", state: "connected", local: true } as Tab}
        sessionCount={1}
        language="zh-CN"
      />,
    );

    expect(screen.getByText("就绪")).toBeInTheDocument();
    expect(screen.getByText("本地终端")).toBeInTheDocument();
  });
});
