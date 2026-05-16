import { useState } from "react";

export function usePersistedState<T>(key: string, defaultValue: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) return JSON.parse(stored) as T;
    } catch {}
    return defaultValue;
  });

  const persistSetValue = (action: React.SetStateAction<T>) => {
    setValue((prev) => {
      const next = action instanceof Function ? action(prev) : action;
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  return [value, persistSetValue];
}
