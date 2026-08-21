import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityAction, ActivityCategory, ActivityRecord, NotifyInput, NotifyOptions, Toast, ToastTone } from "../types";

const DEFAULT_TOAST_DURATION_MS = 3600;
const DEFAULT_MAX_ACTIVITIES = 200;

export type LegacyNotifyOptions = Omit<NotifyOptions, "text" | "tone"> & {
  tone?: ToastTone;
};

export type UseToastsOptions = {
  /** Maximum number of activity records kept in memory. */
  maxActivities?: number;
  /** Optional localStorage key. Omit it when activity history should be session-only. */
  activityStorageKey?: string;
  /** Default duration for legacy and object notifications. */
  toastDurationMs?: number;
};

export type UseToastsResult = {
  toasts: Toast[];
  activities: ActivityRecord[];
  unreadActivityCount: number;
  /** Existing `notify(text, tone)` calls remain valid. */
  notify: (input: NotifyInput, tone?: ToastTone, options?: LegacyNotifyOptions) => void;
  /** Record an item without showing a transient toast unless `toast` is true. */
  recordActivity: (input: NotifyOptions) => string;
  /** Convenience API for a durable record and a toast. */
  notifyActivity: (input: NotifyOptions) => void;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
  markActivityRead: (id: string) => void;
  markAllActivitiesRead: () => void;
  removeActivity: (id: string) => void;
  clearActivities: () => void;
};

function isTone(value: unknown): value is ToastTone {
  return value === "info" || value === "error" || value === "success" || value === "warning";
}

function isCategory(value: unknown): value is ActivityCategory {
  return value === "connection" || value === "transfer" || value === "automation" || value === "security" || value === "terminal" || value === "update" || value === "system" || value === "other";
}

function safeStoredActivities(value: string | null, maxActivities: number): ActivityRecord[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Partial<ActivityRecord> => !!item && typeof item === "object")
      .map((item) => {
        const tone = isTone(item.tone) ? item.tone : "info";
        const category = isCategory(item.category) ? item.category : "other";
        const actions = Array.isArray(item.actions)
          ? (item.actions as unknown[])
            .filter((action): action is Partial<ActivityAction> => !!action && typeof action === "object" && typeof (action as Partial<ActivityAction>).id === "string" && typeof (action as Partial<ActivityAction>).label === "string")
            .map((action) => ({ id: action.id!, label: action.label!, variant: action.variant, disabled: action.disabled }))
          : undefined;
        return {
          id: typeof item.id === "string" ? item.id : `a${Date.now()}-${Math.random().toString(36).slice(2)}`,
          timestamp: typeof item.timestamp === "number" ? item.timestamp : Date.now(),
          text: typeof item.text === "string" ? item.text : "",
          title: typeof item.title === "string" ? item.title : undefined,
          tone,
          severity: isTone(item.severity) ? item.severity : tone,
          category,
          scope: typeof item.scope === "string" ? item.scope : undefined,
          scopeLabel: typeof item.scopeLabel === "string" ? item.scopeLabel : undefined,
          dedupeKey: typeof item.dedupeKey === "string" ? item.dedupeKey : undefined,
          unread: item.unread !== false,
          occurrences: typeof item.occurrences === "number" && item.occurrences > 1 ? item.occurrences : undefined,
          detail: typeof item.detail === "string" ? item.detail : undefined,
          actions,
          source: typeof item.source === "string" ? item.source : undefined,
          metadata: item.metadata && typeof item.metadata === "object" ? item.metadata as ActivityRecord["metadata"] : undefined,
        } satisfies ActivityRecord;
      })
      .filter((item) => item.text.length > 0)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, maxActivities);
  } catch {
    return [];
  }
}

function serializableActivities(activities: ActivityRecord[]): ActivityRecord[] {
  // Action callbacks are runtime-only. Keeping the labels and ids means a
  // restored record still explains what happened without serializing code.
  return activities.map((activity) => ({
    ...activity,
    actions: activity.actions?.map(({ onClick: _onClick, ...action }) => action),
  }));
}

function activityDedupeKey(options: NotifyOptions, tone: ToastTone): string | undefined {
  if (!options.dedupeKey) return undefined;
  return `${tone}\u0000${options.category || "other"}\u0000${options.scope || ""}\u0000${options.dedupeKey}`;
}

