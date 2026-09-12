// Requires Playwright on Node's module path. Uses isolated mocked Wails APIs;
// no running desktop app, server credentials or application data are touched.
// Pass --preview after a build to check the production bundle and worker assets.
/* global window, document */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, preview } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const sharp = require('sharp');
const out = await mkdtemp(join(tmpdir(), 'gxshell-workbench-'));
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const production = process.argv.includes('--preview');
const server = production
  ? await preview({ root, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  : await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
if (!production) await server.listen();
let browser;
let page;
const errors = [];
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true, args: ['--enable-webgl', '--use-angle=swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  context.setDefaultTimeout(30000);
  context.setDefaultNavigationTimeout(30000);
  await context.addInitScript(() => {
    const events = new Map();
    window.smokeEmit = (name, data) => { for (const callback of events.get(name) || []) callback(data); };
    window.smokeWrites = [];
    window.smokeDocumentWrites = [];
    window.smokeDocuments = {};
    window.smokeSiblings = null;
    window.smokeBackups = [];
    window.smokeQuit = false;
    let settings = {
      themeName: 'Light', language: 'zh-CN', highlightLevel: 'basic', highlightRules: [], monitorEnabled: false, monitorIntervalSec: 5, connectionTimeout: 15,
      sidebarWidth: 290, sidebarSplitPct: 45, smartHighlight: true, restoreWorkspace: false, cliServerEnabled: false, updateCheckEnabled: false,
      ai: { provider: '', apiKey: '', endpoint: '', model: '' }, sessionLog: { enabled: false, timestamps: true, maxFileMb: 10, maxSessionMb: 100 },
      terminal: { fontFamily: 'Consolas, monospace', fontSize: 14, lineHeight: 1.25, cursorStyle: 'block', cursorBlink: true, themeName: 'Light', backgroundOpacity: 1, scrollbackLines: 5000 },
    };
    let profiles = ['web-01', 'api-01', 'db-01', 'backup-01'].map((id, index) => ({ id, name: index === 0 ? '生产环境 / 华东区域 / primary-database-cluster / maintenance-connection-web-01' : id, group: index < 2 ? 'Production' : 'Infrastructure', host: `${id}.test`, port: 22, username: 'ops', authType: 'agent', rememberPassword: false, favorite: false, tags: [], tunnels: [], cliEnabled: false, autoReconnect: false, description: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...(index === 2 ? { terminal: { ...settings.terminal, themeName: 'Dark', fontSize: 18, backspaceKey: 'ctrl-h', deleteKey: 'del' } } : {}) }));
    let sessions = profiles.map((p) => ({ id: `session-${p.id}`, profileId: p.id, runtimeId: `profile:${p.id}`, generation: 1, name: p.name, state: 'connected', cols: 80, rows: 24 }));
    const app = {
      GetSettings: () => settings, UpdateSettings: (value) => { settings = value; return value; }, GetVersion: () => '1.7.0', GetStartupFile: () => '',
      ListProfiles: () => profiles, ListCommands: () => [], ListSessions: () => sessions, GetAppInfo: () => ({ dataDir: 'isolated-smoke-data' }),
      ListLogFiles: () => [], ListSessionLogFiles: () => [{ name: '2026-09-08-web-01.log', size: 1234, modTime: new Date().toISOString() }], ReadSessionLogFile: () => '[2026-09-08] session log entry',
      ListRemoteDir: () => [], ListTextFilesInDir: () => window.smokeSiblings || ['/notes.md', '/deploy.md', '/Dockerfile', '/.env.production', '/settings.jsonc', '/events.ndjson', '/service.yml'], ReadLocalFile: (path) => window.smokeDocuments[path] ?? (path.endsWith('.jsonc') ? '// deployment note\n{"big":9007199254740993,"enabled":true,}\n' : '# Notes\n\n中文说明\n\n```sh\necho ready\n```'), RestoreTextFiles: (paths) => paths,
      WriteLocalFile: (path, content) => { window.smokeDocumentWrites.push({ path, content }); },
      WriteToTerminal: (id, data) => { window.smokeWrites.push({ id, data }); },
      UpdateProfilesBatch: (ids, patch) => { profiles = profiles.map((p) => ids.includes(p.id) ? { ...p, ...patch } : p); return profiles; },
      Disconnect: (id) => { sessions = sessions.filter((s) => s.id !== id); },
      IsRecording: () => false, IsTextContextMenuRegistered: () => false, IsWindowMaximised: () => false,
      CloseWindow: () => { window.smokeQuit = true; },
      ExportBackup: (_passphrase, _workspaces, includeSecrets, includePrivateKeys) => {
        window.smokeBackups.push({ action: 'export', includeSecrets, includePrivateKeys });
        return { path: 'isolated-smoke-backup.gxbak', warnings: window.smokeExportWarnings || [] };
      },
      PreviewBackup: (_passphrase, workspaces, policy, restoreSettings) => {
        window.smokeBackups.push({ action: 'preview', policy, restoreSettings });
        window.smokeBackupPrevious = workspaces;
        return JSON.stringify({
          token: 'smoke-preview', createdAt: '2026-09-10T00:00:00Z', profiles: 1, commands: 2, workspacesAdded: 0, skipped: 1,
          privateKeys: 1, namedSecrets: 1, knownHosts: 2, settings: restoreSettings, workspaces,
          aiChanges: restoreSettings ? [
            { field: 'provider', before: 'openai', after: 'custom' },
            { field: 'endpoint', before: 'https://current-ai.invalid/v1', after: 'https://very-long-imported-ai-host.invalid/compatibility/api/v1' },
            { field: 'model', before: 'current-model', after: 'imported-model' },
          ] : [],
          changes: [{ kind: 'profile', name: 'Imported server', action: 'add' }, { kind: 'profile', name: 'Existing server', action: 'keep' }],
          warnings: ['External document is unavailable; copy it separately: /previous-computer/operations/runbooks/long-document-name.md'],
        });
      },
      ApplyBackup: (token, previous) => {
        if (token !== 'smoke-preview' || previous !== window.smokeBackupPrevious) throw new Error('Wrong backup preview');
        return new Promise((resolve) => { window.smokeFinishImport = () => { window.smokeBackups.push({ action: 'apply' }); resolve(); }; });
      },
      DiscardBackupPreview: () => undefined,
    };
    window.go = { app: { App: new Proxy(app, { get: (target, key) => (...args) => Promise.resolve(target[key] ? target[key](...args) : /^List|^Read/.test(String(key)) ? [] : undefined) }) } };
    window.runtime = new Proxy({ EventsOnMultiple: (name, callback) => { const list = events.get(name) || new Set(); list.add(callback); events.set(name, list); return () => list.delete(callback); } }, { get: (target, key) => target[key] || (() => undefined) });
  });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error' && /Maximum update|Cannot update|ErrorBoundary/.test(message.text())) errors.push(message.text()); });
  await page.goto(server.resolvedUrls.local[0]);
  await page.locator('.xterm').first().waitFor();
  await page.locator('.tab-tools-toggle').click();
  await page.getByRole('menuitem', { name: '四分屏' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.terminal-split-pane .xterm').length === 4, null, { timeout: 30000 });
  const emit = () => page.evaluate(() => {
    for (const id of ['web-01', 'api-01', 'db-01', 'backup-01']) window.smokeEmit('terminal:data', { sessionId: `session-${id}`, data: `${id} ready\r\n中文终端输出\r\nERROR test\r\n$ ` });
  });
  await emit();
  await page.waitForTimeout(250);
  // Recreate the previous width transition in-page, then compare the shipped
  // layout. Count geometry changes instead of imposing machine-specific FPS.
  const measureCollapse = (legacy) => page.evaluate(async (legacy) => {
    const style = document.createElement('style');
    if (legacy) style.textContent = '.workspace { transition: grid-template-columns 320ms ease-out !important; }';
    document.head.append(style);
    const pane = document.querySelector('.terminal-split-pane');
    const widths = [];
    const observer = new window.ResizeObserver(() => widths.push(pane.clientWidth));
    observer.observe(pane);
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    document.querySelector('.activity-rail button[aria-expanded]').click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    observer.disconnect();
    style.remove();
    return { resizeEvents: widths.length, distinctWidths: new Set(widths).size };
  }, legacy);
  const legacyCollapse = await measureCollapse(true);
  const optimizedExpand = await measureCollapse(false);
  const optimizedCollapse = await measureCollapse(false);
  assert(optimizedCollapse.distinctWidths <= 2 && optimizedExpand.distinctWidths <= 2, 'Sidebar animation still changes terminal geometry every frame');
  await page.locator('.activity-rail button[aria-expanded]').click();
  const sidebarPerformance = { legacyCollapse, optimizedCollapse, optimizedExpand };
  for (const [index, width, height] of [[0, 1440, 960], [1, 900, 700], [2, 540, 720]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(250);
    assert(await page.locator('.panel-head').evaluate((head) => {
      const bounds = head.getBoundingClientRect();
      return [...head.children].every((child) => {
        const box = child.getBoundingClientRect();
        return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
      }) && head.querySelector('.panel-head-primary').getBoundingClientRect().height <= 32;
    }), `Sidebar controls overflow at ${width}px`);
    const hosts = page.locator('.terminal-split-pane');
    assert.equal(await hosts.count(), 4);
    const boxes = await hosts.evaluateAll((nodes) => nodes.map((n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
    assert(boxes.every((r) => r.width > 40 && r.height > 50 && r.x + r.width <= width + 1 && r.y + r.height <= height + 1), JSON.stringify(boxes));
    for (let i = 0; i < 4; i++) {
      const pixels = await sharp(await hosts.nth(i).screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const colors = new Set();
      for (let p = 0; p < pixels.data.length; p += 3) colors.add(`${pixels.data[p]},${pixels.data[p + 1]},${pixels.data[p + 2]}`);
      assert(colors.size > 12, `Pane ${i} appears blank at ${width}px`);
    }
    await page.screenshot({ path: join(out, `panes-${index}.png`) });
  }
  await page.setViewportSize({ width: 900, height: 260 });
  await page.getByRole('button', { name: '全部标签', exact: true }).click();
  const tabsDialog = page.getByRole('dialog', { name: '全部标签', exact: true });
  const tabsFilter = tabsDialog.getByRole('textbox');
  const selectedBeforeIME = await page.locator('.tab-active').getAttribute('data-tab-id');
  await tabsFilter.evaluate((input) => {
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      for (const key of ['Enter', 'Escape', 'ArrowDown']) input.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...composition }));
    }
  });
  assert(await tabsDialog.isVisible(), 'IME candidate selection dismissed the tab picker');
  assert(await tabsFilter.evaluate((input) => document.activeElement === input), 'IME candidate selection moved focus');
  assert.equal(await page.locator('.tab-active').getAttribute('data-tab-id'), selectedBeforeIME);
  await tabsFilter.press('ArrowDown');
  assert(await tabsDialog.locator('.tab-overflow-main').first().evaluate((button) => document.activeElement === button));
  await page.keyboard.press('End');
  assert(await tabsDialog.locator('.tab-overflow-main').last().evaluate((button) => document.activeElement === button));
  assert(await tabsDialog.evaluate((node) => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= window.innerHeight - 10; }), 'Tab picker exceeds a short viewport');
  await page.screenshot({ path: join(out, 'tab-picker-short.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('[data-tab-id="session-db-01"] .xterm-helper-textarea').focus();
  await page.waitForTimeout(200);
  await page.keyboard.type('pwd');
  await page.waitForFunction(() => window.smokeWrites.length > 0, undefined, { timeout: 5000 });
  assert(await page.evaluate(() => window.smokeWrites.filter((write) => write.id === 'session-db-01').map((write) => write.data).join('').includes('pwd')), JSON.stringify(await page.evaluate(() => window.smokeWrites)));
  await page.evaluate(() => { window.smokeWrites = []; });
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => window.smokeWrites.map((write) => write.data).join('') === '\x08\x7f', null, { timeout: 30000 });
  await page.locator('.tab-tools-toggle').click();
  await page.getByRole('menuitem', { name: '同步输入到所有终端', exact: true }).click();
  await page.locator('[data-tab-id="session-db-01"] .xterm-helper-textarea').focus();
  await page.evaluate(() => { window.smokeWrites = []; });
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => window.smokeWrites.length === 4, null, { timeout: 30000 });
  const broadcastWrites = await page.evaluate(() => window.smokeWrites);
  assert(broadcastWrites.every(({ id, data }) => data === (id === 'session-db-01' ? '\x08' : '\x7f')), JSON.stringify(broadcastWrites));
  await page.locator('.broadcast-banner-off').click();
  const sidebarWidth = await page.locator('.left-rail').evaluate((n) => n.getBoundingClientRect().width);
  await page.evaluate(() => window.smokeEmit('file:open-external', '/notes.md'));
  await page.getByRole('heading', { name: /^#?\s*Notes$/ }).waitFor();
  assert.equal(await page.locator('.left-rail').evaluate((n) => n.getBoundingClientRect().width), sidebarWidth);
  await page.screenshot({ path: join(out, 'document.png') });
  const measureSidebar = () => page.locator('.left-rail').evaluate((rail) => {
    const nav = rail.querySelector('.activity-rail').getBoundingClientRect();
    const panel = rail.querySelector('.side-content').getBoundingClientRect();
    const outer = rail.getBoundingClientRect();
    return { width: outer.width, nav: nav.width, panel: panel.width, gap: outer.right - panel.right };
  });
  for (const [width, height] of [[1440, 960], [900, 700], [540, 720]]) {
    await page.setViewportSize({ width, height });
    await page.locator('.document-panel').waitFor();
    await page.waitForTimeout(120);
    const documentSidebar = await measureSidebar();
    assert(await page.locator('.tabs-scroll').evaluate((host) => {
      const active = host.querySelector('.tab-active').getBoundingClientRect();
      const bounds = host.getBoundingClientRect();
      return active.left >= bounds.left - 1 && active.right <= bounds.right + 1;
    }), 'Active document tab disappeared after resizing the window');
    assert.equal(documentSidebar.nav, 48, 'Activity rail width changed');
    assert(Math.abs(documentSidebar.gap - 1) <= 1, `Document panel disagrees with sidebar width: ${JSON.stringify(documentSidebar)}`);
    await page.getByRole('textbox', { name: '筛选文件…' }).fill('Docker');
    assert.equal(await page.locator('.document-files .text-file-row').count(), 1);
    await page.getByRole('button', { name: '定位当前文档' }).click();
    await page.screenshot({ path: join(out, `document-navigation-${width}.png`), animations: 'disabled' });
    await page.locator('.tab[data-tab-id="session-db-01"] .tab-main').click();
    await page.locator('.current-server-block').waitFor();
    assert.deepEqual(await measureSidebar(), documentSidebar, 'Terminal/document sidebar dimensions differ');
    await page.getByRole('tab', { name: 'notes.md', exact: true }).click();
    await page.locator('.document-panel').waitFor();
    assert.equal(await page.locator('.current-server-block').count(), 0, 'Document focus left the server monitor visible');
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.waitForTimeout(100);
  assert.equal((await measureSidebar()).panel, 290, 'Narrowing the window lost the preferred sidebar width');
  for (const [width, height] of [[1440, 960], [540, 720]]) {
    await page.setViewportSize({ width, height });
    await page.locator('.tab[data-tab-id="session-web-01"] .tab-main').click();
    await page.getByRole('button', { name: '全部标签', exact: true }).click();
    await page.getByRole('textbox', { name: '按名称、主机或路径查找标签…' }).fill('web-01.test');
    const menu = page.locator('.tab-overflow-dropdown');
    assert.equal(await menu.locator('.tab-overflow-main').count(), 1);
    assert((await menu.locator('.tab-overflow-text strong').innerText()).includes('maintenance-connection-web-01'));
    assert(await menu.evaluate((node) => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= window.innerWidth && node.scrollWidth <= node.clientWidth + 1; }), 'Long-title menu is clipped');
    await page.screenshot({ path: join(out, `long-titles-${width}.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole('tab', { name: 'notes.md', exact: true }).click();
  await page.evaluate(() => window.smokeEmit('file:open-external', '/settings.jsonc'));
  const jsonc = page.locator('.markdown-viewer[data-active="true"]');
  await jsonc.locator('.text-document').waitFor();
  await jsonc.getByTitle('编辑', { exact: true }).click();
  await jsonc.locator('.cm-editor').waitFor();
  await jsonc.getByTitle('格式化 JSON', { exact: true }).click();
  await jsonc.getByTitle('保存 (Ctrl+S)', { exact: true }).click();
  await page.waitForFunction(() => window.smokeDocumentWrites.length === 1, null, { timeout: 30000 });
  const savedJsonc = await page.evaluate(() => window.smokeDocumentWrites[0]);
  assert.equal(savedJsonc.path, '/settings.jsonc');
  assert(savedJsonc.content.includes('// deployment note') && savedJsonc.content.includes('9007199254740993'), 'JSONC formatting or saving lost comments/numeric precision');
  await page.screenshot({ path: join(out, 'jsonc-document.png'), animations: 'disabled' });

  await page.evaluate(() => { window.smokeSiblings = [...Array.from({ length: 5000 }, (_, index) => `/file-${index}.txt`), '/notes.md']; });
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await page.locator('.document-pagination').waitFor();
  await page.evaluate(() => window.smokeEmit('file:open-external', '/file-4321.txt'));
  await page.locator('.text-file-row[aria-current="page"][title="/file-4321.txt"]').waitFor();
  assert.equal(await page.locator('.document-files .text-file-row').count(), 200, 'Large directory rendered more than one page');
  await page.getByRole('textbox', { name: '筛选文件…' }).fill('file-4999.txt');
  assert.equal(await page.locator('.document-files .text-file-row').count(), 1, 'File filter did not search the full folder');
  await page.locator('.text-file-row[title="/file-4999.txt"]').click();
  await page.getByRole('button', { name: '定位当前文档', exact: true }).click();
  await page.locator('.text-file-row[aria-current="page"][title="/file-4999.txt"]').waitFor();
  assert.equal(await page.locator('.document-files .text-file-row').count(), 200, 'Reveal rendered all earlier pages');
  await page.screenshot({ path: join(out, 'document-large-folder.png'), animations: 'disabled' });
  await page.evaluate(() => { window.smokeSiblings = null; });
  await page.getByRole('tab', { name: 'notes.md', exact: true }).click();
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();

  await page.evaluate(() => {
    window.smokeDocuments['/events.ndjson'] = '{"event":"ready","id":9007199254740993,"ok":true}\n'.repeat(100000);
    window.smokeEmit('file:open-external', '/events.ndjson');
  });
  const ndjson = page.locator('.markdown-viewer[data-active="true"]');
  const readOnlyPreview = ndjson.locator('.text-document-virtual .cm-content');
  await readOnlyPreview.waitFor();
  assert.equal(await readOnlyPreview.getAttribute('aria-readonly'), 'true');
  assert.equal(await readOnlyPreview.getAttribute('contenteditable'), 'false');
  assert(await readOnlyPreview.locator('.cm-line').count() < 250, 'Large preview rendered the whole document');
  await ndjson.getByRole('button', { name: '查找', exact: true }).click();
  const largeSearch = ndjson.getByPlaceholder('查找');
  await largeSearch.pressSequentially('ready');
  assert(await largeSearch.evaluate((input) => document.activeElement === input), 'Finding a source match stole search input focus');
  await ndjson.locator('.markdown-search-count', { hasText: '1/100000' }).waitFor();
  await largeSearch.press('Escape');
  await readOnlyPreview.focus();
  await page.keyboard.press('Control+a');
  const copiedPreview = await readOnlyPreview.evaluate((node) => {
    const clipboardData = new window.DataTransfer();
    node.dispatchEvent(new window.ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }));
    const text = clipboardData.getData('text/plain');
    return { lines: text.split('\n').length - 1, exactNumber: text.includes('9007199254740993') };
  });
  assert.deepEqual(copiedPreview, { lines: 100000, exactNumber: true }, 'Virtual preview copy omitted offscreen lines');
  await page.screenshot({ path: join(out, 'document-large-preview.png'), animations: 'disabled' });
  await ndjson.getByTitle('编辑', { exact: true }).click();
  await ndjson.locator('.cm-editor').waitFor();
  await page.evaluate(() => {
    window.smokeWorkerFrames = 0;
    window.smokeMeasureWorker = true;
    const frame = () => {
      if (!window.smokeMeasureWorker) return;
      window.smokeWorkerFrames += 1;
      window.requestAnimationFrame(frame);
    };
    window.requestAnimationFrame(frame);
  });
  const formatWorker = page.waitForEvent('worker', { timeout: 30000 });
  await ndjson.getByTitle('格式化 JSON', { exact: true }).click();
  assert((await formatWorker).url().includes('jsonDocument.worker'), 'Large JSON formatting did not start a worker');
  await page.waitForFunction(() => {
    const button = document.querySelector('.markdown-viewer[data-active="true"] button[title="格式化 JSON"]');
    return button && !button.disabled;
  }, null, { timeout: 30000 });
  const workerFrames = await page.evaluate(() => { window.smokeMeasureWorker = false; return window.smokeWorkerFrames; });
  assert(workerFrames > 1, 'UI frames did not advance while the large document was processed');
  await ndjson.getByRole('button', { name: '查找', exact: true }).click();
  await ndjson.getByPlaceholder('查找').fill('ready');
  await ndjson.locator('.markdown-search-count', { hasText: '1/100000' }).waitFor();
  const saveWorker = page.waitForEvent('worker', { timeout: 30000 });
  await ndjson.getByTitle('保存 (Ctrl+S)', { exact: true }).click();
  assert((await saveWorker).url().includes('jsonDocument.worker'), 'Large JSON save validation did not start a worker');
  await page.waitForFunction(() => window.smokeDocumentWrites.length === 2, null, { timeout: 30000 });
  const savedNdjson = await page.evaluate(() => {
    const saved = window.smokeDocumentWrites[1];
    return { path: saved.path, lines: saved.content.split('\n').length - 1, exactNumber: saved.content.includes('9007199254740993') };
  });
  assert.deepEqual(savedNdjson, { path: '/events.ndjson', lines: 100000, exactNumber: true });
  console.log(`Large JSON worker smoke: 5,000,000 bytes / 100,000 lines, ${workerFrames} UI frames during format.`);
  await ndjson.locator('.text-document-virtual .cm-editor').waitFor();
  await ndjson.locator('.text-document-virtual .cm-selectionBackground').first().waitFor();
  await ndjson.getByPlaceholder('查找').press('Escape');
  await page.getByRole('button', { name: '关闭 events.ndjson', exact: true }).click();
  await page.getByRole('tab', { name: 'notes.md', exact: true }).click();
  await page.getByRole('button', { name: '工作区', exact: true }).click();
  await page.getByRole('textbox', { name: '工作区名称' }).fill('日常运维');
  await page.getByRole('button', { name: '保存当前' }).click();
  await page.getByRole('button', { name: /日常运维/ }).waitFor();
  await page.screenshot({ path: join(out, 'workspaces.png') });
  await page.setViewportSize({ width: 540, height: 720 });
  assert(await page.locator('.workspace-name-row').evaluate((row) => {
    const bounds = row.getBoundingClientRect();
    return [...row.children].every((child) => {
      const box = child.getBoundingClientRect();
      return box.right <= bounds.right + 1 && box.height <= 36;
    });
  }), 'Workspace name controls wrap or overflow');
  await page.screenshot({ path: join(out, 'workspaces-narrow.png') });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole('dialog', { name: '工作区' }).getByTitle('关闭', { exact: true }).click();
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.locator('.panel-head .icon-btn').last().click();
  await page.getByRole('button', { name: '批量修改服务器', exact: true }).click();
  await page.getByLabel('筛选服务器').fill('web-01');
  await page.getByLabel('选择筛选结果').check();
  await page.getByLabel('修改分组').check();
  await page.getByLabel('group', { exact: true }).fill('New group');
  await page.screenshot({ path: join(out, 'bulk.png') });
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByRole('dialog', { name: '批量修改服务器' }).waitFor({ state: 'hidden' });
  assert(await page.evaluate(async () => (await window.go.app.App.ListProfiles())[0].group === 'New group'));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByTitle('添加规则', { exact: true }).click();
  await page.getByLabel('匹配内容').fill('ERROR');
  await page.getByLabel('颜色', { exact: true }).fill('#ef4444');
  await page.getByLabel('匹配内容').scrollIntoViewIfNeeded();
  assert(await page.locator('.highlight-rule-row').evaluate((row) => {
    const bounds = row.closest('.settings-card').getBoundingClientRect();
    return [...row.querySelectorAll('input, select, button')].every((child) => {
      const box = child.getBoundingClientRect();
      return box.left >= bounds.left && box.right <= bounds.right;
    });
  }), 'Highlight controls are clipped by the sidebar');
  await page.screenshot({ path: join(out, 'settings.png') });
  const retention = page.getByLabel('自动清理历史会话日志（所有服务器）', { exact: true });
  assert.equal(await retention.isChecked(), false, 'Log retention must require an explicit opt-in');
  await retention.check();
  await page.getByLabel('保留天数', { exact: true }).fill('14');
  await page.getByLabel('日志总容量上限 (MB)', { exact: true }).fill('512');
  await page.setViewportSize({ width: 540, height: 720 });
  await retention.scrollIntoViewIfNeeded();
  assert(await retention.evaluate((input) => {
    const group = input.closest('.workbench-fields');
    return group.scrollWidth <= group.clientWidth + 1;
  }), 'Log retention settings overflow on a narrow screen');
  await page.screenshot({ path: join(out, 'log-retention-narrow.png'), animations: 'disabled' });
  await page.locator('.settings-save').click();
  assert.deepEqual(await page.evaluate(async () => (await window.go.app.App.GetSettings()).sessionLogRetention), { enabled: true, maxAgeDays: 14, maxTotalMb: 512 });
  await page.getByRole('button', { name: '导出加密备份', exact: true }).click();
  let backupDialog = page.getByRole('dialog', { name: '导出加密备份', exact: true });
  await backupDialog.getByLabel('备份口令', { exact: true }).fill('smoke passphrase');
  await backupDialog.getByLabel('确认口令', { exact: true }).fill('smoke passphrase');
  assert.equal(await backupDialog.locator('input[type="password"]').count(), 2);
  await page.setViewportSize({ width: 540, height: 720 });
  await page.screenshot({ path: join(out, 'backup-export-narrow.png'), animations: 'disabled' });
  await backupDialog.getByRole('button', { name: '导出备份', exact: true }).click();
  await backupDialog.waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(() => window.smokeBackups[0]), { action: 'export', includeSecrets: false, includePrivateKeys: false });
  await page.evaluate(() => { window.smokeExportWarnings = ['Deleted workspace server skipped: Daily / Old server', 'Empty workspace skipped: Obsolete']; });
  await page.getByRole('button', { name: '导出加密备份', exact: true }).click();
  backupDialog = page.getByRole('dialog', { name: '导出加密备份', exact: true });
  await backupDialog.getByLabel('备份口令', { exact: true }).fill('smoke passphrase');
  await backupDialog.getByLabel('确认口令', { exact: true }).fill('smoke passphrase');
  await backupDialog.getByRole('button', { name: '导出备份', exact: true }).click();
  await backupDialog.getByRole('status').filter({ hasText: '加密备份已导出' }).waitFor();
  await backupDialog.getByText('已跳过工作区中已删除的服务器：Daily / Old server', { exact: true }).waitFor();
  await backupDialog.getByText('已跳过空工作区：Obsolete', { exact: true }).waitFor();
  assert.equal(await backupDialog.locator('input[type="password"]').count(), 0);
  assert(await backupDialog.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1), 'Export omission summary overflows on a narrow screen');
  await page.screenshot({ path: join(out, 'backup-export-omissions.png'), animations: 'disabled' });
  await backupDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await backupDialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '导入加密备份', exact: true }).click();
  backupDialog = page.getByRole('dialog', { name: '导入加密备份', exact: true });
  await backupDialog.getByLabel('备份口令', { exact: true }).fill('smoke passphrase');
  await backupDialog.getByRole('button', { name: '选择文件并预览', exact: true }).click();
  await backupDialog.getByText('服务器 · Existing server', { exact: true }).waitFor();
  const aiChanges = backupDialog.getByRole('table', { name: 'AI 配置将发生变化' });
  await aiChanges.getByText('https://current-ai.invalid/v1', { exact: true }).waitFor();
  await aiChanges.getByText('https://very-long-imported-ai-host.invalid/compatibility/api/v1', { exact: true }).waitFor();
  for (const [width, height] of [[540, 720], [1440, 960]]) {
    await page.setViewportSize({ width, height });
    assert(await backupDialog.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1), `Backup preview overflows at ${width}px`);
    assert(await aiChanges.evaluate((table) => table.scrollWidth <= table.clientWidth + 1), `AI configuration comparison overflows at ${width}px`);
    await page.screenshot({ path: join(out, `backup-preview-${width}.png`), animations: 'disabled' });
  }
  assert.equal(await page.evaluate(() => window.smokeBackups.filter((item) => item.action === 'apply').length), 0);
  await backupDialog.getByRole('button', { name: '确认导入', exact: true }).click();
  await page.waitForFunction(() => typeof window.smokeFinishImport === 'function', null, { timeout: 30000 });
  await page.evaluate(() => window.smokeEmit('app:close-requested'));
  assert.equal(await page.evaluate(() => window.smokeQuit), false, 'App closed during backup import');
  await page.evaluate(() => window.smokeFinishImport());
  await backupDialog.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.smokeBackups.filter((item) => item.action === 'apply').length), 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', mode: production ? 'production' : 'development', screenshots: out, sidebarPerformance, workerFrames, viewports: ['1440x960', '900x700', '900x260', '540x720'], checks: ['four nonblank terminal panes', 'per-pane input routing', 'physical Backspace and Delete', 'per-server broadcast key mapping', 'document focus and shared sidebar geometry', '5001 sibling files paged with full-folder filtering and reveal', 'JSONC format/save preserves comments and numeric precision', '5 MB NDJSON worker formatting and save validation', 'preferred width after viewport changes', 'long-title search and complete names', 'IME-safe tab picker with keyboard navigation and short-window bounds', 'bounded terminal geometry changes on collapse', 'workspace persistence', 'atomic batch UI', 'highlight settings', 'opt-in log retention and saved limits', 'masked backup passphrases', 'localized export omission summary', 'AI configuration comparison before import', 'backup preview and explicit apply', 'close gate during import'] }));
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(JSON.stringify({ screenshots: out, errors }));
    await page.screenshot({ path: join(out, 'failure.png'), animations: 'disabled', timeout: 5000 }).catch(() => undefined);
  }
  throw error;
} finally {
  if (browser) await browser.close();
  if (production) {
    await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
  } else {
    await server.close();
  }
}
