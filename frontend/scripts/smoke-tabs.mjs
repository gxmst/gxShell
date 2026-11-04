// Isolated Wails mocks: no application data, credentials or real connections.
/* global window, document */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, preview } from 'vite';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const production = process.argv.includes('--preview');
const server = production ? await preview({ root, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' }) : await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
if (!production) await server.listen();
const out = await mkdtemp(join(tmpdir(), 'gxshell-tabs-'));
let browser, page;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  context.setDefaultTimeout(15000);
  await context.addInitScript(() => {
    const events = new Map();
    window.smokeEmit = (name, data) => { for (const callback of events.get(name) || []) callback(data); };
    window.smokeClosed = []; window.smokeSaved = []; window.smokeFailSave = false;
    const settings = { themeName: 'Light', language: 'zh-CN', monitorEnabled: false, monitorIntervalSec: 5, connectionTimeout: 15, sidebarWidth: 290, sidebarSplitPct: 45, highlightLevel: 'off', highlightRules: [], restoreWorkspace: false, cliServerEnabled: false, updateCheckEnabled: false, ai: { provider: '', endpoint: '', apiKey: '', model: '' }, terminal: { fontFamily: 'Consolas', fontSize: 14, lineHeight: 1.25, scrollbackLines: 5000, cursorStyle: 'block', themeName: 'Light' } };
    const profiles = ['db', 'web', 'cache'].map((id) => ({ id, name: `${id}-01`, host: `${id}.example.test`, username: 'ops', port: 22, group: 'Production', authType: 'agent', tunnels: [] }));
    let sessions = profiles.flatMap((profile) => Array.from({ length: 8 }, (_, index) => ({ id: `session-${profile.id}-${index}`, profileId: profile.id, instanceId: index ? `instance-${index}` : '', runtimeId: `profile:${profile.id}:${index}`, generation: 1, name: profile.name, state: 'connected', cols: 80, rows: 24 })));
    const app = {
      GetSettings: () => settings, UpdateSettings: (value) => Object.assign(settings, value), GetVersion: () => '1.8.0', GetAppInfo: () => ({ dataDir: 'isolated-data' }), GetStartupFile: () => '',
      ListProfiles: () => profiles, ListSessions: () => sessions, ListCommands: () => [], IsWindowMaximised: () => false, IsTextContextMenuRegistered: () => false,
      Disconnect: (id) => { window.smokeClosed.push(id); sessions = sessions.filter((session) => session.id !== id); },
      ReadLocalFile: () => ({ content: '# Notes\n\nOriginal content.', version: 'original' }), ListTextFilesInDir: () => ['/notes.md', '/other.md'], RestoreTextFiles: (paths) => paths,
      WriteLocalFile: (path, content) => { if (window.smokeFailSave) throw new Error('Isolated save failure'); window.smokeSaved.push({ path, content }); return { version: 'saved', conflict: false }; },
    };
    window.go = { app: { App: new Proxy(app, { get: (target, key) => (...args) => Promise.resolve(target[key] ? target[key](...args) : /^List|^Read/.test(String(key)) ? [] : undefined) }) } };
    window.runtime = new Proxy({ EventsOnMultiple: (name, callback) => { const handlers = events.get(name) || new Set(); handlers.add(callback); events.set(name, handlers); if (name === 'file:open-external') window.smokeReady = true; return () => handlers.delete(callback); } }, { get: (target, key) => target[key] || (() => undefined) });
  });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.smokeReady && document.querySelectorAll('.tab').length === 24);
  const allTabs = page.getByRole('button', { name: '全部标签', exact: true });
  const pick = async (label) => {
    await allTabs.click();
    const menu = page.getByRole('dialog', { name: '全部标签' });
    await menu.getByRole('textbox').fill(label);
    await menu.getByRole('button', { name: label, exact: true }).click();
  };
  const tab = (id) => page.locator(`.tab[data-tab-id="${id}"]`);
  const menuFor = async (id) => { await tab(id).scrollIntoViewIfNeeded(); await tab(id).click({ button: 'right' }); return page.getByRole('menu'); };
  for (const id of ['session-db-0', 'session-db-1', 'session-web-0', 'session-cache-0']) {
    await (await menuFor(id)).getByRole('menuitem', { name: '固定标签', exact: true }).click();
  }
  assert.equal(await page.locator('.tabs-pinned-region .tab').count(), 4);
  await pick('db-01 · 3');
  const normal = page.locator('.tabs-scroll[data-pinned="false"]');
  const pinned = page.locator('.tabs-scroll[data-pinned="true"]');
  const pinnedLeft = await pinned.evaluate((host) => host.scrollLeft);
  const beforeWidth = await tab('session-db-2').evaluate((node) => node.getBoundingClientRect().width);
  assert.equal(beforeWidth, 150);
  await page.getByRole('button', { name: '向右滚动标签', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.tabs-scroll[data-pinned="false"]').scrollLeft > 10);
  assert.equal(await pinned.evaluate((host) => host.scrollLeft), pinnedLeft, 'Normal scrolling moved pinned tabs');
  await pick('cache-01 · 8');
  assert.equal(await tab('session-cache-7').evaluate((node) => node.getBoundingClientRect().width), beforeWidth, 'Selecting a tab changed its width');
  await allTabs.click();
  let menu = page.getByRole('dialog', { name: '全部标签' });
  assert.equal(await menu.locator('.tab-overflow-group').count(), 3);
  await menu.getByRole('textbox').fill('db.example.test');
  assert.equal(await menu.locator('.tab-overflow-main').count(), 8);
  await page.screenshot({ path: join(out, 'groups.png') });
  await page.keyboard.press('Escape');
  await pick('db-01 · 3');
  const firstBox = await tab('session-db-2').boundingBox();
  const secondBox = await tab('session-db-3').boundingBox();
  await page.mouse.move(firstBox.x + 40, firstBox.y + 14); await page.mouse.down();
  await page.mouse.move(secondBox.x + 60, secondBox.y + 14, { steps: 12 }); await page.mouse.up();
  await page.waitForFunction(() => {
    const ids = [...document.querySelectorAll('.tabs-scroll[data-pinned="false"] .tab')].map((tab) => tab.dataset.tabId);
    return ids.indexOf('session-db-3') < ids.indexOf('session-db-2');
  });
  assert.equal(await tab('session-db-2').locator('.tab-main').getAttribute('aria-label'), 'db-01 · 3', 'Reordering changed the terminal number');
  for (const width of [1440, 900, 540]) {
    await page.setViewportSize({ width, height: 720 });
    await pick('cache-01 · 8');
    assert(await normal.evaluate((host) => { const selected = host.querySelector('.tab-active').getBoundingClientRect(); const bounds = host.getBoundingClientRect(); return selected.left >= bounds.left - 1 && selected.right <= bounds.right + 1 && bounds.width > 20; }), `Active tab clipped at ${width}`);
    assert(await page.locator('.topbar').evaluate((bar) => bar.scrollWidth <= bar.clientWidth + 1), `Top bar overflows at ${width}`);
    if (width === 540) {
      await page.getByRole('button', { name: '固定标签', exact: true }).click();
      const fixedMenu = page.getByRole('dialog', { name: '全部标签' });
      assert.equal(await fixedMenu.locator('.tab-overflow-main').count(), 4);
      await fixedMenu.getByRole('textbox').fill('cache.example.test');
      await fixedMenu.getByRole('button', { name: 'cache-01 · 1', exact: true }).click();
      assert(await page.locator('.tabs-pinned-compact.active').isVisible());
      await pick('cache-01 · 8');
      const compactWidth = await tab('session-cache-7').evaluate((node) => node.getBoundingClientRect().width);
      assert(compactWidth >= 110, 'Compact controls left too little room for a title');
      assert(await tab('session-cache-7').evaluate((node) => {
        const number = node.querySelector('.tab-number');
        const title = node.querySelector('.tab-title');
        const bounds = node.querySelector('.tab-main').getBoundingClientRect();
        const suffix = number.getBoundingClientRect();
        return number.textContent === '· 8' && number.scrollWidth <= number.clientWidth && suffix.left >= bounds.left && suffix.right <= bounds.right + 1 && title.clientWidth >= 24;
      }), 'Narrow tab hid its terminal number or name');
      await pick('cache-01 · 7');
      assert.equal(await tab('session-cache-7').evaluate((node) => node.getBoundingClientRect().width), compactWidth, 'Selection changed the narrow tab width');
      await pick('cache-01 · 8');
    }
    await page.screenshot({ path: join(out, `tabs-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => window.smokeEmit('file:open-external', '/notes.md'));
  await page.getByRole('tab', { name: 'notes.md', exact: true }).waitFor();
  await page.evaluate(() => window.smokeEmit('file:open-external', '/other.md'));
  await page.getByRole('tab', { name: 'other.md', exact: true }).waitFor();
  await pick('notes.md');
  const documentView = page.locator('.markdown-viewer[data-active="true"]');
  await documentView.getByTitle('编辑', { exact: true }).click();
  await documentView.locator('.cm-content[contenteditable="true"]').click();
  await page.keyboard.press('Control+End'); await page.keyboard.type(' updated');
  await tab(await page.getByRole('tab', { name: 'notes.md', exact: true }).evaluate((button) => button.closest('.tab').dataset.tabId)).locator('.tab-dirty-dot').waitFor();
  const closeRight = async () => (await menuFor('session-cache-7')).getByRole('menuitem', { name: '关闭右侧标签', exact: true }).click();
  await closeRight();
  let confirmation = page.getByRole('dialog', { name: '保存更改？', exact: true });
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('.tab').count(), 26, 'Cancel continued the close batch');
  await closeRight();
  confirmation = page.getByRole('dialog', { name: '保存更改？', exact: true });
  await page.evaluate(() => { window.smokeFailSave = true; });
  await confirmation.getByRole('button', { name: '保存', exact: true }).click();
  await confirmation.getByRole('alert').waitFor();
  assert.equal(await page.locator('.tab').count(), 26, 'Failed save closed a document');
  await page.evaluate(() => { window.smokeFailSave = false; });
  await confirmation.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 24);
  assert.equal(await page.evaluate(() => window.smokeSaved.length), 1);
  assert((await page.evaluate(() => window.smokeSaved[0].content)).includes('updated'));
  await (await menuFor('session-db-2')).getByRole('menuitem', { name: '关闭其他标签', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 5);
  assert.equal(await page.locator('.tabs-pinned-region .tab').count(), 4);
  for (const id of ['session-db-0', 'session-db-1', 'session-web-0', 'session-cache-0']) {
    await (await menuFor(id)).getByRole('menuitem', { name: '取消固定', exact: true }).click();
  }
  await pick('cache-01 · 1');
  assert.equal(await page.getByRole('button', { name: '向右滚动标签', exact: true }).count(), 0);
  await page.setViewportSize({ width: 900, height: 720 });
  await page.getByRole('button', { name: '向右滚动标签', exact: true }).waitFor();
  assert(await normal.evaluate((host) => {
    const selected = host.querySelector('.tab-active').getBoundingClientRect();
    const bounds = host.getBoundingClientRect();
    return selected.left >= bounds.left - 1 && selected.right <= bounds.right + 1;
  }), 'Appearing overflow arrows clipped the active tab');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', mode: production ? 'production' : 'development', screenshots: out, checks: ['24 numbered terminals', 'fixed widths and pinned area', 'independent overflow scrolling', 'server grouping and address search', 'drag reorder preserves numbering', '1440/900/540px layouts and compact pinned picker', 'close-right cancel and failed-save protection', 'save before bulk close', 'close-others preserves pinned tabs', 'appearing overflow arrows retain the active tab'] }));
} catch (error) {
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => undefined);
  console.error(JSON.stringify({ status: 'failed', screenshots: out }));
  throw error;
} finally {
  if (browser) await browser.close();
  await server.close();
}
