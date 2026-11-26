// Check the maintained runtime calls against the Go service and TypeScript declarations.
import { readFileSync, readdirSync } from 'node:fs';
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

// Maintained bindings must track the full exported App API in both JS and TS.
// This catches a new backend method omitted from one of the two binding files.
const appSourceRoot = join(frontendRoot, '..', 'internal', 'app');
const goMethods = new Set();
for (const file of readdirSync(appSourceRoot)) {
  if (!file.endsWith('.go') || file.endsWith('_test.go')) continue;
  const source = read(join(appSourceRoot, file), `internal/app/${file}`);
  for (const match of source?.matchAll(/func\s+\(\w+\s+\*App\)\s+([A-Z]\w*)\(/g) ?? []) {
    goMethods.add(match[1]);
  }
}
for (const [label, source] of [['App.js', appJs], ['App.d.ts', appDts]]) {
  if (source === null) continue;
  const methods = new Set([...source.matchAll(/^export function (\w+)\(/gm)].map((match) => match[1]));
  for (const method of goMethods) {
    if (!methods.has(method)) failures.push(`${label} is missing backend method ${method}`);
  }
  for (const method of methods) {
    if (!goMethods.has(method)) failures.push(`${label} exposes stale backend method ${method}`);
  }
}

if (!appJs?.includes("Call.ByName('gxShell/internal/app.App.' + method")) {
  failures.push('App.js must call the registered gxShell/internal/app.App service');
}
for (const method of goMethods) {
  if (!appJs?.includes('invoke("' + method + '"')) failures.push('Missing runtime call for ' + method);
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
  process.exit(1);
}

console.log('check-bindings: bindings look consistent');
