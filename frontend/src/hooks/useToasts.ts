import { useCallback, useEffect, useRef, useState } from "react";
import type { Toast } from "../types";

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const activeKeys = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    // Both refs are created once and only ever mutated in place, so the maps
    // seen here are the same ones notify() writes to. Capturing them makes that
    // explicit rather than reading .current during teardown.
    const pending = timers.current;
    const keys = activeKeys.current;
    return () => {
      pending.forEach((id) => clearTimeout(id));
      pending.clear();
      keys.clear();
    };
  }, []);

  const notify = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const key = `${tone}\u0000${text}`;
    // A single backend failure can reach the renderer through both an event and
    // a rejected Wails promise. Keep the first toast (and its original expiry)
    // instead of stacking duplicates or extending them indefinitely while an
    // auto-reconnect loop reports the same failure.
    if (activeKeys.current.has(key)) return;

    // A monotonic counter alone is unique. The old scheme packed the clock and
    // the counter into one number (Date.now() * 10000 + n), which exceeded
    // Number.MAX_SAFE_INTEGER: float spacing at that magnitude is 4, so the
    // counter's low bits were rounded away and toasts raised in the same
    // millisecond could share an id. Duplicate ids are duplicate React keys,
    // which left a toast node mounted after its state entry expired.
    const id = `t${++counter.current}`;
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
