import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTransfers, type Transfer } from "./useTransfers";
import { TransfersProvider } from "./TransfersProvider";

const mocks = vi.hoisted(() => ({
  listener: null as null | ((event: Partial<Transfer>) => void),
  snapshot: vi.fn(),
  clearListener: null as null | ((event: {sessionId: string; revision: number}) => void),
  pause: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
}));

vi.mock("../../wailsjs/runtime/runtime", () => ({
  EventsOn: vi.fn((_name: string, listener: (event: Partial<Transfer>) => void) => {
    if (_name === "sftp:progress") mocks.listener = listener;
    else mocks.clearListener = listener;
    return vi.fn();
  }),
}));

vi.mock("../../wailsjs/go/app/App", () => ({
  ClearTransferHistory: vi.fn(),
  GetTransferSnapshot: mocks.snapshot,
  CancelTransfer: mocks.cancel,
  PauseTransfer: mocks.pause,
  ResumeTransfer: mocks.resume,
  UploadFileWithPolicy: mocks.upload,
  DownloadFileWithPolicy: mocks.download,
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <TransfersProvider>{children}</TransfersProvider>
);

describe("TransfersProvider", () => {
  beforeEach(() => {
    mocks.listener = null;
    mocks.clearListener = null;
    mocks.snapshot.mockReset().mockResolvedValue({revision: 0, events: []});
    mocks.pause.mockReset().mockResolvedValue(true);
    mocks.resume.mockReset().mockResolvedValue(true);
    mocks.cancel.mockReset().mockResolvedValue(true);
    mocks.upload.mockReset().mockResolvedValue(undefined);
    mocks.download.mockReset().mockResolvedValue(undefined);
  });

  it("keeps pause, speed and ETA state from lifecycle events", () => {
    const { result } = renderHook(() => useTransfers(), { wrapper });
    act(() => mocks.listener?.({
      jobId: "job-1",
      sessionId: "session-1",
      path: "/remote/file.bin",
      direction: "download",
      status: "paused",
      done: 512,
      total: 1024,
      speed: 128,
      eta: 4,
      paused: true,
      sourcePath: "/remote/file.bin",
      targetPath: "C:/local/file.bin",
    }));

    expect(result.current.transfers["job-1"]).toMatchObject({
      status: "paused",
      paused: true,
      speed: 128,
      eta: 4,
      sourcePath: "/remote/file.bin",
      targetPath: "C:/local/file.bin",
    });
  });

  it("hydrates an already-paused job and applies clears and completions that raced startup", async () => {
    const job: Partial<Transfer> = { jobId: "a", sessionId: "one", path: "/a", direction: "download" };
    let finish!: (snapshot: { revision: number; events: Partial<Transfer>[] }) => void;
    mocks.snapshot.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useTransfers(), { wrapper });
    await act(async () => {
      mocks.clearListener?.({ sessionId: "one", revision: 5 });
      mocks.listener?.({ ...job, sequence: 3, revision: 4, status: "succeeded" });
      finish({ revision: 3, events: [{ ...job, status: "paused", sequence: 2, revision: 2 },
        { ...job, jobId: "b", sessionId: "two", status: "paused", sequence: 1, revision: 3 }] });
    });
    expect(result.current.transfers.a).toBeUndefined();
    expect(result.current.transfers.b.paused).toBe(true);
    expect(result.current.history).toHaveLength(0);
    act(() => mocks.listener?.({ ...job, jobId: "old", revision: 1, status: "succeeded" }));
    expect(result.current.history).toHaveLength(0);
  });

  it("retries a failed transfer using the original direction and paths", async () => {
    const { result } = renderHook(() => useTransfers(), { wrapper });
    act(() => mocks.listener?.({
      jobId: "job-2",
      sessionId: "session-2",
      path: "/remote/file.bin",
      direction: "download",
      status: "failed",
      sourcePath: "/remote/file.bin",
      targetPath: "C:/local/file.bin",
      overwrite: true,
      retryable: true,
      error: "network error",
    }));

    expect(result.current.history).toHaveLength(1);
    await act(async () => {
      expect(await result.current.retryTransfer(result.current.history[0])).toBe(true);
    });
    expect(mocks.download).toHaveBeenCalledWith(
      "session-2",
      "/remote/file.bin",
      "C:/local/file.bin",
      true,
    );
  });

  it("ignores out-of-order and post-terminal events", () => {
    const { result } = renderHook(() => useTransfers(), { wrapper });
    act(() => mocks.listener?.({
      jobId: "job-race", sessionId: "session-1", path: "/tmp/file",
      direction: "download", status: "progress", sequence: 1,
    }));
    act(() => mocks.listener?.({
      jobId: "job-race", sessionId: "session-1", path: "/tmp/file",
      direction: "download", status: "succeeded", sequence: 3,
    }));
    act(() => mocks.listener?.({
      jobId: "job-race", sessionId: "session-1", path: "/tmp/file",
      direction: "download", status: "paused", paused: true, sequence: 2,
    }));
    act(() => mocks.listener?.({
      jobId: "job-race", sessionId: "session-1", path: "/tmp/file",
      direction: "download", status: "progress", sequence: 4,
    }));

    expect(result.current.transfers["job-race"]).toBeUndefined();
    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0].status).toBe("succeeded");
  });

  it("retries against the current session for the same runtime", async () => {
    const resolvingWrapper = ({ children }: { children: ReactNode }) => (
      <TransfersProvider resolveSessionId={(item) => item.runtimeId === "profile:one" ? "session-new" : undefined}>
        {children}
      </TransfersProvider>
    );
    const { result } = renderHook(() => useTransfers(), { wrapper: resolvingWrapper });
    act(() => mocks.listener?.({
      jobId: "job-reconnect", sessionId: "session-old", runtimeId: "profile:one",
      profileId: "one", path: "/remote/file.bin", direction: "download",
      status: "failed", sequence: 2, sourcePath: "/remote/file.bin",
      targetPath: "C:/local/file.bin", retryable: true,
    }));

    await act(async () => {
      expect(await result.current.retryTransfer(result.current.history[0])).toBe(true);
    });
    expect(mocks.download).toHaveBeenCalledWith(
      "session-new", "/remote/file.bin", "C:/local/file.bin", false,
    );
  });
});
