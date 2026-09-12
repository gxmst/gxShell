// Real Mermaid + Chromium layout; all Wails APIs and files are isolated mocks.
/* global window, document */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = await readFile(join(root, 'src/test/fixtures/mermaid-workflows.md'), 'utf8');
const source = sample.split('```mermaid')[1].split('```')[0].trim().replace(/\r\n/g, '\n');
const out = await mkdtemp(join(tmpdir(), 'gxshell-markdown-'));
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
let browser;
let page;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  context.setDefaultTimeout(30000);
  context.setDefaultNavigationTimeout(30000);
  await context.addInitScript(({ sample }) => {
    const events = new Map();
    window.mdSmokeEmit = (name, data) => { for (const callback of events.get(name) || []) callback(data); };
    window.mdSmokeClipboard = '';
    const settings = {
      themeName: 'Light', language: 'zh-CN', highlightLevel: 'off', highlightRules: [], monitorEnabled: false, monitorIntervalSec: 5, connectionTimeout: 15,
      sidebarWidth: 290, sidebarSplitPct: 45, smartHighlight: true, restoreWorkspace: false, cliServerEnabled: false, updateCheckEnabled: false,
      ai: { provider: '', apiKey: '', endpoint: '', model: '' }, sessionLog: { enabled: false, timestamps: true, maxFileMb: 10, maxSessionMb: 100 },
      terminal: { fontFamily: 'Consolas, monospace', fontSize: 14, lineHeight: 1.25, cursorStyle: 'block', cursorBlink: true, themeName: 'Light', backgroundOpacity: 1, scrollbackLines: 5000 },
    };
    const files = {
      '/workflows.md': sample,
      '/errors.md': '# Errors\n\n```mermaid\nflowchart TD\n A[broken --> B\n```\n\n正文仍可阅读。\n\n```mermaid\nsequenceDiagram\n participant A as 用户\n participant B as 服务\n A->>B: 提问\n B-->>A: 回答\n```',
      '/wide.md': '# Wide diagram\n\n```mermaid\nflowchart LR\n A[开始] --> B[提取文本] --> C[分块] --> D[向量化] --> E[索引] --> F[检索] --> G[模型] --> H[检查引用] --> I[回答]\n```',
      '/other.md': '# Other\n\n普通文档内容。',
      ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`/note-${index}.md`, `# Note ${index}\n\n用于检查长文件列表的自动定位。`])),
      '/labels.md': '# Label variants\n\n```mermaid\nflowchart LR\n A["中文<br/>换行"] -->|证据| B["`**模型** 回答`"]\n```\n\n```mermaid\nstateDiagram-v2\n state "中文状态" as Ready\n [*] --> Ready\n Ready --> [*]\n```\n\n```mermaid\nclassDiagram\n class Document["文档"]\n class Answer["回答"]\n Document --> Answer : 引用\n```',
    };
    const app = {
      GetSettings: () => settings, UpdateSettings: (value) => Object.assign(settings, value), GetVersion: () => '1.7.0', GetStartupFile: () => '',
      ListProfiles: () => [], ListCommands: () => [], ListSessions: () => [], GetAppInfo: () => ({ dataDir: 'isolated-smoke-data' }),
      ReadLocalFile: (path) => files[path], ListTextFilesInDir: () => Object.keys(files), RestoreTextFiles: (paths) => paths,
      IsTextContextMenuRegistered: () => false, IsWindowMaximised: () => false,
    };
    window.go = { app: { App: new Proxy(app, { get: (target, key) => (...args) => Promise.resolve(target[key] ? target[key](...args) : /^List|^Read/.test(String(key)) ? [] : undefined) }) } };
    window.runtime = new Proxy({
      ClipboardSetText: (text) => { window.mdSmokeClipboard = text; return true; },
      EventsOnMultiple: (name, callback) => {
        const list = events.get(name) || new Set(); list.add(callback); events.set(name, list);
        if (name === 'file:open-external') window.mdSmokeReady = true;
        return () => list.delete(callback);
      },
    }, { get: (target, key) => target[key] || (() => undefined) });
  }, { sample });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.mdSmokeReady, null, { timeout: 30000 });
  const open = async (path) => {
    await page.evaluate((path) => window.mdSmokeEmit('file:open-external', path), path);
    await page.locator('.markdown-viewer[data-active="true"] .markdown-viewer-toolbar-name', { hasText: path.split('/').pop() }).waitFor();
  };
  const active = () => page.locator('.markdown-viewer[data-active="true"]');
  const drawing = () => active().locator('.md-diagram-svg > svg').first();
  const navigation = page.locator('.activity-rail');
  const setSidebarCollapsed = async (collapsed) => {
    const toggle = navigation.locator('button[aria-expanded]');
    if (await toggle.getAttribute('aria-expanded') === String(collapsed)) await toggle.click();
    await page.waitForFunction((collapsed) => document.querySelector('.app-shell').dataset.collapsed === String(collapsed), collapsed, { timeout: 30000 });
    await page.locator('.workspace').evaluate(async (node) => {
      await Promise.all(node.getAnimations().map((animation) => animation.finished));
    });
  };
  const assertNavigationVisible = async (scenario) => {
    const state = await navigation.evaluate((nav) => {
      const rail = nav.closest('.left-rail');
      const bounds = rail.getBoundingClientRect();
      return {
        scrollLeft: rail.scrollLeft,
        scrollTop: rail.scrollTop,
        buttons: [...nav.querySelectorAll('button')].map((button) => {
          const box = button.getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          return {
            name: button.getAttribute('aria-label'),
            reachable: box.width > 0 && box.height > 0
              && box.left >= bounds.left && box.right <= bounds.right
              && box.top >= bounds.top && box.bottom <= bounds.bottom
              && button.contains(document.elementFromPoint(x, y)),
          };
        }),
      };
    });
    assert(state.scrollLeft === 0 && state.scrollTop === 0 && state.buttons.length >= 6 && state.buttons.every((button) => button.reachable), `${scenario}: ${JSON.stringify(state)}`);
  };
  const assertCurrentFileVisible = async () => {
    await page.waitForFunction(() => {
      const list = document.querySelector('.text-file-section-current .text-file-list');
      const current = list?.querySelector('[aria-current="page"]');
      if (!current || !list.clientHeight) return false;
      const row = current.getBoundingClientRect();
      const bounds = list.getBoundingClientRect();
      return row.top >= bounds.top - 1 && row.bottom <= bounds.top + list.clientHeight + 1;
    }, null, { timeout: 30000 });
  };
  const labels = ['文档入库：资料新增或更新时', '选择授权资料', '提取和清理文本', '分块并保留来源', '建立检索索引', '在线问答：用户提问时', '用户问题', '在可见范围内检索', '挑选证据并控制长度', '问题与证据送入模型', '回答、引用、原文与运行记录'];
  await setSidebarCollapsed(true);
  await assertNavigationVisible('Collapsed sidebar before opening Markdown');
  await open('/workflows.md');
  await active().locator('.md-mermaid[data-md-rendered="true"]').waitFor({ timeout: 30000 });
  await assertNavigationVisible('Opening Markdown with the sidebar collapsed');
  await page.screenshot({ path: join(out, 'sidebar-collapsed-document.png'), animations: 'disabled' });
  await setSidebarCollapsed(false);
  await assertCurrentFileVisible();
  await open('/note-39.md');
  await assertCurrentFileVisible();
  assert(await page.locator('.text-file-section-current .text-file-list').evaluate((list) => list.scrollTop > 0), 'Current file at the end of a long folder is not revealed');
  await assertNavigationVisible('Revealing a document at the end of a long folder');
  await setSidebarCollapsed(true);
  await open('/workflows.md');
  await assertNavigationVisible('Switching documents with the sidebar collapsed');
  await setSidebarCollapsed(false);
  await assertCurrentFileVisible();
  for (const [theme, width, height] of [['Light', 1440, 960], ['Dark', 1440, 960], ['Light', 900, 700], ['Light', 540, 720]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate((theme) => document.querySelector('.app-shell').setAttribute('data-theme', theme), theme);
    await active().locator(`.md-diagram[data-theme-mode="${theme === 'Dark' ? 'dark' : 'default'}"] .md-diagram-svg > svg`).waitFor();
    await page.waitForTimeout(150);
    const text = await drawing().evaluate((svg) => svg.textContent.replace(/\s/g, ''));
    for (const label of labels) assert(text.includes(label), `${theme} ${width}px missing label: ${label}`);
    const textBoxes = await drawing().locator('text').evaluateAll((nodes) => nodes.filter((node) => node.textContent.trim()).map((node) => { const box = node.getBoundingClientRect(); return { text: node.textContent, width: box.width, height: box.height }; }));
    assert(textBoxes.length >= 11 && textBoxes.every((box) => box.width > 0 && box.height > 0), JSON.stringify(textBoxes));
    assert(await active().locator('.md-mermaid').evaluate((card) => card.scrollWidth <= card.clientWidth + 1), `Diagram card overflows at ${width}px`);
    assert(await active().locator('.markdown-viewer-toolbar').evaluate((bar) => bar.scrollWidth <= bar.clientWidth + 1), `Document toolbar overflows at ${width}px`);
    await page.screenshot({ path: join(out, `workflows-${theme}-${width}.png`), animations: 'disabled' });
    if (width === 540) {
      assert.equal(await active().locator('.markdown-viewer-outline').count(), 0, 'Narrow reading area starts covered by the outline');
      await active().getByTitle('大纲', { exact: true }).click();
      await active().locator('.markdown-viewer-outline').waitFor();
      await page.keyboard.press('Escape');
      await active().locator('.markdown-viewer-outline').waitFor({ state: 'hidden' });
    }
    await assertNavigationVisible(`${theme} ${width}px expanded sidebar`);
    await setSidebarCollapsed(true);
    await open('/note-39.md');
    await assertNavigationVisible(`${theme} ${width}px collapsed sidebar`);
    await open('/workflows.md');
    await setSidebarCollapsed(false);
    await assertCurrentFileVisible();
    await assertNavigationVisible(`${theme} ${width}px expanded after switching documents`);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  const firstId = await drawing().getAttribute('id');
  await active().getByRole('button', { name: '放大图表', exact: true }).click();
  assert.equal(await drawing().getAttribute('id'), firstId, 'Zoom rerendered Mermaid');
  await active().getByRole('button', { name: '复制图表源码', exact: true }).click();
  assert.equal((await page.evaluate(() => window.mdSmokeClipboard)).replace(/\r\n/g, '\n').trim(), source);
  await active().getByTitle('查看图表源码', { exact: true }).click();
  assert.equal((await active().getByLabel('图表源码', { exact: true }).textContent()).trim(), source);
  await active().getByTitle('查看图表源码', { exact: true }).click();
  await active().locator('.md-diagram-viewport').evaluate((node) => { node.scrollTop = 120; });
  const inlineHeight = await active().locator('.md-mermaid').evaluate((node) => node.clientHeight);
  await active().getByRole('button', { name: '展开图表', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Mermaid 图表 1', exact: true });
  await dialog.waitFor();
  assert.equal(await page.locator('.md-diagram-svg > svg').count(), 1, 'Expanded graph duplicates SVG IDs');
  assert((await dialog.boundingBox()).width > 1000, 'Diagram expansion is too narrow');
  assert.equal(await active().locator('.md-mermaid').evaluate((node) => node.clientHeight), inlineHeight, 'Opening a diagram changes the document height');
  await page.screenshot({ path: join(out, 'workflows-expanded.png'), animations: 'disabled' });
  await dialog.getByRole('region', { name: '图表，可滚动查看' }).focus();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('.markdown-viewer[data-active="true"] .md-diagram-viewport').scrollTop === 120, null, { timeout: 30000 });
  await active().getByRole('button', { name: '查找', exact: true }).click();
  await active().getByPlaceholder('查找').fill('检索');
  await active().locator('.markdown-search-count', { hasText: '1/2' }).waitFor();
  await active().getByPlaceholder('查找').press('Escape');
  const zoom = active().getByLabel('文档缩放', { exact: true });
  await zoom.fill('1.5');
  await active().getByRole('button', { name: '重置文档缩放' }).click();
  assert.equal(await zoom.inputValue(), '1');
  assert.equal(await active().locator('.md-document').evaluate((node) => node.style.zoom), '1');
  const cachedId = await drawing().getAttribute('id');
  await open('/other.md');
  await active().getByText('普通文档内容。', { exact: true }).waitFor();
  await open('/workflows.md');
  await active().locator('.md-mermaid[data-md-rendered="true"]').waitFor();
  assert.equal(await drawing().getAttribute('id'), cachedId, 'Tab reactivation rerenders the same diagram');

  await open('/wide.md');
  await active().locator('.md-mermaid[data-md-rendered="true"]').waitFor();
  await active().getByTitle('原始大小（100%）').click();
  assert(await active().locator('.md-diagram-viewport').evaluate((node) => node.scrollWidth > node.clientWidth), 'Wide diagram cannot scroll at 100%');
  await active().getByRole('button', { name: '适应宽度' }).click();
  await page.waitForTimeout(100);
  assert(await active().locator('.md-diagram-viewport').evaluate((node) => node.scrollWidth <= node.clientWidth + 1), 'Fit width still overflows');
  await page.screenshot({ path: join(out, 'wide-fit.png'), animations: 'disabled' });

  await open('/errors.md');
  await active().getByText('图表解析失败', { exact: true }).waitFor();
  await active().locator('.md-mermaid[data-md-rendered="true"]').waitFor();
  await active().getByText('正文仍可阅读。', { exact: true }).waitFor();
  assert.equal(await page.locator('.md-mermaid-measure').count(), 0, 'Render container leaked');
  assert((await active().locator('.md-diagram-source').textContent()).includes('A[broken --> B'));
  await active().getByRole('button', { name: '重试', exact: true }).click();
  await active().getByText('图表解析失败', { exact: true }).waitFor();
  await page.screenshot({ path: join(out, 'parse-error.png'), animations: 'disabled' });
  await open('/labels.md');
  await page.waitForFunction(() => document.querySelectorAll('.markdown-viewer[data-active="true"] .md-mermaid[data-md-rendered="true"]').length === 3, null, { timeout: 30000 });
  const variantText = (await active().locator('.md-diagram-svg').allTextContents()).join('').replace(/\s/g, '');
  for (const label of ['中文', '换行', '模型', '回答', '中文状态', '文档', '引用']) assert(variantText.includes(label), `Missing variant label: ${label}`);
  await page.screenshot({ path: join(out, 'label-variants.png'), animations: 'disabled' });
  await setSidebarCollapsed(true);
  await page.reload();
  await page.waitForFunction(() => window.mdSmokeReady, null, { timeout: 30000 });
  await open('/workflows.md');
  await active().locator('.md-mermaid[data-md-rendered="true"]').waitFor({ timeout: 30000 });
  await assertNavigationVisible('Restored collapsed sidebar');
  await navigation.getByRole('button', { name: '文档', exact: true }).click();
  await setSidebarCollapsed(false);
  await assertCurrentFileVisible();
  await navigation.getByRole('button', { name: '连接', exact: true }).click();
  await page.locator('.side-content[data-section="connections"]').waitFor();
  await navigation.getByRole('button', { name: '文档', exact: true }).click();
  await assertCurrentFileVisible();
  await assertNavigationVisible('Navigating between connections and documents');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', screenshots: out, checks: ['11 Chinese flowchart labels', 'light and dark themes', '1440/900/540px reading', 'navigation remains reachable when opening/switching documents with a collapsed sidebar', 'long-folder current-file reveal after expansion', 'restored sidebar and navigation between sections', 'compact outline and Escape', 'independent diagram zoom', 'copy source', 'expanded dialog and scroll restoration', 'document search and zoom reset', 'cached diagrams across tab switches', 'wide diagram scrolling and fit', 'parse-error source and retry', 'sequence/state/class diagrams and multiline labels', 'render container cleanup'] }));
} catch (error) {
  if (page) await page.screenshot({ path: join(out, 'failure.png'), animations: 'disabled' }).catch(() => undefined);
  console.error(JSON.stringify({ status: 'failed', screenshots: out }));
  throw error;
} finally {
  if (browser) await browser.close();
  await server.close();
}
