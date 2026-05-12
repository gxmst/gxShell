import { useEffect, useState } from "react";
import { EventsOn } from "../../wailsjs/runtime/runtime";

export type Transfer = {
  sessionId: string;
  path: string;
  done: number;
  total: number;
  direction: "upload" | "download";
  finished?: boolean;
};

export function useTransfers() {
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

  return { transfers, activeCount, removeTransfer };
}
