export interface DocumentScrollPosition {
  kind: 'source' | 'html';
  anchor: number;
  offset: number;
  ratio: number;
  left: number;
}

export interface DocumentAppearance {
  zoom: number;
  leading: number;
  width: 'comfortable' | 'wide' | 'full';
}

const POSITIONS_KEY = 'gx:documentReadingPositions';
const APPEARANCE_KEY = 'gx:documentAppearance';
const MAX_POSITIONS = 80;

export function readDocumentPosition(key: string): DocumentScrollPosition | null {
  try {
    const entries = JSON.parse(localStorage.getItem(POSITIONS_KEY) || '[]') as unknown;
    if (!Array.isArray(entries)) return null;
    const position = entries.find((entry) => Array.isArray(entry) && entry[0] === key)?.[1];
    if (!position || !['source', 'html'].includes(position.kind)
      || !['anchor', 'offset', 'ratio', 'left'].every((field) => Number.isFinite(position[field]))
      || !Number.isInteger(position.anchor) || position.anchor < 0 || position.ratio < 0 || position.ratio > 1) return null;
    return position;
  } catch { return null; }
}

export function writeDocumentPosition(key: string, position: DocumentScrollPosition) {
  try {
    const saved = JSON.parse(localStorage.getItem(POSITIONS_KEY) || '[]') as unknown;
    const entries = Array.isArray(saved) ? saved.filter((entry) => Array.isArray(entry) && entry[0] !== key) : [];
    localStorage.setItem(POSITIONS_KEY, JSON.stringify([[key, position], ...entries].slice(0, MAX_POSITIONS)));
  } catch { /* Reading still works with storage disabled or full. */ }
}

const DEFAULT_APPEARANCE: DocumentAppearance = { zoom: 1, leading: 1.85, width: 'comfortable' };

/** One parser for both the on-demand read and the shared store. */
function parseDocumentAppearance(raw: string | null): DocumentAppearance {
  try {
    const value = JSON.parse(raw || '{}');
    return {
      zoom: Number.isFinite(value.zoom) ? Math.min(2.2, Math.max(0.7, value.zoom)) : DEFAULT_APPEARANCE.zoom,
      leading: Number.isFinite(value.leading) ? Math.min(2.2, Math.max(1.4, value.leading)) : DEFAULT_APPEARANCE.leading,
      width: ['comfortable', 'wide', 'full'].includes(value.width) ? value.width : DEFAULT_APPEARANCE.width,
    };
  } catch { return DEFAULT_APPEARANCE; }
}

function readAppearanceRaw(): string | null {
  try { return localStorage.getItem(APPEARANCE_KEY); } catch { return null; }
}

export function readDocumentAppearance(): DocumentAppearance {
  return parseDocumentAppearance(readAppearanceRaw());
}

/** Persists the value and returns the exact text stored, for the cache to match. */
export function writeDocumentAppearance(value: DocumentAppearance): string {
  const raw = JSON.stringify(value);
  try { localStorage.setItem(APPEARANCE_KEY, raw); } catch { /* In-memory value still applies. */ }
  return raw;
}

/**
 * The appearance a document is read with is one setting shared by every viewer,
 * but each viewer used to keep its own copy and write the whole object back on
 * any change. In a split view that made the panes fight: setting the zoom in one
 * and the line height in the other wrote the second viewer's stale zoom over the
 * first, so the two never agreed and the stored value flipped between them.
 *
 * Holding the value in one place and patching single fields removes the race
 * instead of sequencing it, and it makes a change in one pane visible in the
 * other - which is what "shared setting" was supposed to mean.
 *
 * The cached object is what makes the value stable enough for
 * useSyncExternalStore, but it is only trusted while it still matches what
 * storage holds: the cached copy is a memo of the stored value, not a second
 * source of truth that could drift away from it.
 */
let appearance: DocumentAppearance | null = null;
let appearanceRaw: string | null = null;
const appearanceListeners = new Set<() => void>();

export function getDocumentAppearance(): DocumentAppearance {
  const raw = readAppearanceRaw();
  if (!appearance || raw !== appearanceRaw) {
    appearance = parseDocumentAppearance(raw);
    appearanceRaw = raw;
  }
  return appearance;
}

/** Applies only the named fields, leaving the others as they are. */
export function updateDocumentAppearance(patch: Partial<DocumentAppearance>) {
  const current = getDocumentAppearance();
  const next: DocumentAppearance = { ...current, ...patch };
  if (next.zoom === current.zoom && next.leading === current.leading && next.width === current.width) return;
  appearance = next;
  appearanceRaw = writeDocumentAppearance(next);
  for (const listener of appearanceListeners) listener();
}

export function subscribeDocumentAppearance(listener: () => void): () => void {
  appearanceListeners.add(listener);
  return () => { appearanceListeners.delete(listener); };
}

/** Test seam: drop the cached value so the next read comes from storage. */
export function resetDocumentAppearance() {
  appearance = null;
  appearanceRaw = null;
}
