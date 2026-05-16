import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { EventsOn } from "../../wailsjs/runtime/runtime";

export type Transfer = {
  sessionId: string;
  path: string;
  done: number;
  total: number;
  direction: "upload" | "download";
  finished?: boolean;
};

type TransfersState = {
  transfers: Record<string, Transfer>;
  activeCount: number;
  removeTransfer: (key: string) => void;
};

const TransfersContext = createContext<TransfersState>({
  transfers: {},
  activeCount: 0,
  removeTransfer: () => {},
});

export function TransfersProvider({ children }: { children: ReactNode }) {
  const [transfers, setTransfers] = useState<Record<string, Transfer>>({});

  useEffect(() => {
    const off = EventsOn("sftp:progress", (data: Transfer) => {
      const key = `${data.sessionId}:${data.path}:${data.direction}`;
      if (data.finished) {
        setTransfers((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      } else {
        setTransfers((prev) => ({ ...prev, [key]: data }));
      }
    });
    return () => off();
  }, []);

  const activeCount = Object.values(transfers).length;

  const removeTransfer = (key: string) => {
    setTransfers((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  return (
    <TransfersContext.Provider value={{ transfers, activeCount, removeTransfer }}>
      {children}
    </TransfersContext.Provider>
  );
}

export function useTransfers() {
  return useContext(TransfersContext);
}
