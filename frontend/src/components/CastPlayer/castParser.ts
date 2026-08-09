export type CastEvent = { time: number; code: string; data: string };
export type CastHeader = { width: number; height: number; title?: string };

const MAX_CAST_EVENTS = 250_000;

// Read asciinema v2 JSON Lines. Invalid event lines are skipped so an app or
// machine crash near the end does not make all earlier captured output unusable.
export function parseCast(text: string): { header: CastHeader; events: CastEvent[]; truncated: boolean } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let header: CastHeader = { width: 80, height: 24 };
  const events: CastEvent[] = [];
  let truncated = false;
  let headerSeen = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!headerSeen) {
      headerSeen = true;
      try {
        const parsed = JSON.parse(line);
        const width = Number(parsed.width);
        const height = Number(parsed.height);
        header = {
          width: Number.isFinite(width) && width > 0 ? width : 80,
          height: Number.isFinite(height) && height > 0 ? height : 24,
          title: typeof parsed.title === 'string' ? parsed.title : undefined,
        };
      } catch {
        // Keep defaults. Subsequent valid event lines can still be replayed.
      }
      continue;
    }
    try {
      const arr = JSON.parse(line);
      if (Array.isArray(arr) && arr.length >= 3) {
        const time = Number(arr[0]);
        events.push({
          time: Number.isFinite(time) && time > 0 ? time : 0,
          code: String(arr[1]),
          data: String(arr[2]),
        });
        if (events.length >= MAX_CAST_EVENTS) {
          truncated = true;
          break;
        }
      }
    } catch {
      // Skip malformed event lines.
    }
  }

  // A recording can be started long before the first visible output. Starting
  // playback with that dead time looks like a broken blank player, so anchor
  // the timeline at the first output while preserving all later gaps. Earlier
  // resize events are retained at t=0.
  const firstOutput = events.find((event) => event.code === 'o');
  if (firstOutput && firstOutput.time > 0) {
    const firstOutputTime = firstOutput.time;
    for (const event of events) event.time = Math.max(0, event.time - firstOutputTime);
  }

  return { header, events, truncated };
}
