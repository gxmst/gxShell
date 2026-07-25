import { useEffect, useRef, useState } from "react";
import { EventsOn } from "../../wailsjs/runtime/runtime";
import { types } from "../../wailsjs/go/models";

/** One sampled point. Percentages are 0-100; rates are bytes per second. */
export type MetricsSample = {
  at: number;
  cpuPercent: number;
  memoryPercent: number;
  diskPercent: number;
  networkRxPerSec: number;
  networkTxPerSec: number;
};

/**
 * Rolling in-memory history of monitor samples for one session.
 *
 * Deliberately not persisted. The monitor already polls on an interval and the
 * useful question a sparkline answers is "what has this host been doing for the
 * last few minutes", which does not survive a restart in any meaningful way.
 * Writing it to disk would mean a growing file per session, a retention policy
 * and a migration, for a chart nobody consults after the app closes.
 *
 * Capacity is a sample count rather than a duration because the collection
 * interval is a user setting: at the default 5s, 120 samples is ~10 minutes, and
 * a shorter interval trades span for resolution rather than growing memory.
 */
export const HISTORY_CAPACITY = 120;

export function useMetricsHistory(sessionId?: string, capacity = HISTORY_CAPACITY): MetricsSample[] {
  const [samples, setSamples] = useState<MetricsSample[]>([]);
  // The last kept timestamp, so a duplicate tick (a re-emit of a sample already
  // recorded) does not appear as a second point at the same instant.
  const lastAt = useRef(0);

  useEffect(() => {
    // History belongs to one session. Switching tabs starts over rather than
    // carrying another host's curve across, which would read as a real change.
    setSamples([]);
    lastAt.current = 0;
    if (!sessionId) return;

    const off = EventsOn("monitor:update", (data: types.Metrics) => {
      if (data.sessionId !== sessionId) return;
      // A failed collection reports an error and zeroed fields; recording those
      // would draw a drop to zero that never happened on the host.
      if (data.error) return;

      const at = data.updatedAt ? new Date(data.updatedAt).getTime() : Date.now();
      if (!Number.isFinite(at) || at === lastAt.current) return;
      lastAt.current = at;

      setSamples((prev) => {
        const next = prev.concat({
          at,
          cpuPercent: clampPercent(data.cpuPercent),
          memoryPercent: clampPercent(data.memoryPercent),
          diskPercent: clampPercent(data.diskPercent),
          networkRxPerSec: Math.max(0, data.networkRxPerSec || 0),
          networkTxPerSec: Math.max(0, data.networkTxPerSec || 0),
        });
        return next.length > capacity ? next.slice(next.length - capacity) : next;
      });
    });

    return () => { if (off) off(); };
  }, [sessionId, capacity]);

  return samples;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}
