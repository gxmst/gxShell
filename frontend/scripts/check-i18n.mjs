// Zero-dependency i18n consistency checker for src/i18n.ts.
//
// tsc already enforces structural parity: because `en` and `zhCN` are both typed
// `Record<LangKey, string>` under `strict`, a missing or extra key in either map
// is a hard compile error. This script covers the two gaps tsc cannot see:
//
//   1. Untranslated keys — a zh-CN value byte-identical to its en value, which
//      almost always means someone added an en string and forgot to translate it.
//      Genuinely-identical entries (brand names, acronyms) are allowlisted below.
//   2. Param-placeholder drift — a value like "Uploading {name}" whose {name}
//      placeholder is present in one locale but missing/renamed in the other, so
//      one language silently drops the interpolated value.
//
// Run via `npm run check:i18n` (also chained into `npm run build`). Exits non-zero
// with a per-key report on any violation.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const i18nPath = join(here, '..', 'src', 'i18n.ts');

// Keys whose zh-CN value is intentionally identical to en (brand names, acronyms,
// protocol names). Keep this list tight — every entry is a translation we are
// deliberately skipping.
const ALLOW_IDENTICAL = new Set([
  'cpu', 'mem', 'disk', 'ping', 'ai',
  'presetWeb', 'presetMySQL', 'presetRedis', 'presetSOCKS',
  'tunnelDynamic', 'aiOpenAICompatible',
]);

function extractBlock(source, declName) {
  // Match `const <declName>: Record<LangKey, string> = { ... };` and return the
  // text between the outermost braces. Locale maps are flat (no nested braces),
  // so a first-closing-brace scan is sufficient and avoids a real parser.
  const start = source.indexOf(`const ${declName}`);
  if (start === -1) throw new Error(`could not find "const ${declName}" in i18n.ts`);
  const open = source.indexOf('{', start);
  if (open === -1) throw new Error(`no opening brace after "const ${declName}"`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated object for "const ${declName}"`);
}

// Parse `key: "value",` lines. Handles double-quoted values with escaped quotes
// and escape sequences. Keys are simple identifiers, matching the LangKey union.
function parseEntries(block) {
  const entries = new Map();
  const re = /^\s*([A-Za-z0-9_]+)\s*:\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/gm;
  let m;
  while ((m = re.exec(block)) !== null) {
    entries.set(m[1], m[2]);
  }
  return entries;
}

// Placeholders are {name}, {host}, {n}, etc. Returns a sorted, de-duplicated list.
function placeholders(value) {
  const found = new Set();
  const re = /\{([A-Za-z0-9_]+)\}/g;
  let m;
  while ((m = re.exec(value)) !== null) found.add(m[1]);
  return [...found].sort();
}

function main() {
  const source = readFileSync(i18nPath, 'utf8');
  const en = parseEntries(extractBlock(source, 'en'));
  const zh = parseEntries(extractBlock(source, 'zhCN'));

  const problems = [];

  if (en.size === 0) problems.push('parsed 0 keys from `en` — the parser is broken, not the translations');
  if (zh.size === 0) problems.push('parsed 0 keys from `zhCN` — the parser is broken, not the translations');

  const untranslated = [];
  const paramDrift = [];

  for (const [key, enValue] of en) {
    const zhValue = zh.get(key);
    if (zhValue === undefined) continue; // structural drift is tsc's job

    if (zhValue === enValue && !ALLOW_IDENTICAL.has(key)) {
      untranslated.push(`  ${key}: "${enValue}"`);
    }

    const enP = placeholders(enValue).join(',');
    const zhP = placeholders(zhValue).join(',');
    if (enP !== zhP) {
      paramDrift.push(`  ${key}: en{${enP}} vs zh{${zhP}}`);
    }
  }

  if (untranslated.length) {
    problems.push(
      `${untranslated.length} zh-CN value(s) identical to en (untranslated?). ` +
      `If intentional, add the key to ALLOW_IDENTICAL in check-i18n.mjs:\n${untranslated.join('\n')}`,
    );
  }
  if (paramDrift.length) {
    problems.push(`${paramDrift.length} key(s) with mismatched {placeholders}:\n${paramDrift.join('\n')}`);
  }

  if (problems.length) {
    console.error(`i18n check FAILED (${en.size} en keys, ${zh.size} zh-CN keys):\n\n${problems.join('\n\n')}`);
    process.exit(1);
  }

  console.log(`i18n check OK: ${en.size} keys, all translated with consistent placeholders.`);
}

main();
