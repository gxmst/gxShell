import { useCallback, useEffect, useRef, useState } from "react";
import type { Toast } from "../types";

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => {
      timers.current.forEach((id) => clearTimeout(id));
      timers.current.clear();
    };
  }, []);

  const notify = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = Date.now() * 10000 + (++counter.current);
    setToasts((items) => [...items, { id, text, tone }]);
    const timer = window.setTimeout(() => {
      setToasts((items) => items.filter((item) => item.id !== id));
      timers.current.delete(id);
    }, 3600);
    timers.current.set(id, timer);
  }, []);

  return { toasts, notify };
}
