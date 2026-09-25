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
): [T, (next: T | ((prev: T) => T)) => void] {
  const store = panelStore(panel);
  const [draft, setDraft] = useState<T>(() =>
    store.has(profileId) ? (store.get(profileId) as T) : closed,
  );
  const closedRef = useRef(closed);
  closedRef.current = closed;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Adopt the incoming host's draft. The outgoing one is already parked,
  // because every write goes to the store as well.
  useEffect(() => {
    setDraft(store.has(profileId) ? (store.get(profileId) as T) : closedRef.current);
  }, [store, profileId]);

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      const value =
        typeof next === "function" ? (next as (prev: T) => T)(draftRef.current) : next;
      draftRef.current = value;
      store.set(profileId, value);
      setDraft(value);
    },
    [store, profileId],
  );

  return [draft, update];
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
