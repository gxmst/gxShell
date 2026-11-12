import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CancelTransfer, DownloadFileWithPolicy, PauseTransfer, ResumeTransfer, UploadFileWithPolicy } from "../../wailsjs/go/app/App";
import { EventsOn } from "../../wailsjs/runtime/runtime";
import { TransfersContext, transferName, normalizeEvent, type Transfer, type TransferHistoryItem } from "./useTransfers";

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
