/**
 * Keeps the number of live WebGL contexts inside what the browser allows.
 *
 * xterm needs one context per terminal, but Chromium keeps only about sixteen
 * and silently drops the oldest when another is created. That choice is
 * arbitrary, so the context taken can belong to the terminal the user is looking
 * at - which then falls back to the slow renderer with no explanation. Evicting
 * our own least-recently-used context first keeps the decision where the
 * information is: a terminal nobody has looked at in a while gives up its
 * context, not the one on screen.
 *
 * An evicted terminal is remembered as wanting WebGL, so it takes a context back
 * the next time it is shown instead of staying degraded for the rest of the
 * session - which is also what makes a transient context loss recoverable.
 */
export const MAX_WEBGL_CONTEXTS = 12;

export function createWebglBudget(limit: number = MAX_WEBGL_CONTEXTS) {
  const holders: string[] = [];
  const wanting = new Set<string>();

  return {
    /** Records that id holds a context; returns the ids that must give theirs up. */
    acquire(id: string): string[] {
      wanting.delete(id);
      const at = holders.indexOf(id);
      if (at !== -1) holders.splice(at, 1);
      holders.push(id);
      const evicted: string[] = [];
      while (holders.length > limit) {
        const oldest = holders.shift();
        if (oldest === undefined) break;
        wanting.add(oldest);
        evicted.push(oldest);
      }
      return evicted;
    },

    /** Marks id as the most recently used without changing what it holds. */
    touch(id: string) {
      const at = holders.indexOf(id);
      if (at === -1) return;
      holders.splice(at, 1);
      holders.push(id);
    },

    release(id: string) {
      const at = holders.indexOf(id);
      if (at !== -1) holders.splice(at, 1);
    },

    /**
     * Marks id as needing a context it does not hold - either the budget took
     * one away or the browser did. It gets one back the next time it is shown.
     */
    want(id: string) {
      if (!holders.includes(id)) wanting.add(id);
    },

    /** Whether id lost its context and should get one back. */
    wantsWebgl: (id: string) => wanting.has(id),

    /** Forgets id entirely, for a context the browser took away on its own. */
    forget(id: string) {
      wanting.delete(id);
      const at = holders.indexOf(id);
      if (at !== -1) holders.splice(at, 1);
    },

    holders: () => [...holders],
  };
}

/**
 * Each WebGL problem is worth saying once per session: a context loss can repeat
 * as the browser recycles contexts, and a toast per occurrence would bury the
 * terminal it is describing.
 */
const notices = new Set<string>();

export function notifyWebglOnce(key: string, notify: () => void) {
  if (notices.has(key)) return;
  notices.add(key);
  notify();
}

/** Test seam: let the notices be shown again. */
export function resetWebglNotices() {
  notices.clear();
}
