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

export function readDocumentAppearance(): DocumentAppearance {
  try {
    const value = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || '{}');
    return {
      zoom: Number.isFinite(value.zoom) ? Math.min(2.2, Math.max(0.7, value.zoom)) : 1,
      leading: Number.isFinite(value.leading) ? Math.min(2.2, Math.max(1.4, value.leading)) : 1.85,
      width: ['comfortable', 'wide', 'full'].includes(value.width) ? value.width : 'comfortable',
    };
  } catch { return { zoom: 1, leading: 1.85, width: 'comfortable' }; }
}

export function writeDocumentAppearance(value: DocumentAppearance) {
  try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(value)); } catch {}
}
