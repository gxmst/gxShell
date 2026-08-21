type OverlayEntry = {
  id: string;
  priority: number;
  order: number;
};

const entries: OverlayEntry[] = [];
const listeners = new Set<() => void>();
let nextOrder = 1;
let revision = 0;

const emit = () => {
  revision += 1;
  listeners.forEach((listener) => listener());
};

const sortedEntries = () => [...entries].sort((left, right) => (
  left.priority - right.priority || left.order - right.order
));

export const registerOverlay = (id: string, priority = 0) => {
  const existing = entries.findIndex((entry) => entry.id === id);
  if (existing >= 0) entries.splice(existing, 1);
  const entry: OverlayEntry = { id, priority, order: nextOrder++ };
  entries.push(entry);
  emit();

  // Close over the entry rather than its id: if the same id is registered twice
  // (a remount racing its own cleanup), removing by id would let the first
  // unregister delete the second registration's entry.
  return () => {
    const index = entries.indexOf(entry);
    if (index < 0) return;
    entries.splice(index, 1);
    emit();
  };
};

export const subscribeOverlays = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getOverlayRevision = () => revision;

export const getActiveOverlayId = () => sortedEntries().at(-1)?.id || "";

export const getOverlayLayer = (id: string) => {
  const index = sortedEntries().findIndex((entry) => entry.id === id);
  return 11000 + Math.max(0, index);
};

export const hasActiveOverlay = () => entries.length > 0;

