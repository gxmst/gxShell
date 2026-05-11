import { useEffect, useState } from "react";
import { EventsOn } from "../../wailsjs/runtime/runtime";
import { types } from "../../wailsjs/go/models";

export function useMonitor() {
  const [metrics, setMetrics] = useState<Record<string, types.Metrics>>({});

  useEffect(() => {
    const offMonitor = EventsOn("monitor:update", (data: types.Metrics) => {
      setMetrics((items) => ({ ...items, [data.sessionId]: data }));
    });
    return () => offMonitor();
  }, []);

  return { metrics };
}

