import { createContext, useContext } from "react";

export type TransferStatus = "started" | "progress" | "resumed" | "paused" | "succeeded" | "failed" | "cancelled";

export type Transfer = {
  jobId: string;
  sessionId: string;
  runtimeId?: string;
  profileId?: string;
  generation?: number;
  sequence?: number;
  path: string;
  done: number;
  total: number;
  direction: "upload" | "download";
  status: TransferStatus;
  error?: string;
  /**
   * Byte offset a resumed transfer continued from. Present only on the one
   * "resumed" event, so the UI can distinguish "continuing an earlier partial"
   * from a transfer that genuinely started this far along.
   */
  resumedAt?: number;
  /** Current smoothed throughput in bytes per second. */
  speed?: number;
  /** Estimated seconds remaining, or 0 when unknown. */
  eta?: number;
  paused?: boolean;
  sourcePath?: string;
  targetPath?: string;
  overwrite?: boolean;
  retryable?: boolean;
  /** Compatibility with events emitted by gxShell <= 1.3.0. */
  finished?: boolean;
};

export type TransferHistoryItem = {
  key: string;
  jobId: string;
  sessionId: string;
  runtimeId?: string;
  profileId?: string;
  generation?: number;
  path: string;
  name: string;
  direction: "upload" | "download";
  status: "succeeded" | "failed" | "cancelled";
  error?: string;
  finishedAt: number;
  ok: boolean;
  sourcePath?: string;
  targetPath?: string;
  overwrite?: boolean;
  retryable?: boolean;
};

type TransfersState = {
  transfers: Record<string, Transfer>;
  history: TransferHistoryItem[];
  activeCount: number;
  cancelTransfer: (jobId: string) => Promise<boolean>;
  pauseTransfer: (jobId: string) => Promise<boolean>;
  resumeTransfer: (jobId: string) => Promise<boolean>;
  retryTransfer: (item: Pick<TransferHistoryItem, "sessionId" | "runtimeId" | "profileId" | "sourcePath" | "targetPath" | "direction" | "overwrite" | "retryable">) => Promise<boolean>;
  clearHistory: () => void;
};

export const TransfersContext = createContext<TransfersState>({
  transfers: {},
  history: [],
  activeCount: 0,
  cancelTransfer: async () => false,
  pauseTransfer: async () => false,
  resumeTransfer: async () => false,
  retryTransfer: async () => false,
  clearHistory: () => {},
});

export function transferName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

export function normalizeEvent(data: Partial<Transfer>): Transfer | null {
  if (!data.sessionId || !data.path || !data.direction) return null;
  const status: TransferStatus = data.status
    || (data.finished ? "succeeded" : "progress");
  // Legacy events did not carry a job id. The fallback is intentionally stable
  // for the lifetime of that old transfer, while current backends always send
  // a collision-free id even for two copies of the same path.
  const jobId = data.jobId || `legacy:${data.sessionId}:${data.path}:${data.direction}`;
  return {
    jobId,
    sessionId: data.sessionId,
    runtimeId: data.runtimeId,
    profileId: data.profileId,
    generation: data.generation == null ? undefined : Number(data.generation),
    sequence: data.sequence == null ? undefined : Number(data.sequence),
    path: data.path,
    done: Number(data.done) || 0,
    total: Number(data.total) || 0,
    direction: data.direction,
    status,
    error: data.error,
    resumedAt: data.resumedAt == null ? undefined : Number(data.resumedAt),
    speed: data.speed == null ? undefined : Math.max(0, Number(data.speed) || 0),
    eta: data.eta == null ? undefined : Math.max(0, Number(data.eta) || 0),
    paused: data.paused === true || status === "paused",
    sourcePath: data.sourcePath,
    targetPath: data.targetPath,
    overwrite: data.overwrite === true,
    retryable: data.retryable !== false,
    finished: data.finished,
  };
}

export function useTransfers() {
  return useContext(TransfersContext);
}
