import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Inline-editor drafts that survive the tab changes which used to throw them
 * away.
 *
 * A site config or a crontab belongs to a host, not to the terminal tab that
 * happens to be showing it. The active tab id changes when a second terminal is
 * opened on the same server, when the session auto-reconnects and is handed a
 * new id, and when the drawer is switched - and every one of those cleared the
 * editor and silently dropped the draft. Keying the draft by profileId keeps
 * it: switching between two terminals of the same host, or away and back,
 * lands on the draft the user left.
 *
 * The store lives at module scope rather than in the component because the
 * panel unmounts when the drawer changes; component state would go with it.
 * One map per panel keeps the two drafts from sharing a namespace.
 */
const draftsByPanel = new Map<string, Map<string, unknown>>();
const listeners = new WeakMap<Map<string, unknown>, Map<string, Set<() => void>>>();

function notifyDraft(store: Map<string, unknown>, profileId: string) {
  listeners.get(store)?.get(profileId)?.forEach((listener) => listener());
}

function panelStore(panel: string): Map<string, unknown> {
  let store = draftsByPanel.get(panel);
  if (!store) {
    store = new Map();
    draftsByPanel.set(panel, store);
  }
  return store;
}

/** Test seam: forget every draft this panel is holding. */
export function clearProfileDrafts(panel?: string) {
  if (panel === undefined) {
    draftsByPanel.clear();
    return;
  }
  draftsByPanel.delete(panel);
}

/**
 * @param panel     Namespace for the draft store, e.g. "websites".
 * @param profileId Host the draft belongs to. An empty id (no active session)
 *                  still works - it is just another bucket.
 * @param closed    Value that means "no editor open", usually null.
 */
export function useProfileDraft<T>(
  panel: string,
  profileId: string,
  closed: T,
): [T, (next: T | ((prev: T) => T)) => void, (expected: T, next: T) => boolean] {
  const store = panelStore(panel);
  const [draft, setDraft] = useState<T>(() =>
    store.has(profileId) ? (store.get(profileId) as T) : closed,
  );
  const closedRef = useRef(closed);
  closedRef.current = closed;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const mountedRef = useRef(false);
  const profileRef = useRef(profileId);
  profileRef.current = profileId;
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Adopt the incoming host's draft. The outgoing one is already parked,
  // because every write goes to the store as well.
  useEffect(() => {
    const sync = () => {
      const value = store.has(profileId) ? (store.get(profileId) as T) : closedRef.current;
      draftRef.current = value;
      setDraft(value);
    };
    let profiles = listeners.get(store);
    if (!profiles) { profiles = new Map(); listeners.set(store, profiles); }
    let subscribers = profiles.get(profileId);
    if (!subscribers) { subscribers = new Set(); profiles.set(profileId, subscribers); }
    subscribers.add(sync);
    sync();
    return () => {
      subscribers.delete(sync);
      if (subscribers.size === 0) profiles.delete(profileId);
    };
  }, [store, profileId]);

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      if (!mountedRef.current || profileRef.current !== profileId) return;
      const value =
        typeof next === "function" ? (next as (prev: T) => T)(draftRef.current) : next;
      draftRef.current = value;
      store.set(profileId, value);
      notifyDraft(store, profileId);
    },
    [store, profileId],
  );

  // A completed save can retire its unchanged cached snapshot even after
  // unmount. Subscribers update a remounted editor; the old caller must not
  // refresh or navigate a panel it no longer owns.
  const replaceIfCurrent = useCallback((expected: T, next: T) => {
    if (store.get(profileId) !== expected) return false;
    store.set(profileId, next);
    notifyDraft(store, profileId);
    return mountedRef.current && profileRef.current === profileId;
  }, [store, profileId]);

  return [draft, update, replaceIfCurrent];
}

/**
 * Guards the two ways an open draft can still be lost - closing the editor and
 * loading a different item into it. Both are explicit user actions, so both get
 * a question; the tab changes above no longer need one because the draft is
 * kept.
 *
 * `guard` runs the action immediately when there is nothing to lose.
 */
export function useDiscardGuard(dirty: boolean) {
  const [pending, setPending] = useState<(() => void) | null>(null);

  const guard = useCallback(
    (action: () => void) => {
      if (dirty) {
        // Wrapped, because a bare function argument is read as a state updater.
        setPending(() => action);
        return;
      }
      action();
    },
    [dirty],
  );

  const dismiss = useCallback(() => setPending(null), []);

  return { pending, guard, dismiss };
}
