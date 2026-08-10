import { useCallback, useEffect, useRef, useState } from "react";
import { CheckForUpdate, SkipUpdateVersion } from "../../wailsjs/go/app/App";
import { EventsOn } from "../../wailsjs/runtime/runtime";
import { version } from "../../wailsjs/go/models";

/**
 * Update-check state.
 *
 * Two entry points feed the same state. The backend emits "update:available"
 * once at startup, and only when there is a strictly newer stable release the
 * user has not skipped, so anything arriving on that channel is worth a dialog.
 * A manual check from the settings panel reports whatever it finds, including
 * "you are up to date" and failures, because the user asked.
 */
export function useUpdateCheck() {
  const [result, setResult] = useState<version.CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  // Guards a state update landing after unmount when a manual check is still in
  // flight (the request has a backend-side timeout, so this can outlive a view).
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const unsub = EventsOn("update:available", (payload: version.CheckResult) => {
      if (!mounted.current) return;
      setResult(payload);
      setPromptOpen(true);
    });
    return () => { if (unsub) unsub(); };
  }, []);

  // checkNow is the manual path. It never throws: a failed check is a result
  // with an `error` field, which is what the settings panel renders.
  const checkNow = useCallback(async (): Promise<version.CheckResult | null> => {
    setChecking(true);
    try {
      const next = await CheckForUpdate();
      if (!mounted.current) return next;
      setResult(next);
      return next;
    } catch {
      return null;
    } finally {
      if (mounted.current) setChecking(false);
    }
  }, []);

  const dismissPrompt = useCallback(() => setPromptOpen(false), []);

  const skipVersion = useCallback(async (v: string) => {
    setPromptOpen(false);
    // Persisting the skip is best-effort: the prompt is already closed, and
    // failing to record it only means the user is asked again next launch.
    try {
      await SkipUpdateVersion(v);
    } catch {}
  }, []);

  return { result, checking, promptOpen, checkNow, dismissPrompt, skipVersion };
}
