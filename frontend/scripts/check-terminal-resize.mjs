// Isolated browser smoke check: real xterm/UI, fictional sessions, no SSH or
// desktop backend. Requires Playwright on NODE_PATH, as marketing:capture does.
/* global window, document, HTMLCanvasElement, MutationObserver */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { installMarketingFixture } from './marketing-fixture.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, '../.tmp/terminal-resize-check');
const compare = process.argv.includes('--compare-head');
let previous;
if (compare) {
  const result = spawnSync('git', ['show', 'HEAD:frontend/src/hooks/useTerminal.ts'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  previous = result.stdout;
}
await mkdir(out, { recursive: true });
process.chdir(root);
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader'] });
const results = [];
try {
  for (const mode of compare ? ['head', 'current'] : ['current']) {
    const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false },
      plugins: mode === 'head' ? [{ name: 'resize-baseline', enforce: 'pre', load(id) {
        if (id.split('?')[0].replaceAll('\\', '/') === `${root.replaceAll('\\', '/')}/src/hooks/useTerminal.ts`) return previous;
      } }] : [] });
    await server.listen();
    try {
      const origin = server.resolvedUrls.local[0];
      for (const theme of ['Dark', 'Light']) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
        try {
          await context.route('**/*', (route) => route.request().url().startsWith(origin) || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort());
          await context.addInitScript(installMarketingFixture);
          await context.addInitScript(({ theme }) => {
            const app = window.go.app.App;
            const settings = window.marketingDemo.settings;
            settings.themeName = theme;
            settings.terminal.themeName = theme;
            app.ResizeTerminal = (id, cols, rows) => window.resizeProbe?.bridge.push({ id, cols, rows });
          }, { theme });
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(String(error)));
          await page.goto(origin);
          try { await page.locator('.xterm').first().waitFor(); }
          catch (error) {
            await page.screenshot({ path: resolve(out, 'startup-failure.png') });
            console.error(errors.join('\n') || await page.locator('body').innerText());
            throw error;
          }
          await page.evaluate(() => document.fonts.ready);
          await page.evaluate(() => window.marketingDemo.seedTerminals());
          await page.waitForTimeout(300);
          await page.evaluate(async () => {
            const entry = performance.getEntriesByType('resource').find((item) => item.name.includes('@xterm_addon-fit'));
            if (!entry) throw new Error('Could not locate the live FitAddon module');
            const { FitAddon } = await import(entry.name);
            const original = FitAddon.prototype.fit;
            window.resizeProbe = { fits: [], bridge: [], canvasChanges: 0 };
            FitAddon.prototype.fit = function () {
              original.call(this);
              const owner = this._terminal.element.closest('[data-floating-tab], [data-tab-id]');
              window.resizeProbe.fits.push({ id: owner?.dataset.floatingTab || owner?.dataset.tabId,
                cols: this._terminal.cols, rows: this._terminal.rows });
            };
            const observer = new MutationObserver((changes) => {
              window.resizeProbe.canvasChanges += changes.filter((item) => item.target instanceof HTMLCanvasElement).length;
            });
            observer.observe(document.querySelector('.terminal-stage'), { subtree: true, attributes: true, attributeFilter: ['width', 'height'] });
          });
          for (let step = 0; step < 24; step++) {
            await page.setViewportSize({ width: 1280 + step * 8, height: 800 + step * 3 });
            await page.waitForTimeout(12);
          }
          await page.waitForTimeout(250);
          const result = await page.evaluate(() => {
            const probe = window.resizeProbe;
            return { fits: probe.fits.length, bridgeCalls: probe.bridge.length, canvasChanges: probe.canvasChanges,
              finalFit: probe.fits.at(-1), finalPTY: probe.bridge.at(-1), canvases: document.querySelectorAll('.terminal-stage canvas').length };
          });
          assert.equal(errors.length, 0, errors.join('\n'));
          assert(result.canvases > 0, 'WebGL canvas was not exercised');
          assert(result.finalFit, 'No terminal fit was observed');
          assert.equal(result.finalPTY.cols, result.finalFit.cols);
          assert.equal(result.finalPTY.rows, result.finalFit.rows);
          // CDP viewport roundtrips can pause longer than the settle interval
          // under load. Catch per-frame reflow without assuming a perfect drag.
          if (mode === 'current') assert(result.fits <= 12, `Too many drag reflows: ${result.fits}`);
          if (mode === 'current') {
            const activeTab = page.locator('.tab-active');
            const id = await activeTab.getAttribute('data-tab-id');
            const tabBounds = await activeTab.boundingBox();
            assert(tabBounds, 'Active tab has no bounds');
            await page.mouse.move(tabBounds.x + tabBounds.width / 2, tabBounds.y + tabBounds.height / 2);
            await page.mouse.down();
            await page.mouse.move(tabBounds.x + tabBounds.width / 2, 180, { steps: 5 });
            await page.mouse.up();
            const floating = page.locator(`[data-floating-tab="${id}"]`);
            await floating.locator('.xterm').waitFor();
            await page.waitForTimeout(200);
            const readGrid = () => page.evaluate((id) => ({
              fit: window.resizeProbe.fits.filter((item) => item.id === id).at(-1),
              pty: window.resizeProbe.bridge.filter((item) => item.id === id).at(-1),
            }), id);
            const initialFloating = await readGrid();
            assert(initialFloating.fit, 'Floating terminal was not fitted');
            // Change active tabs to rerender TerminalArea while its floating
            // placeholder is still mounted, then exercise real pointer resize.
            await page.locator('.tab-main').last().click();
            const handle = await floating.locator('.floating-terminal-resize').boundingBox();
            assert(handle, 'Floating resize handle has no bounds');
            await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
            await page.mouse.down();
            await page.mouse.move(handle.x + handle.width / 2 + 160, handle.y + handle.height / 2 + 80, { steps: 10 });
            await page.mouse.up();
            await page.waitForTimeout(250);
            const resizedFloating = await readGrid();
            assert(resizedFloating.fit.cols > initialFloating.fit.cols, 'Floating columns did not resize after rerender');
            assert(resizedFloating.fit.rows > initialFloating.fit.rows, 'Floating rows did not resize after rerender');
            assert.equal(resizedFloating.pty.cols, resizedFloating.fit.cols);
            assert.equal(resizedFloating.pty.rows, resizedFloating.fit.rows);
            assert(await floating.locator('canvas').count() > 0, 'Floating WebGL renderer was lost');
            await floating.getByTitle('Dock back').click();
            await floating.waitFor({ state: 'detached' });
            await page.locator(`.terminal-stage [data-tab-id="${id}"] .xterm`).waitFor();
            await page.waitForTimeout(200);
            const docked = await readGrid();
            const viewport = page.viewportSize();
            await page.setViewportSize({ width: viewport.width - 120, height: viewport.height - 60 });
            await page.waitForTimeout(250);
            const resizedDocked = await readGrid();
            assert(resizedDocked.fit.cols < docked.fit.cols, 'Docked terminal did not resume host resize');
            assert.equal(resizedDocked.pty.cols, resizedDocked.fit.cols);
            assert.equal(resizedDocked.pty.rows, resizedDocked.fit.rows);
            result.floatingLifecycle = { initial: initialFloating.fit, resized: resizedFloating.fit, docked: docked.fit, resizedDocked: resizedDocked.fit };
          }
          assert.equal(errors.length, 0, errors.join('\n'));
          await page.screenshot({ path: resolve(out, `${mode}-${theme.toLowerCase()}.png`) });
          results.push({ mode, theme, ...result });
          console.log(JSON.stringify(results.at(-1)));
        } finally { await context.close(); }
      }
    } finally { await server.close(); }
  }
  await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(`Temporary verification files: ${out}`);
} finally { await browser.close(); }
