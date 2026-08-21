import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TransfersProvider, useTransfers, type Transfer } from "./useTransfers";

const mocks = vi.hoisted(() => ({
  listener: null as null | ((event: Partial<Transfer>) => void),
  pause: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
}));

vi.mock("../../wailsjs/runtime/runtime", () => ({
  EventsOn: vi.fn((_name: string, listener: (event: Partial<Transfer>) => void) => {
    mocks.listener = listener;
    return vi.fn();
  }),
}));

vi.mock("../../wailsjs/go/app/App", () => ({
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
