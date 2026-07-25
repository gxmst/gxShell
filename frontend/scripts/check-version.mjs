// Zero-dependency version consistency checker.
//
// backend/version/version.go is the single source of truth for the release
// version, but two files cannot read it: wails.json and package.json both need a
// literal, because their build tools parse them as plain JSON. Those copies had
// already drifted once — the desktop app reported 1.3.0 while gxshell-cli
// reported 1.4.0 — which is the kind of mismatch nothing fails on and everyone
// notices only after a release.
//
// This script compares the two literals against the Go constant. Run via
// `npm run check:version` (also chained into `npm run build`). Exits non-zero on
// any mismatch, naming the file to fix.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const versionGoPath = join(repoRoot, 'backend', 'version', 'version.go');
const wailsJsonPath = join(repoRoot, 'wails.json');
const packageJsonPath = join(here, '..', 'package.json');

function fail(message) {
  console.error(`check-version: ${message}`);
  process.exit(1);
}

function readGoVersion() {
  const source = readFileSync(versionGoPath, 'utf8');
  // Matches: const Version = "1.3.0"
  const match = source.match(/const\s+Version\s*=\s*"([^"]+)"/);
  if (!match) fail(`could not find "const Version" in ${versionGoPath}`);
  return match[1];
}

function readJsonField(path, field) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`could not parse ${path}: ${err.message}`);
  }
  return field.split('.').reduce((value, key) => (value == null ? value : value[key]), parsed);
}

const goVersion = readGoVersion();

const checks = [
  { label: 'wails.json (info.productVersion)', value: readJsonField(wailsJsonPath, 'info.productVersion') },
  { label: 'frontend/package.json (version)', value: readJsonField(packageJsonPath, 'version') },
];

const mismatches = checks.filter((check) => check.value !== goVersion);

if (mismatches.length > 0) {
  console.error(`check-version: backend/version/version.go declares ${goVersion}, but:`);
  for (const { label, value } of mismatches) {
    console.error(`  - ${label} is ${value ?? '(missing)'}`);
  }
  console.error('\nUpdate the files above to match, or change the Go constant if the bump is intentional.');
  process.exit(1);
}

console.log(`check-version: ${goVersion} consistent across version.go, wails.json and package.json`);
