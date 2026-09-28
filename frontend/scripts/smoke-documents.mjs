// Isolated browser checks for adaptive document browsing. Wails file I/O is
// mocked; no desktop session, remote server or user files are touched.
// Requires Playwright on NODE_PATH. Pass --preview to test a production build.
/* global window, document */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, preview } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = await mkdtemp(join(tmpdir(), 'gxshell-documents-'));
const production = process.argv.includes('--preview');
const server = production
  ? await preview({ root, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  : await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
if (!production) await server.listen();
let browser;
let page;
const errors = [];
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  context.setDefaultTimeout(20000);
  await context.addInitScript(() => {
    const events = new Map();
    const paragraph = '这份说明介绍日常工作中的文件浏览方法。打开文件以后，可以自然地阅读正文，查看日志中的错误信息，也可以检查代码和配置。不同内容采用合适的排版，同时完整保留原文的空格和换行。';
    const files = {
      '/guide.txt': Array.from({ length: 80 }, (_, index) => '第' + (index + 1) + '节 使用说明\n\n'
        + Array.from({ length: 18 }, (_, part) => '段落 ' + (index + 1) + '.' + part + '：' + paragraph.repeat(3)).join('\n\n')).join('\n\n'),
      '/readme.md': '# 工作说明\n\n' + Array.from({ length: 70 }, (_, index) => '## 步骤 ' + (index + 1) + '\n\n' + paragraph.repeat(3)).join('\n\n'),
      '/runtime.txt': '2026-09-15 10:00:00 INFO Worker started\n2026-09-15 10:00:01 WARN Connection slow\n2026-09-15 10:00:02 ERROR Retry scheduled\n',
      '/worker.py': '# Worker configuration\nfrom pathlib import Path\n\ncount = 42\nprint("ready", count)\n',
      '/settings.jsonc': '// deployment configuration\r\n{\r\n  "id": 9007199254740993,\r\n  "enabled": true,\r\n}\r\n',
      '/report.tsv': '名称\t数量\t状态\n服务一\t12\t正常\n服务二\t8\t待检查\n',
      '/index.html': '<script>window.documentSmokeUnsafe = true</script><h1>HTML source</h1>',
    };
    window.documentSmokeFiles = files;
    window.documentSmokeWrites = [];
    window.documentSmokeEmit = (name, value) => { for (const callback of events.get(name) || []) callback(value); };
    const settings = {
      themeName: 'Light', language: 'zh-CN', highlightLevel: 'off', highlightRules: [], monitorEnabled: false, monitorIntervalSec: 5, connectionTimeout: 15,
      sidebarWidth: 290, sidebarSplitPct: 45, smartHighlight: true, restoreWorkspace: false, cliServerEnabled: false, updateCheckEnabled: false,
      ai: { provider: '', apiKey: '', endpoint: '', model: '' }, sessionLog: { enabled: false, timestamps: true, maxFileMb: 10, maxSessionMb: 100 },
      terminal: { fontFamily: 'Consolas, monospace', fontSize: 14, lineHeight: 1.25, cursorStyle: 'block', cursorBlink: true, themeName: 'Light', backgroundOpacity: 1, scrollbackLines: 5000 },
    };
    const app = {
      GetSettings: () => settings, UpdateSettings: (value) => Object.assign(settings, value), GetVersion: () => '1.8.0', GetStartupFile: () => '',
      ListProfiles: () => [], ListCommands: () => [], ListSessions: () => [], GetAppInfo: () => ({ dataDir: 'isolated-smoke-data' }),
      ReadLocalFile: (path) => ({ content: files[path], version: 'smoke-version' }), ListTextFilesInDir: () => Object.keys(files), RestoreTextFiles: (paths) => paths,
      WriteLocalFile: (path, content) => { files[path] = content; window.documentSmokeWrites.push({ path, content }); return { version: 'smoke-saved', conflict: false }; },
      IsTextContextMenuRegistered: () => false, IsWindowMaximised: () => false,
    };
    window.go = { app: { App: new Proxy(app, { get: (target, key) => (...args) => Promise.resolve(target[key] ? target[key](...args) : /^List|^Read/.test(String(key)) ? [] : undefined) }) } };
    window.runtime = new Proxy({
      EventsOnMultiple: (name, callback) => {
        const list = events.get(name) || new Set();
        list.add(callback); events.set(name, list);
        if (name === 'file:open-external') window.documentSmokeReady = true;
        return () => list.delete(callback);
      },
    }, { get: (target, key) => target[key] || (() => undefined) });
  });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.documentSmokeReady);
  const active = () => page.locator('.markdown-viewer[data-active="true"]');
  const source = () => active().locator('.cm-content');
  const open = async (path) => {
    await page.evaluate((path) => window.documentSmokeEmit('file:open-external', path), path);
    await page.waitForFunction((path) => document.querySelector('.markdown-viewer[data-active="true"]')?.getAttribute('data-document-path') === path, path);
    await active().locator('.cm-content, .md-document').waitFor();
  };
  const frames = async () => page.evaluate(() => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
  const topLine = async () => active().locator('.cm-scroller').evaluate((scroller) => {
    const top = scroller.getBoundingClientRect().top;
    const line = [...scroller.querySelectorAll('.cm-line')].find((line) => line.getBoundingClientRect().bottom > top + 2);
    return { text: line?.textContent || '', y: line ? line.getBoundingClientRect().top - top : 0, scroll: scroller.scrollTop };
  });
  const copyAll = async () => {
    await source().focus();
    await page.keyboard.press('Control+a');
    return source().evaluate((node) => {
      const clipboardData = new window.DataTransfer();
      node.dispatchEvent(new window.ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }));
      const text = clipboardData.getData('text/plain').replace(/\r\n/g, '\n');
      const path = document.querySelector('.markdown-viewer[data-active="true"]').getAttribute('data-document-path');
      return { length: text.length, matches: text === window.documentSmokeFiles[path].replace(/\r\n/g, '\n') };
    });
  };

  await open('/guide.txt');
  assert.equal(await active().getAttribute('data-presentation'), 'prose');
  assert.equal(await source().getAttribute('aria-readonly'), 'true');
  assert.equal(await active().locator('.cm-gutters').count(), 0);
  assert(await active().locator('.cm-line').count() < 250, 'Prose preview mounted every line');
  assert.equal(await active().locator('.markdown-viewer-outline').count(), 0, 'Outline duplicated the document sidebar');
  await frames();
  const surfaces = await active().evaluate((viewer) => [viewer, viewer.querySelector('.cm-editor'), viewer.querySelector('.markdown-viewer-toolbar'), viewer.closest('.terminal-stage')].map((node) => window.getComputedStyle(node).backgroundColor));
  assert.equal(new Set(surfaces).size, 1, 'Document surfaces use conflicting background colors');
  assert.equal(await active().evaluate((viewer) => window.getComputedStyle(viewer).padding), '0px', 'Document inherited the terminal inset frame');
  await page.screenshot({ path: join(out, 'document-text-light.png'), animations: 'disabled' });
  const filesToggle = page.locator('.document-files .document-section-toggle');
  await filesToggle.click();
  assert.equal(await filesToggle.getAttribute('aria-expanded'), 'false');
  await page.getByRole('button', { name: '定位当前文档', exact: true }).click();
  assert.equal(await filesToggle.getAttribute('aria-expanded'), 'true', 'Reveal left the file list folded');
  await page.locator('.text-file-row[aria-current="page"]', { hasText: 'guide.txt' }).waitFor();
  await page.locator('.document-panel-heading', { hasText: '第25节 使用说明' }).click();
  await active().locator('.document-prose-heading', { hasText: '第25节 使用说明' }).waitFor();
  await frames();
  const beforeZoom = await topLine();
  await active().getByRole('button', { name: '排版', exact: true }).click();
  await active().getByLabel('文档缩放', { exact: true }).fill('1.3');
  await active().getByLabel('行距', { exact: true }).selectOption('2.1');
  await frames();
  const afterZoom = await topLine();
  assert.equal(afterZoom.text, beforeZoom.text, 'Typography lost the current paragraph');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1080, height: 800 });
  await frames();
  assert.equal((await topLine()).text, beforeZoom.text, 'Window resizing lost the current paragraph');
  // A real scroll records a position, then closing/reopening verifies storage.
  await active().locator('.cm-scroller').evaluate((node) => { node.scrollTop += 100; });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gx:documentReadingPositions') || '[]').some(([key, position]) => key.includes('/guide.txt') && position.anchor > 0));
  const beforeReopen = await topLine();
  await page.getByRole('button', { name: '关闭 guide.txt', exact: true }).click();
  await page.locator('.markdown-viewer[data-document-path="/guide.txt"]').waitFor({ state: 'detached' });
  await open('/guide.txt');
  await page.waitForFunction(() => document.querySelector('.markdown-viewer[data-active="true"] .cm-scroller')?.scrollTop > 1000);
  await frames();
  assert.equal((await topLine()).text, beforeReopen.text, 'Reopening lost the saved paragraph');
  const section = /^(?:段落\s+|第)(\d+)/.exec(beforeReopen.text)?.[1];
  if (section) await page.locator('.document-panel-heading[aria-current="location"]', { hasText: '第' + section + '节' }).waitFor();
  await page.waitForFunction(() => {
    const row = document.querySelector('.document-panel-heading[aria-current="location"]');
    if (!row) return false;
    const bounds = row.getBoundingClientRect();
    const list = row.closest('nav').getBoundingClientRect();
    return bounds.top >= list.top && bounds.bottom <= list.bottom + 1;
  });
  await page.screenshot({ path: join(out, 'prose-continuity.png'), animations: 'disabled' });

  for (const [path, kind] of [['/runtime.txt', 'log'], ['/worker.py', 'code'], ['/settings.jsonc', 'data'], ['/report.tsv', 'table'], ['/index.html', 'code']]) {
    await open(path);
    await active().getByRole('button', { name: '排版', exact: true }).click();
    await active().getByRole('button', { name: '重置文档缩放', exact: true }).click();
    await page.keyboard.press('Escape');
    assert.equal(await active().getAttribute('data-presentation'), kind);
    assert.equal((await copyAll()).matches, true, path + ' changed whitespace or omitted source while copying');
    assert.equal(await source().getAttribute('contenteditable'), 'false');
    if (kind === 'log') await active().locator('.document-log-error').waitFor();
    if (path === '/worker.py') await page.waitForFunction(() => document.querySelectorAll('.markdown-viewer[data-active="true"] .cm-line span').length > 3);
    if (kind === 'table') await active().locator('.document-table-header').waitFor();
    if (path === '/index.html') assert.equal(await page.evaluate(() => window.documentSmokeUnsafe), undefined);
    await page.screenshot({ path: join(out, kind + '.png'), animations: 'disabled' });
  }
  assert.equal(await page.evaluate(() => window.documentSmokeWrites.length), 0, 'Browsing wrote to a file');

  await open('/settings.jsonc');
  await active().getByTitle('编辑', { exact: true }).click();
  await active().locator('.cm-content[contenteditable="true"]').waitFor();
  await source().focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('// checked\n');
  await active().getByTitle('保存 (Ctrl+S)', { exact: true }).click();
  await page.waitForFunction(() => window.documentSmokeWrites.length === 1);
  const saved = await page.evaluate(() => window.documentSmokeWrites[0].content);
  assert(saved.includes('9007199254740993') && saved.includes('// checked\r\n') && saved.includes('// deployment configuration\r\n'), 'Editing lost comments, numeric precision or CRLF');

  await page.evaluate(() => {
    const size = 20 * 1024 * 1024;
    const line = '2026-09-15 10:00:00 INFO background worker heartbeat completed successfully\n';
    const tail = '2026-09-15 10:00:01 ERROR END-LARGE-DOCUMENT\n';
    const count = Math.floor((size - tail.length) / line.length);
    window.documentSmokeFiles['/large.log'] = line.repeat(count) + ' '.repeat(size - line.length * count - tail.length) + tail;
  });
  const largeStart = Date.now();
  await open('/large.log');
  assert(await source().locator('.cm-line').count() < 250, '20 MiB preview mounted every line');
  await active().getByRole('button', { name: '查找', exact: true }).click();
  const search = active().getByPlaceholder('查找', { exact: true });
  await search.fill('END-LARGE-DOCUMENT');
  await active().locator('.markdown-search-count', { hasText: '1/1' }).waitFor();
  await source().locator('.cm-line', { hasText: 'END-LARGE-DOCUMENT' }).waitFor();
  assert(await search.evaluate((node) => document.activeElement === node), 'Find stole input focus');
  await search.press('Escape');
  assert.deepEqual(await copyAll(), { length: 20 * 1024 * 1024, matches: true }, '20 MiB copy omitted offscreen text');
  await page.screenshot({ path: join(out, 'large-log.png'), animations: 'disabled' });
  const largeMilliseconds = Date.now() - largeStart;
  await page.getByRole('button', { name: '关闭 large.log', exact: true }).click();

  await page.evaluate(() => {
    window.documentSmokeFiles['/large.md'] = '# Start\n\n' + 'Document paragraph.\n'.repeat(100000) + '\n## End\n';
  });
  await open('/large.md');
  await active().getByText('大文档 · 简化排版', { exact: true }).waitFor();
  assert.equal(await active().locator('.md-document').count(), 0);
  await page.locator('.document-panel-heading', { hasText: 'End' }).click();
  await source().locator('.cm-line', { hasText: '## End' }).waitFor();
  await page.getByRole('button', { name: '关闭 large.md', exact: true }).click();

  await open('/readme.md');
  await active().locator('.md-document h1').waitFor();
  await page.locator('.document-panel-heading', { hasText: /^步骤 40$/ }).click();
  await page.waitForFunction(() => {
    const scroller = document.querySelector('.markdown-viewer[data-active="true"] .markdown-viewer-content');
    const heading = [...scroller.querySelectorAll('h2')].find((node) => node.textContent.includes('步骤 40'));
    const offset = heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    return offset >= 0 && offset < 100;
  });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gx:documentReadingPositions') || '[]').some(([key, position]) => key.includes('/readme.md') && position.anchor > 0));
  await page.getByRole('button', { name: '关闭 readme.md', exact: true }).click();
  await page.locator('.markdown-viewer[data-document-path="/readme.md"]').waitFor({ state: 'detached' });
  await open('/readme.md');
  await page.waitForFunction(() => document.querySelector('.markdown-viewer[data-active="true"] .markdown-viewer-content')?.scrollTop > 1000);
  await page.locator('.document-panel-heading', { hasText: /^工作说明$/ }).click();
  for (const [theme, width, height] of [['Light', 1440, 960], ['Dark', 900, 700], ['Light', 540, 720], ['Light', 900, 300]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate((theme) => document.querySelector('.app-shell').setAttribute('data-theme', theme), theme);
    await frames();
    assert(await active().locator('.markdown-viewer-toolbar').evaluate((node) => node.scrollWidth <= node.clientWidth + 1), 'Toolbar overflow at ' + width);
    await active().getByRole('button', { name: '排版', exact: true }).click();
    const popover = active().getByRole('dialog', { name: '排版', exact: true });
    assert(await popover.evaluate((node) => { const bounds = node.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= window.innerWidth && bounds.bottom <= window.innerHeight; }), 'Typography panel outside viewport at ' + width + 'x' + height);
    await page.screenshot({ path: join(out, 'markdown-' + theme + '-' + width + 'x' + height + '.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', mode: production ? 'production' : 'development', screenshots: out, largeMilliseconds, checks: ['all text presentations', 'consistent document backgrounds without inset frames', 'prose paragraph continuity across typography, resizing and reopening', 'Markdown reopening', 'one sidebar outline', 'source copy preserves whitespace', 'HTML source is inert', 'JSONC edit preserves comments, precision and CRLF', '20 MiB virtual preview, tail search and complete copy', 'large Markdown fallback and navigation', 'light/dark, narrow and short-window typography'] }));
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(out, 'failure.png'), animations: 'disabled' }).catch(() => {});
    console.error('Failure screenshot: ' + join(out, 'failure.png'));
    console.error('Browser errors: ' + JSON.stringify(errors));
    console.error('Reading state: ' + JSON.stringify(await page.evaluate(() => ({ positions: JSON.parse(localStorage.getItem('gx:documentReadingPositions') || '[]'), scroll: document.querySelector('.markdown-viewer[data-active="true"] .cm-scroller')?.scrollTop }))));
  }
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
