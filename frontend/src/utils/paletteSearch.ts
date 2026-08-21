export type PaletteMode = "all" | "commands" | "sessions" | "connections";

export type PaletteResultLike = {
  type: string;
  title: string;
  subtitle?: string;
  keywords?: string;
  category?: string;
  scope?: string;
  defaultShortcuts?: readonly string[];
  mode?: PaletteMode;
  mruKey?: string;
  action: () => void;
};

export type PaletteMatch = {
  result: PaletteResultLike;
  score: number;
  highlights: number[];
  mruRank: number;
  group: string;
};

export type ParsedPaletteQuery = {
  mode: PaletteMode;
  query: string;
};

const MRU_STORAGE_KEY = "gxshell.command-palette.mru.v1";
const MAX_MRU_ENTRIES = 32;

export function parsePaletteQuery(raw: string): ParsedPaletteQuery {
  const trimmed = raw.trimStart();
  const prefix = trimmed[0];
  if (prefix === ">") return { mode: "commands", query: trimmed.slice(1).trimStart() };
  if (prefix === "@") return { mode: "sessions", query: trimmed.slice(1).trimStart() };
  if (prefix === "#") return { mode: "connections", query: trimmed.slice(1).trimStart() };
  return { mode: "all", query: trimmed };
}

function normalizedChars(value: string): string[] {
  return Array.from(value.toLocaleLowerCase());
}

function modeForResult(result: PaletteResultLike): PaletteMode {
  if (result.mode) return result.mode;
  const type = result.type.toLowerCase();
  if (type === "command" || type === "cmd" || type === "action") return "commands";
  if (type === "terminal" || type === "session") return "sessions";
  if (type === "server" || type === "profile" || type === "connection") return "connections";
  return "all";
}

function groupForResult(result: PaletteResultLike): string {
  if (result.category?.trim()) return result.category.trim();
  const mode = modeForResult(result);
  if (mode === "commands") return "Commands";
  if (mode === "sessions") return "Sessions";
  if (mode === "connections") return "Connections";
  return result.type || "Other";
}

function subsequenceScore(label: string, query: string): { score: number; highlights: number[] } | null {
  const labelChars = normalizedChars(label);
  const queryChars = normalizedChars(query);
  if (!queryChars.length) return { score: 0, highlights: [] };
  const highlights: number[] = [];
  let cursor = 0;
  for (const queryChar of queryChars) {
    let found = -1;
    for (let index = cursor; index < labelChars.length; index += 1) {
      if (labelChars[index] === queryChar) {
        found = index;
        break;
      }
    }
    if (found < 0) return null;
    highlights.push(found);
    cursor = found + 1;
  }
  const compactness = queryChars.length / Math.max(labelChars.length, 1);
  const boundaryBonus = highlights.reduce((sum, index, i) => {
    if (i === 0 || index === 0) return sum + 0.05;
    const previous = labelChars[index - 1];
    return sum + (previous === " " || previous === "-" || previous === "_" || previous === "/" ? 0.05 : 0);
  }, 0);
  return { score: 0.35 + compactness * 0.35 + boundaryBonus, highlights };
}

function titleMatch(title: string, query: string): { score: number; highlights: number[] } | null {
  const titleChars = normalizedChars(title);
  const queryChars = normalizedChars(query);
  if (!queryChars.length) return { score: 0, highlights: [] };
  if (queryChars.length <= titleChars.length) {
    for (let start = 0; start <= titleChars.length - queryChars.length; start += 1) {
      if (queryChars.every((char, offset) => titleChars[start + offset] === char)) {
        return { score: 1.2 + queryChars.length / Math.max(titleChars.length, 1), highlights: queryChars.map((_, offset) => start + offset) };
      }
    }
  }
  return subsequenceScore(title, query);
}

export function matchPaletteResult(
  result: PaletteResultLike,
  rawQuery: string,
  mru: readonly string[] = readPaletteMru(),
): PaletteMatch | null {
  const parsed = parsePaletteQuery(rawQuery);
  const resultMode = modeForResult(result);
  if (parsed.mode !== "all" && resultMode !== parsed.mode) return null;
  const query = parsed.query;
  const mruRank = mru.indexOf(result.mruKey || `${result.type}:${result.title}`);
  const group = groupForResult(result);
  if (!query) return { result, score: 0, highlights: [], mruRank, group };

  const fields = [result.title, result.subtitle || "", result.keywords || "", result.category || ""];
  const title = titleMatch(result.title, query);
  const lowerQuery = query.toLocaleLowerCase();
  const substringField = fields.findIndex((field) => field.toLocaleLowerCase().includes(lowerQuery));
  const fallback = fields
    .map((field) => subsequenceScore(field, query))
    .filter((match): match is { score: number; highlights: number[] } => !!match)
    .sort((a, b) => b.score - a.score)[0];
  if (!title && substringField < 0 && !fallback) return null;
  const score = (title?.score || 0) + (substringField >= 0 ? 0.25 : 0) + (fallback?.score || 0) * 0.15;
  return { result, score, highlights: title?.highlights || [], mruRank, group };
}

export function searchPaletteResults(results: readonly PaletteResultLike[], rawQuery: string): PaletteMatch[] {
  const parsed = parsePaletteQuery(rawQuery);
  const mru = readPaletteMru();
  return results
    .map((result, index) => {
      const match = matchPaletteResult(result, rawQuery, mru);
      return match ? { match, index } : null;
    })
    .filter((item): item is { match: PaletteMatch; index: number } => !!item)
    .sort((left, right) => {
      if (!parsed.query) {
        if (left.match.mruRank !== right.match.mruRank) {
          if (left.match.mruRank < 0) return 1;
          if (right.match.mruRank < 0) return -1;
          return left.match.mruRank - right.match.mruRank;
        }
        // With no query there is nothing to score, so the caller's order is the
        // curated suggestion order. Alphabetizing it here would scramble the
        // "favourites and primary actions first" list the palette opens with.
        return left.index - right.index;
      }
      return right.match.score - left.match.score
        || left.match.result.title.localeCompare(right.match.result.title);
    })
    .map((item) => item.match);
}

export function readPaletteMru(storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage): string[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(MRU_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, MAX_MRU_ENTRIES) : [];
  } catch {
    return [];
  }
}

export function rememberPaletteResult(result: PaletteResultLike, storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage): void {
  if (!storage) return;
  const key = result.mruKey || `${result.type}:${result.title}`;
  const next = [key, ...readPaletteMru(storage).filter((item) => item !== key)].slice(0, MAX_MRU_ENTRIES);
  try {
    storage.setItem(MRU_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be disabled in hardened WebViews; MRU is an enhancement.
  }
}

export function clearPaletteMru(storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage): void {
  try { storage?.removeItem(MRU_STORAGE_KEY); } catch { /* optional persistence */ }
}
