import { useEffect, useState } from "react";
import { EventsOn } from "../../wailsjs/runtime/runtime";
import { GetLatestMetrics } from "../../wailsjs/go/main/App";
import { types } from "../../wailsjs/go/models";

// Per-session monitor subscription, mirroring the proven TerminalStatusBar
// pattern: each consumer subscribes to monitor:update itself, so a metrics
// tick re-renders only the leaf components that display metrics — never App
// or the whole Sidebar tree. State is keyed to a single sessionId and reset
// whenever it changes or the consumer unmounts, so no cross-session map can
// accumulate entries for closed sessions.
export function useSessionMetrics(sessionId?: string): types.Metrics | undefined {
  const [metrics, setMetrics] = useState<types.Metrics | undefined>(undefined);

  useEffect(() => {
    setMetrics(undefined);
    if (!sessionId) return;
    let stale = false;
    // Seed once from the backend's cached sample so panels are not blank until
    // the next collection tick; the stale guard drops the async result if the
    // session changed before it resolved.
    GetLatestMetrics(sessionId)
      .then((data) => { if (!stale && data && data.sessionId === sessionId) setMetrics(data); })
      .catch(() => {});
    const off = EventsOn("monitor:update", (data: types.Metrics) => {
      if (data.sessionId === sessionId) setMetrics(data);
    });
    return () => { stale = true; off(); };
  }, [sessionId]);

  return metrics;
}
