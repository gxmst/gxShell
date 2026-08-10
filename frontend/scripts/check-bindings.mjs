// Zero-dependency guard for the hand-maintained Wails bindings.
//
// frontend/wailsjs/ is written by hand in this repository, not generated output.
// CI builds with `-skipbindings`, but a local `wails build` (no flag) and
// `wails generate module` both regenerate it and silently revert hand-written
// corrections. Two regressions have happened this way:
//
//  1. The bound namespace. It is derived from the Go package name, so when the
//     app moved from package main to internal/app the calls had to change from
//     window.go.main.App to window.go.app.App. A stale namespace is invisible to
//     go build, tsc and vitest, and fails at runtime on every backend call --
//     the app opens and nothing works.
//
//  2. types.Profile.cliTrustUntil in models.ts. The generator cannot map
//     time.Time, so it emits `any` plus a convertValues(..., null) call. The
//     field is an RFC3339 string and the frontend parses it with Date.parse, so
//     the hand-written declaration is `string`.
//
// Run via `npm run check:bindings` (chained into `npm run build`). If this fails
// right after a local wails build, `git checkout -- frontend/wailsjs` and rerun.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = join(here, '..');

const appJsPath = join(frontendRoot, 'wailsjs', 'go', 'app', 'App.js');
const appDtsPath = join(frontendRoot, 'wailsjs', 'go', 'app', 'App.d.ts');
const modelsPath = join(frontendRoot, 'wailsjs', 'go', 'models.ts');

const failures = [];

function read(path, label) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    failures.push(`cannot read ${label} (${error.code ?? error.message})`);
    return null;
  }
}

const appJs = read(appJsPath, 'wailsjs/go/app/App.js');
const appDts = read(appDtsPath, 'wailsjs/go/app/App.d.ts');
const models = read(modelsPath, 'wailsjs/go/models.ts');

// 1. Bound namespace must match the Go package that Wails binds (internal/app).
if (appJs !== null) {
  const namespaces = new Set(
    [...appJs.matchAll(/window\['go'\]\['([^']+)'\]/g)].map((match) => match[1]),
  );
  if (namespaces.size === 0) {
    failures.push('App.js has no window[\'go\'][...] calls; bindings look truncated');
  }
  for (const namespace of namespaces) {
    if (namespace !== 'app') {
      failures.push(
        `App.js calls window['go']['${namespace}'] but the bound Go package is "app" ` +
          '(internal/app). Every backend call would fail at runtime.',
      );
    }
  }
}

// 2. cliTrustUntil stays a string, not the generator's `any`.
if (models !== null) {
  if (!/cliTrustUntil\?:\s*string;/.test(models)) {
    const actual = models.match(/cliTrustUntil\?:\s*([^;]+);/);
    failures.push(
      `models.ts declares cliTrustUntil as ${actual ? actual[1].trim() : 'missing'}; ` +
        'it must be `string` (RFC3339, parsed with Date.parse). A local wails build ' +
        'reverted it to the generator output.',
    );
  }
  if (/this\.cliTrustUntil = this\.convertValues\(/.test(models)) {
    failures.push(
      'models.ts wraps cliTrustUntil in convertValues; it must be assigned directly ' +
        'from source["cliTrustUntil"].',
    );
  }
}

// 3. Lifecycle plumbing must not be bound. These are package-level functions in
//    internal/app/entrypoint.go precisely so the webview cannot call them;
//    HandleSecondInstanceLaunch reaching the frontend is an arbitrary local file
//    read/write via allowFile.
if (appDts !== null) {
  const forbidden = [
    'SetTrayIcon',
    'SetStartupFilePath',
    'SetupSystemTray',
    'HandleSecondInstanceLaunch',
    'Startup',
    'DomReady',
    'Shutdown',
  ];
  for (const name of forbidden) {
    if (new RegExp(`^export function ${name}\\(`, 'm').test(appDts)) {
      failures.push(
        `App.d.ts binds ${name} to the frontend. Lifecycle entry points must stay ` +
          'unexported on App and be reached through internal/app/entrypoint.go.',
      );
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`check-bindings: ${failure}`);
  }
  // The most common way to get here is a `wails build` without -skipbindings,
  // which regenerates the bindings before this runs. Say so: whoever hits it is
  // looking at a failed build and a modified file they did not edit.
  console.error('');
  console.error('check-bindings: if you just ran `wails build` without -skipbindings, it');
  console.error('check-bindings: regenerated the hand-maintained bindings. Recover with:');
  console.error('check-bindings:   git checkout -- frontend/wailsjs');
  console.error('check-bindings: then rebuild as `wails build -clean -skipbindings`.');
  process.exit(1);
}

console.log('check-bindings: bindings look consistent');
