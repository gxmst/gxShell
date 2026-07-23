import { useCallback, useEffect, useRef, useState } from "react";
import type { Toast } from "../types";

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const activeKeys = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    return () => {
      timers.current.forEach((id) => clearTimeout(id));
      timers.current.clear();
      activeKeys.current.clear();
    };
  }, []);

  const notify = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const key = `${tone}\u0000${text}`;
    // A single backend failure can reach the renderer through both an event and
    // a rejected Wails promise. Keep the first toast (and its original expiry)
    // instead of stacking duplicates or extending them indefinitely while an
    // auto-reconnect loop reports the same failure.
    if (activeKeys.current.has(key)) return;

    const id = Date.now() * 10000 + (++counter.current);
    activeKeys.current.set(key, id);
    setToasts((items) => [...items, { id, text, tone }]);
    const timer = window.setTimeout(() => {
      setToasts((items) => items.filter((item) => item.id !== id));
      timers.current.delete(id);
      if (activeKeys.current.get(key) === id) activeKeys.current.delete(key);
    }, 3600);
    timers.current.set(id, timer);
  }, []);

  return { toasts, notify };
}
