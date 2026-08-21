import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CancelTransfer, DownloadFileWithPolicy, PauseTransfer, ResumeTransfer, UploadFileWithPolicy } from "../../wailsjs/go/app/App";
import { EventsOn } from "../../wailsjs/runtime/runtime";

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

const TransfersContext = createContext<TransfersState>({
  transfers: {},
  history: [],
  activeCount: 0,
  cancelTransfer: async () => false,
  pauseTransfer: async () => false,
  resumeTransfer: async () => false,
  retryTransfer: async () => false,
  clearHistory: () => {},
});

function transferName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function normalizeEvent(data: Partial<Transfer>): Transfer | null {
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

type TransfersProviderProps = {
  children: ReactNode;
  /** Resolve a historical transfer to the currently connected transport. */
  resolveSessionId?: (item: Pick<TransferHistoryItem, "sessionId" | "runtimeId" | "profileId">) => string | undefined;
};

export function TransfersProvider({ children, resolveSessionId }: TransfersProviderProps) {
  const [transfers, setTransfers] = useState<Record<string, Transfer>>({});
  const [history, setHistory] = useState<TransferHistoryItem[]>([]);
  const lastSequences = useRef(new Map<string, number>());
  const terminalJobs = useRef(new Set<string>());

  useEffect(() => {
    const off = EventsOn("sftp:progress", (raw: Partial<Transfer>) => {
      const data = normalizeEvent(raw);
      if (!data) return;
      if (terminalJobs.current.has(data.jobId)) return;
      if (data.sequence && data.sequence > 0) {
        const previousSequence = lastSequences.current.get(data.jobId) || 0;
        if (data.sequence <= previousSequence) return;
        lastSequences.current.set(data.jobId, data.sequence);
      }
      const terminal = data.status === "succeeded" || data.status === "failed" || data.status === "cancelled";
      if (!terminal) {
        setTransfers((prev) => {
          // resumedAt arrives once, on the single "resumed" event, while progress
          // ticks keep coming. Carrying it forward keeps the badge visible for the
          // whole transfer instead of for one frame.
          const previous = prev[data.jobId];
          const resumedAt = data.resumedAt ?? previous?.resumedAt;
          return {
            ...prev,
            [data.jobId]: {
              ...previous,
              ...data,
              resumedAt,
              sourcePath: data.sourcePath || previous?.sourcePath,
              targetPath: data.targetPath || previous?.targetPath,
              overwrite: data.overwrite ?? previous?.overwrite,
              retryable: data.retryable ?? previous?.retryable,
            },
          };
        });
        return;
      }

      terminalJobs.current.add(data.jobId);
      // Transfer ids are unique, but this provider can live for days. Keep the
      // stale-event fence bounded while retaining plenty of recent history.
      if (terminalJobs.current.size > 512) {
        const oldest = terminalJobs.current.values().next().value;
        if (oldest) {
          terminalJobs.current.delete(oldest);
          lastSequences.current.delete(oldest);
        }
      }

      setTransfers((prev) => {
        if (!(data.jobId in prev)) return prev;
        const next = { ...prev };
        delete next[data.jobId];
        return next;
      });
      setHistory((prev) => {
        // Terminal delivery is idempotent. This also protects React dev-mode
        // listener remounts from creating duplicate history rows.
        if (prev.some((item) => item.jobId === data.jobId)) return prev;
        const item: TransferHistoryItem = {
          key: data.jobId,
          jobId: data.jobId,
          sessionId: data.sessionId,
          runtimeId: data.runtimeId,
          profileId: data.profileId,
          generation: data.generation,
          path: data.path,
          name: transferName(data.path),
          direction: data.direction,
          status: data.status as TransferHistoryItem["status"],
          error: data.error,
          finishedAt: Date.now(),
          ok: data.status === "succeeded",
          sourcePath: data.sourcePath,
          targetPath: data.targetPath,
          overwrite: data.overwrite,
          retryable: data.retryable !== false && data.status !== "succeeded",
        };
        return [item, ...prev].slice(0, 50);
      });
    });
    return () => off();
  }, []);

  const activeCount = useMemo(() => Object.keys(transfers).length, [transfers]);

  const cancelTransfer = useCallback(async (jobId: string) => {
    try {
      return await CancelTransfer(jobId);
    } catch {
      return false;
    }
  }, []);

  const pauseTransfer = useCallback(async (jobId: string) => {
    try {
      return await PauseTransfer(jobId);
    } catch {
      return false;
    }
  }, []);

  const resumeTransfer = useCallback(async (jobId: string) => {
    try {
      return await ResumeTransfer(jobId);
    } catch {
      return false;
    }
  }, []);

  const retryTransfer = useCallback(async (item: Pick<TransferHistoryItem, "sessionId" | "runtimeId" | "profileId" | "sourcePath" | "targetPath" | "direction" | "overwrite" | "retryable">) => {
    if (!item.retryable || !item.sourcePath || !item.targetPath) return false;
    const sessionId = resolveSessionId ? resolveSessionId(item) : item.sessionId;
    if (!sessionId) return false;
    try {
      if (item.direction === "upload") {
        await UploadFileWithPolicy(sessionId, item.sourcePath, item.targetPath, item.overwrite === true);
      } else {
        await DownloadFileWithPolicy(sessionId, item.sourcePath, item.targetPath, item.overwrite === true);
      }
    } catch {
      return false;
    }
    return true;
  }, [resolveSessionId]);

  const clearHistory = useCallback(() => setHistory([]), []);

  return (
    <TransfersContext.Provider value={{ transfers, history, activeCount, cancelTransfer, pauseTransfer, resumeTransfer, retryTransfer, clearHistory }}>
      {children}
    </TransfersContext.Provider>
  );
}

export function useTransfers() {
  return useContext(TransfersContext);
}
