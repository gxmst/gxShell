import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { CancelTransfer } from "../../wailsjs/go/main/App";
import { EventsOn } from "../../wailsjs/runtime/runtime";

export type TransferStatus = "started" | "progress" | "succeeded" | "failed" | "cancelled";

export type Transfer = {
  jobId: string;
  sessionId: string;
  path: string;
  done: number;
  total: number;
  direction: "upload" | "download";
  status: TransferStatus;
  error?: string;
  /** Compatibility with events emitted by gxShell <= 1.3.0. */
  finished?: boolean;
};

export type TransferHistoryItem = {
  key: string;
  jobId: string;
  sessionId: string;
  path: string;
  name: string;
  direction: "upload" | "download";
  status: "succeeded" | "failed" | "cancelled";
  error?: string;
  finishedAt: number;
  ok: boolean;
};

type TransfersState = {
  transfers: Record<string, Transfer>;
  history: TransferHistoryItem[];
  activeCount: number;
  cancelTransfer: (jobId: string) => Promise<boolean>;
  clearHistory: () => void;
};

const TransfersContext = createContext<TransfersState>({
  transfers: {},
  history: [],
  activeCount: 0,
  cancelTransfer: async () => false,
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
    path: data.path,
    done: Number(data.done) || 0,
    total: Number(data.total) || 0,
    direction: data.direction,
    status,
    error: data.error,
    finished: data.finished,
  };
}

export function TransfersProvider({ children }: { children: ReactNode }) {
  const [transfers, setTransfers] = useState<Record<string, Transfer>>({});
  const [history, setHistory] = useState<TransferHistoryItem[]>([]);

  useEffect(() => {
    const off = EventsOn("sftp:progress", (raw: Partial<Transfer>) => {
      const data = normalizeEvent(raw);
      if (!data) return;
      const terminal = data.status === "succeeded" || data.status === "failed" || data.status === "cancelled";
      if (!terminal) {
        setTransfers((prev) => ({ ...prev, [data.jobId]: data }));
        return;
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
          path: data.path,
          name: transferName(data.path),
          direction: data.direction,
          status: data.status as TransferHistoryItem["status"],
          error: data.error,
          finishedAt: Date.now(),
          ok: data.status === "succeeded",
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

  const clearHistory = useCallback(() => setHistory([]), []);

  return (
    <TransfersContext.Provider value={{ transfers, history, activeCount, cancelTransfer, clearHistory }}>
      {children}
    </TransfersContext.Provider>
  );
}

export function useTransfers() {
  return useContext(TransfersContext);
}
