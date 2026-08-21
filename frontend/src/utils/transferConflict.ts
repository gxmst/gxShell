export type TransferEntry = {
  name: string;
  isDir: boolean;
  size?: number;
  modTime?: unknown;
};

export type TransferConflictDetail = {
  name: string;
  source: TransferEntry;
  destination: TransferEntry;
};

export type TransferConflicts = {
  replaceable: string[];
  directories: string[];
};

const nameKey = (name: string, caseInsensitive: boolean) => (
  caseInsensitive ? name.toLowerCase() : name
);

export function findTransferConflicts(
  sources: readonly TransferEntry[],
  destinations: readonly TransferEntry[],
  caseInsensitive = false,
): TransferConflicts {
  const destinationByName = new Map(
    destinations.map((entry) => [nameKey(entry.name, caseInsensitive), entry]),
  );
  const replaceable: string[] = [];
  const directories: string[] = [];

  for (const source of sources) {
    const destination = destinationByName.get(nameKey(source.name, caseInsensitive));
    if (!destination) continue;
    (destination.isDir ? directories : replaceable).push(source.name);
  }

  return { replaceable, directories };
}

export function excludeTransferNames<T extends { name: string }>(
  sources: readonly T[],
  names: readonly string[],
  caseInsensitive = false,
): T[] {
  const excluded = new Set(names.map((name) => nameKey(name, caseInsensitive)));
  return sources.filter((source) => !excluded.has(nameKey(source.name, caseInsensitive)));
}

/** Returns the metadata paired with each collision without changing the
 * compact name-only result consumed by existing queue logic. */
export function describeTransferConflicts(
  sources: readonly TransferEntry[],
  destinations: readonly TransferEntry[],
  caseInsensitive = false,
): TransferConflictDetail[] {
  const destinationByName = new Map(
    destinations.map((entry) => [nameKey(entry.name, caseInsensitive), entry]),
  );
  return sources.flatMap((source) => {
    const destination = destinationByName.get(nameKey(source.name, caseInsensitive));
    return destination ? [{ name: source.name, source, destination }] : [];
  });
}
