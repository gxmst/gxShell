// Requires Playwright on Node's module path. Uses isolated mocked Wails APIs;
// no running desktop app, server credentials or application data are touched.
/* global window, document */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const sharp = require('sharp');
const out = await mkdtemp(join(tmpdir(), 'gxshell-workbench-'));
const server = await createServer({ root: join(dirname(fileURLToPath(import.meta.url)), '..'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true, args: ['--enable-webgl', '--use-angle=swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(() => {
    const events = new Map();
    window.smokeEmit = (name, data) => { for (const callback of events.get(name) || []) callback(data); };
    window.smokeWrites = [];
    let settings = {
      themeName: 'Light', language: 'zh-CN', highlightLevel: 'basic', highlightRules: [], monitorEnabled: false, monitorIntervalSec: 5, connectionTimeout: 15,
      sidebarWidth: 290, sidebarSplitPct: 45, smartHighlight: true, restoreWorkspace: false, cliServerEnabled: false, updateCheckEnabled: false,
      ai: { provider: '', apiKey: '', endpoint: '', model: '' }, sessionLog: { enabled: false, timestamps: true, maxFileMb: 10, maxSessionMb: 100 },
      terminal: { fontFamily: 'Consolas, monospace', fontSize: 14, lineHeight: 1.25, cursorStyle: 'block', cursorBlink: true, themeName: 'Light', backgroundOpacity: 1, scrollbackLines: 5000 },
    };
    let profiles = ['web-01', 'api-01', 'db-01', 'backup-01'].map((id, index) => ({ id, name: id, group: index < 2 ? 'Production' : 'Infrastructure', host: `${id}.test`, port: 22, username: 'ops', authType: 'agent', rememberPassword: false, favorite: false, tags: [], tunnels: [], cliEnabled: false, autoReconnect: false, description: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...(index === 2 ? { terminal: { ...settings.terminal, themeName: 'Dark', fontSize: 18 } } : {}) }));
    let sessions = profiles.map((p) => ({ id: `session-${p.id}`, profileId: p.id, runtimeId: `profile:${p.id}`, generation: 1, name: p.name, state: 'connected', cols: 80, rows: 24 }));
    const app = {
      GetSettings: () => settings, UpdateSettings: (value) => { settings = value; return value; }, GetVersion: () => '1.6.3', GetStartupFile: () => '',
      ListProfiles: () => profiles, ListCommands: () => [], ListSessions: () => sessions, GetAppInfo: () => ({ dataDir: 'isolated-smoke-data' }),
      ListLogFiles: () => [], ListSessionLogFiles: () => [{ name: '2026-09-08-web-01.log', size: 1234, modTime: new Date().toISOString() }], ReadSessionLogFile: () => '[2026-09-08] session log entry',
      ListRemoteDir: () => [], ListTextFilesInDir: () => ['/notes.md'], ReadLocalFile: () => '# Notes\n\n中文说明\n\n```sh\necho ready\n```', RestoreTextFiles: (paths) => paths,
      WriteToTerminal: (id, data) => { window.smokeWrites.push({ id, data }); },
      UpdateProfilesBatch: (ids, patch) => { profiles = profiles.map((p) => ids.includes(p.id) ? { ...p, ...patch } : p); return profiles; },
      Disconnect: (id) => { sessions = sessions.filter((s) => s.id !== id); },
      IsRecording: () => false, IsTextContextMenuRegistered: () => false, IsWindowMaximised: () => false,
    };
    window.go = { app: { App: new Proxy(app, { get: (target, key) => (...args) => Promise.resolve(target[key] ? target[key](...args) : /^List|^Read/.test(String(key)) ? [] : undefined) }) } };
    window.runtime = new Proxy({ EventsOnMultiple: (name, callback) => { const list = events.get(name) || new Set(); list.add(callback); events.set(name, list); return () => list.delete(callback); } }, { get: (target, key) => target[key] || (() => undefined) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error' && /Maximum update|Cannot update|ErrorBoundary/.test(message.text())) errors.push(message.text()); });
  await page.goto(server.resolvedUrls.local[0]);
  await page.locator('.xterm').first().waitFor();
  await page.locator('.tab-tools-toggle').click();
  await page.getByRole('menuitem', { name: '四分屏' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.terminal-split-pane .xterm').length === 4);
  const emit = () => page.evaluate(() => {
    for (const id of ['web-01', 'api-01', 'db-01', 'backup-01']) window.smokeEmit('terminal:data', { sessionId: `session-${id}`, data: `${id} ready\r\n中文终端输出\r\nERROR test\r\n$ ` });
  });
  await emit();
  await page.waitForTimeout(250);
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
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('[data-tab-id="session-db-01"] .xterm-helper-textarea').focus();
  await page.waitForTimeout(200);
  await page.keyboard.type('pwd');
  await page.waitForFunction(() => window.smokeWrites.length > 0, undefined, { timeout: 5000 });
  assert(await page.evaluate(() => window.smokeWrites.filter((write) => write.id === 'session-db-01').map((write) => write.data).join('').includes('pwd')), JSON.stringify(await page.evaluate(() => window.smokeWrites)));
  const sidebarWidth = await page.locator('.left-rail').evaluate((n) => n.getBoundingClientRect().width);
  await page.evaluate(() => window.smokeEmit('file:open-external', '/notes.md'));
  await page.getByRole('heading', { name: /^#?\s*Notes$/ }).waitFor();
  assert.equal(await page.locator('.left-rail').evaluate((n) => n.getBoundingClientRect().width), sidebarWidth);
  await page.screenshot({ path: join(out, 'document.png') });
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
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', screenshots: out, viewports: ['1440x960', '900x700', '540x720'], checks: ['four nonblank terminal panes', 'per-pane input routing', 'document focus and sidebar width', 'workspace persistence', 'atomic batch UI', 'highlight settings'] }));
} finally {
  if (browser) await browser.close();
  await server.close();
}