export function useToasts(options: UseToastsOptions = {}): UseToastsResult {
  const maxActivities = Math.max(1, options.maxActivities ?? DEFAULT_MAX_ACTIVITIES);
  const storageKey = options.activityStorageKey;
  const defaultDuration = options.toastDurationMs ?? DEFAULT_TOAST_DURATION_MS;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [activities, setActivities] = useState<ActivityRecord[]>(() => {
    if (!storageKey) return [];
    try {
      return safeStoredActivities(localStorage.getItem(storageKey), maxActivities);
    } catch {
      return [];
    }
  });
  const counter = useRef(0);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const activeKeys = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const pending = timers.current;
    const keys = activeKeys.current;
    return () => {
      pending.forEach((id) => clearTimeout(id));
      pending.clear();
      keys.clear();
    };
  }, []);

  useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(serializableActivities(activities)));
    } catch {
      // Storage can be unavailable in private WebView profiles. Activity state
      // still works for the lifetime of the app in that case.
    }
  }, [activities, storageKey]);

  const dismissToast = useCallback((id: string) => {
    setToasts((items) => items.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    for (const [key, activeId] of activeKeys.current) {
      if (activeId === id) activeKeys.current.delete(key);
    }
  }, []);

  const clearToasts = useCallback(() => {
    timers.current.forEach((timer) => clearTimeout(timer));
    timers.current.clear();
    activeKeys.current.clear();
    setToasts([]);
  }, []);

  const recordActivity = useCallback((input: NotifyOptions): string => {
    const tone = input.severity ?? input.tone ?? "info";
    const category = input.category ?? "other";
    const now = Date.now();
    const generatedId = `a${++counter.current}`;
    const dedupeKey = activityDedupeKey(input, tone);
    let storedId = generatedId;
    const activity: ActivityRecord = {
      id: generatedId,
      timestamp: now,
      text: input.text,
      title: input.title,
      tone,
      severity: tone,
      category,
      scope: input.scope,
      scopeLabel: input.scopeLabel,
      dedupeKey: input.dedupeKey,
      unread: true,
      occurrences: 1,
      detail: input.detail,
      actions: input.actions,
      source: input.source,
      metadata: input.metadata,
    };

    setActivities((items) => {
      if (dedupeKey) {
        const index = items.findIndex((item) => activityDedupeKey({ ...item, text: item.text }, item.tone) === dedupeKey);
        if (index >= 0) {
          const previous = items[index];
          storedId = previous.id;
          const merged: ActivityRecord = {
            ...previous,
            ...activity,
            id: previous.id,
            timestamp: now,
            unread: true,
            occurrences: (previous.occurrences || 1) + 1,
          };
          return [merged, ...items.filter((_, itemIndex) => itemIndex !== index)].slice(0, maxActivities);
        }
      }
      return [activity, ...items].slice(0, maxActivities);
    });
    return storedId;
  }, [maxActivities]);

  const showToast = useCallback((input: NotifyOptions) => {
    const tone = input.severity ?? input.tone ?? "info";
    const toastKey = input.dedupeKey
      ? `${tone}\u0000${input.scope || ""}\u0000${input.dedupeKey}`
      : `${tone}\u0000${input.text}`;
    if (activeKeys.current.has(toastKey)) return;

    const id = `t${++counter.current}`;
    activeKeys.current.set(toastKey, id);
    const toast: Toast = {
      id,
      text: input.text,
      tone,
      title: input.title,
      category: input.category,
      scope: input.scope,
      scopeLabel: input.scopeLabel,
      actions: input.actions,
    };
    setToasts((items) => [...items, toast]);

    const durationMs = input.durationMs ?? defaultDuration;
    if (durationMs > 0 && Number.isFinite(durationMs)) {
      const timer = window.setTimeout(() => {
        setToasts((items) => items.filter((item) => item.id !== id));
        timers.current.delete(id);
        if (activeKeys.current.get(toastKey) === id) activeKeys.current.delete(toastKey);
      }, durationMs);
      timers.current.set(id, timer);
    }
  }, [defaultDuration]);

  const notify = useCallback((input: NotifyInput, legacyTone?: ToastTone, legacyOptions?: LegacyNotifyOptions) => {
    const isLegacyCall = typeof input === "string";
    const normalized: NotifyOptions = isLegacyCall
      ? { ...(legacyOptions || {}), text: input, tone: legacyTone ?? "info" }
      : input;
    // A toast the user missed has to stay recoverable, and legacy string calls
    // are where nearly every failure is reported from. So error/warning tones
    // are kept in the history while ordinary info chatter stays transient.
    // They also get a text-derived dedupe key, so a retry loop reporting the
    // same failure coalesces into one record with an occurrence count.
    const tone = normalized.severity ?? normalized.tone ?? "info";
    const persistLegacy = tone === "error" || tone === "warning";
    const shouldPersist = normalized.persist ?? (!isLegacyCall || persistLegacy);
    if (shouldPersist) {
      recordActivity(isLegacyCall && !normalized.dedupeKey
        ? { ...normalized, dedupeKey: `legacy:${normalized.text}` }
        : normalized);
    }
    if (normalized.toast !== false) showToast(normalized);
  }, [recordActivity, showToast]);

  const notifyActivity = useCallback((input: NotifyOptions) => {
    notify({ ...input, persist: input.persist ?? true, toast: input.toast ?? true });
  }, [notify]);

  const markActivityRead = useCallback((id: string) => {
    setActivities((items) => items.map((item) => item.id === id ? { ...item, unread: false } : item));
  }, []);

  const markAllActivitiesRead = useCallback(() => {
    setActivities((items) => items.some((item) => item.unread) ? items.map((item) => ({ ...item, unread: false })) : items);
  }, []);

  const removeActivity = useCallback((id: string) => {
    setActivities((items) => items.filter((item) => item.id !== id));
  }, []);

  const clearActivities = useCallback(() => setActivities([]), []);

  const unreadActivityCount = activities.reduce((count, item) => count + (item.unread ? 1 : 0), 0);

  return {
    toasts,
    activities,
    unreadActivityCount,
    notify,
    recordActivity,
    notifyActivity,
    dismissToast,
    clearToasts,
    markActivityRead,
    markAllActivitiesRead,
    removeActivity,
    clearActivities,
  };
}
