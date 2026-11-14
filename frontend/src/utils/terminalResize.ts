export type TerminalDimensions = { cols: number; rows: number };

const sameSize = (a: TerminalDimensions | undefined, b: TerminalDimensions) => a?.cols === b.cols && a.rows === b.rows;

// One scheduler owns all resize entry points. Local reflow and PTY updates
// happen together after geometry settles; explicit activation can fit next frame.
export function createTerminalResizeScheduler({ fit, resize, settleMs = 80 }: {
  fit: (id: string) => TerminalDimensions | null;
  resize: (id: string, dimensions: TerminalDimensions) => Promise<unknown>;
  settleMs?: number;
}) {
  type State = {
    timer?: number;
    frame?: number;
    pending?: TerminalDimensions;
    acknowledged?: TerminalDimensions;
    inFlight: boolean;
  };
  const states = new Map<string, State>();
  const clearScheduled = (state: State) => {
    window.clearTimeout(state.timer);
    if (state.frame !== undefined) window.cancelAnimationFrame(state.frame);
    state.timer = state.frame = undefined;
  };
  const send = async (id: string, state: State) => {
    if (state.inFlight || !state.pending || states.get(id) !== state) return;
    const dimensions = state.pending;
    state.pending = undefined;
    if (sameSize(state.acknowledged, dimensions)) return;
    state.inFlight = true;
    try {
      await resize(id, dimensions);
      state.acknowledged = dimensions;
    } catch {
      // Retry on the next fit, without a tight retry loop or an old failure
      // invalidating the terminal's newer local dimensions.
      state.acknowledged = undefined;
    } finally {
      state.inFlight = false;
      if (states.get(id) === state) void send(id, state);
    }
  };
  return {
    request(id: string, immediate = false) {
      let state = states.get(id);
      if (!state) {
        state = { inFlight: false };
        states.set(id, state);
      }
      const current = state;
      clearScheduled(current);
      current.pending = undefined;
      const queueFrame = () => {
        current.timer = undefined;
        current.frame = window.requestAnimationFrame(() => {
          current.frame = undefined;
          if (states.get(id) !== current) return;
          try {
            const dimensions = fit(id);
            if (!dimensions || !Number.isInteger(dimensions.cols) || !Number.isInteger(dimensions.rows) || dimensions.cols <= 0 || dimensions.rows <= 0) return;
            current.pending = dimensions;
            void send(id, current);
          } catch { /* A detached/disposed terminal will be fitted when shown again. */ }
        });
      };
      if (immediate) queueFrame();
      else current.timer = window.setTimeout(queueFrame, settleMs);
    },
    cancel(id: string) {
      const state = states.get(id);
      if (!state) return;
      clearScheduled(state);
      state.pending = undefined;
    },
    dispose(id: string) {
      this.cancel(id);
      states.delete(id);
    },
    disposeAll() {
      for (const id of states.keys()) this.dispose(id);
    },
  };
}
