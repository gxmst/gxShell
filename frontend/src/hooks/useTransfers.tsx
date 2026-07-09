import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { EventsOn } from "../../wailsjs/runtime/runtime";

export type Transfer = {
  sessionId: string;
  path: string;
  done: number;
  total: number;
  direction: "upload" | "download";
  finished?: boolean;
};

export type TransferHistoryItem = {
  key: string;
  sessionId: string;
  path: string;
  name: string;
  direction: "upload" | "download";
  finishedAt: number;
  ok: boolean;
};

type TransfersState = {
  transfers: Record<string, Transfer>;
  history: TransferHistoryItem[];
  activeCount: number;
  removeTransfer: (key: string) => void;
  clearHistory: () => void;
};

const TransfersContext = createContext<TransfersState>({
  transfers: {},
  history: [],
  activeCount: 0,
  removeTransfer: () => {},
  clearHistory: () => {},
});

function transferName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

export function TransfersProvider({ children }: { children: ReactNode }) {
  const [transfers, setTransfers] = useState<Record<string, Transfer>>({});
  const [history, setHistory] = useState<TransferHistoryItem[]>([]);

  useEffect(() => {
    const off = EventsOn("sftp:progress", (data: Transfer) => {
      const key = `${data.sessionId}:${data.path}:${data.direction}`;
      if (data.finished) {
        setTransfers((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        setHistory((prev) => {
          const item: TransferHistoryItem = {
            key: `${key}:${Date.now()}`,
            sessionId: data.sessionId,
            path: data.path,
            name: transferName(data.path),
            direction: data.direction,
            finishedAt: Date.now(),
            ok: true,
          };
          // De-dupe rapid finished events for the same job.
          if (prev[0]?.path === item.path && prev[0]?.direction === item.direction && Date.now() - prev[0].finishedAt < 800) {
            return prev;
          }
          return [item, ...prev].slice(0, 40);
        });
      } else {
        setTransfers((prev) => ({ ...prev, [key]: data }));
      }
    });
    return () => off();
  }, []);

  const activeCount = useMemo(() => Object.keys(transfers).length, [transfers]);

  const removeTransfer = (key: string) => {
    setTransfers((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const clearHistory = () => setHistory([]);

  return (
    <TransfersContext.Provider value={{ transfers, history, activeCount, removeTransfer, clearHistory }}>
      {children}
    </TransfersContext.Provider>
  );
}

export function useTransfers() {
  return useContext(TransfersContext);
}
