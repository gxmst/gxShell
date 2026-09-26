import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transfer, TransferHistoryItem } from "../../hooks/useTransfers";
import { TransferCenter } from "./TransferCenter";

// TransferCenter used inline `lang === "zh-CN"` ternaries for its pause /
// resume / retry tooltips, the paused badge and the ETA suffix, so those
// stayed Chinese under an English interface (and vice versa). These cases pin
// the localized strings.

const transfersMock = vi.hoisted(() => ({
  value: {
    transfers: {} as Record<string, Transfer>,
    history: [] as TransferHistoryItem[],
    activeCount: 0,
    cancelTransfer: vi.fn(),
    pauseTransfer: vi.fn(),
    resumeTransfer: vi.fn(),
    retryTransfer: vi.fn(),
    clearHistory: vi.fn(),
  },
}));

vi.mock("../../hooks/useTransfers", () => ({
  useTransfers: () => transfersMock.value,
}));

vi.mock("../FloatingCard/FloatingCard", () => ({
  FloatingCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function transfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    jobId: "job-1",
    sessionId: "session-1",
    path: "/srv/app.tar",
    done: 512,
    total: 1024,
    direction: "download",
    status: "progress",
    ...overrides,
  };
}

function historyItem(overrides: Partial<TransferHistoryItem> = {}): TransferHistoryItem {
  return {
    key: "h1",
    jobId: "job-9",
    sessionId: "session-1",
    path: "/srv/broken.tar",
    name: "broken.tar",
    direction: "download",
    status: "failed",
    finishedAt: 0,
    ok: false,
    ...overrides,
  };
}

function renderCenter(locale: string) {
  return render(
    <TransferCenter locale={locale} onClose={vi.fn()} onOpenExplorer={vi.fn()} onUpload={vi.fn()} />,
  );
}

describe("TransferCenter locale", () => {
  beforeEach(() => {
    transfersMock.value = {
      transfers: {},
      history: [],
      activeCount: 0,
      cancelTransfer: vi.fn(),
      pauseTransfer: vi.fn(),
      resumeTransfer: vi.fn(),
      retryTransfer: vi.fn(),
      clearHistory: vi.fn(),
    };
  });

  it("offers to pause a running transfer in the interface language", () => {
    transfersMock.value.transfers = { "job-1": transfer() };
    renderCenter("zh-CN");

    expect(screen.getByTitle("暂停")).toBeInTheDocument();
  });

  it("offers to resume a paused transfer and badges it", () => {
    transfersMock.value.transfers = { "job-1": transfer({ paused: true }) };
    renderCenter("zh-CN");

    expect(screen.getByTitle("继续")).toBeInTheDocument();
    expect(screen.getByText("已暂停")).toBeInTheDocument();
  });

  it("suffixes the ETA in the interface language", () => {
    transfersMock.value.transfers = { "job-1": transfer({ eta: 90 }) };
    const { rerender } = renderCenter("zh-CN");
    expect(screen.getByText("1m 30s 剩余")).toBeInTheDocument();

    rerender(
      <TransferCenter locale="en" onClose={vi.fn()} onOpenExplorer={vi.fn()} onUpload={vi.fn()} />,
    );
    expect(screen.getByText("1m 30s left")).toBeInTheDocument();
  });

  it("labels the retry action on a failed transfer in the interface language", () => {
    transfersMock.value.history = [historyItem({ retryable: true, sourcePath: "/a", targetPath: "/b" })];
    renderCenter("zh-CN");

    expect(screen.getByTitle("重试")).toBeInTheDocument();
  });

  it("hides the retry action when the failure is not retryable", () => {
    transfersMock.value.history = [historyItem({ retryable: false, sourcePath: "/a", targetPath: "/b" })];
    renderCenter("zh-CN");

    expect(screen.queryByTitle("重试")).not.toBeInTheDocument();
  });
});
