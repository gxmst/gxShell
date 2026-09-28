// Real frontend components, fictional data, fresh browser storage, no desktop API.
// Requires playwright and sharp on NODE_PATH, and ffmpeg on PATH for the video.
/* global window, document */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'vite';
import { installMarketingFixture } from './marketing-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const sharp = require('sharp');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const out = outArg >= 0 ? resolve(process.argv[outArg + 1]) : resolve(root, '../docs/marketing/assets');
const draft = process.argv.includes('--stills-only');
const scratch = await mkdtemp(join(tmpdir(), 'gxshell-marketing-'));
await mkdir(join(out, 'screenshots'), { recursive: true });
// Tailwind resolves its config relative to cwd, including inside Vite's API.
process.chdir(root);
const errors = [], network = [], captions = [];
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' });
await server.listen();
const origin = server.resolvedUrls.local[0];
let browser, page, context;
const scenes = [
  ['01-workspace', 'Your servers. One workspace.', 'SSH terminals, SFTP, monitoring and documents — together.'],
  ['02-documents', 'Keep your files in the workflow.', 'Browse remote files. Read runbooks. Edit deployment configs.'],
  ['03-agent-review', 'Agent requests. Your approval.', 'Review commands and approve only the operations you choose.'],
];
const shell = `<!doctype html><html lang="en"><meta charset="utf-8"><title>gxShell demo studio</title>
<style>
*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#0a101b;color:#eff5ff;font-family:Arial,sans-serif}
body{background:radial-gradient(ellipse at 80% 20%,#142c3a 0,transparent 55%),radial-gradient(ellipse at 15% 90%,#16233d 0,transparent 55%),#0a101b}
header{position:absolute;left:64px;top:29px;right:64px;display:flex;align-items:center;justify-content:space-between}
.brand{font-size:25px;font-weight:700;letter-spacing:-.6px;display:flex;gap:12px;align-items:center}.brand img{width:33px;height:33px;border-radius:7px}
.meta{font-size:15px;color:#aebed1;letter-spacing:1.3px}.dot{color:#72e3be;padding:0 12px}
h1{position:absolute;top:67px;left:64px;margin:0;font-size:46px;letter-spacing:-1.6px;line-height:1.15;font-weight:700}
.subtitle{position:absolute;top:128px;left:66px;font-size:20px;color:#aebed1;margin:0}
.frame{position:absolute;left:64px;top:177px;width:1792px;height:840px;border:1px solid #314056;border-radius:12px;overflow:hidden;box-shadow:0 24px 70px #0006;background:#10151e}
iframe{width:1440px;height:675px;border:0;transform:scale(1.2444444444);transform-origin:0 0;background:#151922}
footer{position:absolute;left:66px;right:66px;bottom:22px;display:flex;justify-content:space-between;color:#aebed1;font-size:15px;letter-spacing:.2px}
.repo{color:#b1e9dc;font-weight:600}.demo{color:#a6b3c5}.end{position:absolute;inset:0;z-index:5;background:radial-gradient(ellipse at 80% 20%,#173e44,transparent 62%),#0a101b;display:none;padding:160px 130px}
.end .eyebrow{font-size:22px;color:#78dfc0;letter-spacing:4px}.end h2{font-size:92px;letter-spacing:-4px;line-height:1.1;margin:42px 0 30px}.end p{font-size:33px;line-height:1.6;color:#b8c9db}.end .url{display:inline-block;margin-top:40px;font-size:35px;color:#8ce6cb;border-bottom:2px solid #365d57;padding-bottom:15px}
.end small{display:block;margin-top:66px;color:#93a7bc;font-size:20px}
</style><header><div class="brand"><img alt="">gxShell</div><div class="meta">OPEN SOURCE<span class="dot">•</span>WINDOWS<span class="dot">•</span>v1.8.0</div></header>
<h1 id="headline"></h1><p class="subtitle" id="subtitle"></p><div class="frame"><iframe src="${origin}"></iframe></div>
<footer><span class="repo">github.com/gxmst/gxShell</span><span class="demo">Real interface · Fictional demo data</span><span>AGPL-3.0 · Made for your daily server work</span></footer>
<div class="end" id="end"><div class="eyebrow">GXSHELL / OPEN SOURCE</div><h2>Your next server workspace.<br>Built in the open.</h2><p>Try it. Share feedback.<br>If it helps you, give it a star on GitHub.</p><div class="url">github.com/gxmst/gxShell</div><small>Windows x64 · AGPL-3.0 · Demo uses fictional data</small></div></html>`;

try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true,
    args: ['--enable-webgl', '--use-angle=swiftshader'] });
  context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1,
    locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block',
    ...(!draft ? { recordVideo: { dir: scratch, size: { width: 1920, height: 1080 } } } : {}),
  });
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || /^(data|blob):/.test(url)) return route.continue();
    network.push(url); return route.abort();
  });
  await context.addInitScript(installMarketingFixture);
  const openedAt = Date.now();
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setContent(shell);
  const frame = page.frames().find((f) => f.url().startsWith(origin)) || await new Promise((done) => page.once('framenavigated', done));
  await frame.locator('.xterm').first().waitFor();
  await frame.evaluate(() => document.fonts.ready);
  const brand = 'data:image/png;base64,' + (await readFile(resolve(root, '../build/appicon.png'))).toString('base64');
  await page.locator('.brand img').evaluate((img, src) => { img.src = src; img.style.display = ''; }, brand);
  const hold = async (ms) => page.waitForTimeout(draft ? 180 : ms);
  let startOffset = 0, timelineStart = 0;
  const scene = async (index) => {
    await page.evaluate(({ title, subtitle }) => {
      document.querySelector('#headline').textContent = title;
      document.querySelector('#subtitle').textContent = subtitle;
    }, { title: scenes[index][1], subtitle: scenes[index][2] });
    if (!timelineStart) { startOffset = (Date.now() - openedAt) / 1000; timelineStart = Date.now(); }
    captions.push({ seconds: (Date.now() - timelineStart) / 1000, text: scenes[index][1] + ' ' + scenes[index][2] });
  };
  const save = async (index) => {
    await page.mouse.move(1900, 1060);
    await page.screenshot({ path: join(out, scenes[index][0] + '.png'), animations: 'disabled' });
    await rawScreenshot(scenes[index][0]);
    const text = await frame.locator('body').innerText();
    assert(!/[\u3400-\u9fff]/.test(text), 'Non-English text in the visible demo UI');
    assert(!/C:\\Users\\|F:\\diff\\|PRIVATE KEY|BEGIN RSA|Bearer\s+[A-Za-z0-9]/i.test(text), 'Unexpected private data pattern');
  };
  // Element screenshots can temporarily resize Chromium's capture surface and
  // put gray padding in a simultaneous video. Crop the already captured image.
  const rawScreenshot = async (name) => sharp(join(out, name + '.png'))
    .extract({ left: 65, top: 178, width: 1790, height: 838 })
    .png().toFile(join(out, 'screenshots', name + '.png'));

  await frame.locator('.tab-tools-toggle').click();
  console.log('layout menu:', await frame.getByRole('menu').innerText());
  await frame.getByRole('menuitem', { name: /Four|4-pane|Quad/i }).click();
  await frame.waitForFunction(() => document.querySelectorAll('.terminal-split-pane .xterm').length === 4);
  await frame.evaluate(() => window.marketingDemo.seedTerminals());
  await hold(500);
  await scene(0);
  await save(0);
  await hold(5000);
  await frame.locator('[data-tab-id="session-web-01"] .xterm-helper-textarea').focus();
  await page.keyboard.type('docker compose ps', { delay: draft ? 0 : 75 });
  await page.keyboard.press('Enter');
  await hold(2800);

  // The file is opened by the actual SFTP file-row interaction.
  await frame.locator('.tab-tools-toggle').click();
  console.log('layout menu:', await frame.getByRole('menu').innerText());
  await frame.getByRole('menuitem', { name: 'Four panes', exact: true }).click();
  await frame.getByRole('button', { name: 'Files', exact: true }).click();
  await frame.locator('.sftp-file-row').first().waitFor();
  await frame.getByPlaceholder('Path — type or pick a folder').fill('/srv/demo');
  await frame.getByPlaceholder('Path — type or pick a folder').press('Enter');
  await frame.getByPlaceholder('Path — type or pick a folder').blur();
  await scene(1);
  await hold(1700);
  await page.mouse.move(1900, 1060);
  await page.screenshot({ path: join(out, '02-files.png'), animations: 'disabled' });
  await rawScreenshot('02-files');
  await frame.locator('.sftp-file-row').filter({ hasText: 'README.md' }).dblclick();
  await frame.locator('.markdown-viewer[data-active="true"]').waitFor();
  await frame.locator('.markdown-viewer[data-active="true"] h1').filter({ hasText: 'Orbit demo stack' }).waitFor();
  await hold(700);
  await save(1);
  await hold(3800);
  console.log('document controls:', await frame.locator('.markdown-viewer-toolbar').innerText());
  await frame.locator('.text-file-row').filter({ hasText: 'compose.yaml' }).click();
  const editor = frame.locator('.markdown-viewer[data-active="true"]');
  await editor.locator('.cm-content').waitFor();
  await editor.getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(await editor.locator('.cm-content').getAttribute('contenteditable'), 'true');
  await hold(900);
  await page.mouse.move(1900, 1060);
  await page.screenshot({ path: join(out, '02-editor.png'), animations: 'disabled' });
  await rawScreenshot('02-editor');
  await hold(2200);

  await frame.locator('.tab').filter({ hasText: 'web-01' }).first().click();
  await frame.locator('.activity-rail .rail-btn').first().click();
  await frame.evaluate(() => window.marketingDemo.requestApproval());
  const dialog = frame.getByRole('dialog', { name: 'Approval required' });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: /Read-only/i }).click();
  await scene(2);
  await hold(1200);
  await dialog.getByRole('checkbox', { name: 'systemctl restart nginx', exact: true }).uncheck();
  await save(2);
  await hold(6000);
  console.log('approval controls:', await dialog.innerText());
  await dialog.getByRole('button', { name: 'Allow 2 selected', exact: true }).click();
  await hold(3200);
  const approved = await frame.evaluate(() => window.marketingDemo.approvals);
  assert.deepEqual(approved[0]?.selected, ['status', 'disk']);
  await page.locator('#end').evaluate((el) => { el.style.display = 'block'; });
  captions.push({ seconds: (Date.now() - timelineStart) / 1000, text: 'Try gxShell. Share feedback. If it helps you, give it a star on GitHub.' });
  await page.screenshot({ path: join(out, '04-github.png') });
  await hold(5500);
  const duration = (Date.now() - timelineStart) / 1000;
  const unknownCalls = [...new Set(await frame.evaluate(() => window.marketingDemo.unknownCalls))];
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(network.length, 0, 'An external request was blocked: ' + network.join(', '));
  const video = page.video();
  await context.close();
  if (!draft) {
    const source = await video.path();
    const result = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(startOffset), '-i', source,
      '-t', String(duration), '-an', '-vf', 'fps=30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', join(out, 'gxshell-english-demo.mp4')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const formatTime = (seconds) => new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23).replace('.', ',');
    await writeFile(join(out, 'gxshell-english-demo.srt'), captions.map((c, i) => `${i + 1}\n${formatTime(c.seconds)} --> ${formatTime(captions[i + 1]?.seconds ?? duration)}\n${c.text}\n`).join('\n'));
  }
  const social = await browser.newPage({ viewport: { width: 1280, height: 640 } });
  const workspaceImage = 'data:image/png;base64,' + (await readFile(join(out, 'screenshots', '01-workspace.png'))).toString('base64');
  await social.setContent(`<!doctype html><html lang="en"><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 85% 35%,#1b3c43,transparent 70%),#0a101b;color:#f1f6ff;font-family:Arial,sans-serif;width:1280px;height:640px;overflow:hidden}
    .brand{position:absolute;left:48px;top:39px;font-size:26px;font-weight:700;display:flex;gap:12px;align-items:center}.brand img{width:34px;height:34px}.eyebrow{position:absolute;top:49px;right:40px;color:#97b3c7;font-size:13px;letter-spacing:2px}
    h1{position:absolute;left:48px;top:145px;font-size:57px;line-height:1.12;letter-spacing:-2px;margin:0}p{position:absolute;left:51px;top:300px;font-size:23px;line-height:1.5;color:#b5c5d9}
    .screen{position:absolute;top:156px;left:528px;width:714px;border:1px solid #3a5364;border-radius:10px;box-shadow:0 30px 70px #0008}
    .features{position:absolute;left:50px;top:473px;font-size:16px;color:#8ee3c7}.url{position:absolute;left:50px;bottom:55px;font-size:21px;color:#d1e6e2}.sample{position:absolute;right:44px;bottom:58px;font-size:13px;color:#a5b6c8}
  </style><div class="brand"><img src="${brand}">gxShell</div><div class="eyebrow">OPEN SOURCE · AGPL-3.0</div><h1>Your servers.<br>One workspace.</h1><p>An open-source SSH workbench<br>for Windows.</p><img class="screen" src="${workspaceImage}"><div class="features">SSH · SFTP · Monitoring · AI tools</div><div class="url">github.com/gxmst/gxShell</div><div class="sample">Real interface · Fictional demo data</div></html>`);
  await social.locator('.screen').evaluate((img) => img.decode());
  await social.screenshot({ path: join(out, '05-social-preview.png') });
  await social.close();
  // A compact overview is useful for reviewing the entire kit at once.
  const tiles = [];
  for (let i = 0; i < 4; i++) {
    const name = i < 3 ? scenes[i][0] : '04-github';
    tiles.push({ input: await sharp(join(out, name + '.png')).resize(960, 540).toBuffer(), left: i % 2 * 960, top: Math.floor(i / 2) * 540 });
  }
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#0a101b' } }).composite(tiles).png().toFile(join(out, 'contact-sheet.png'));
  await writeFile(join(out, 'capture-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), source: 'Real gxShell frontend with isolated fictional API fixtures',
    platformShown: 'Windows', locale: 'en', viewport: [1920, 1080], duration: draft ? null : duration, errors, blockedNetworkRequests: network,
    unknownOptionalCalls: unknownCalls, approvals: approved, personalDataSourcesRead: false, applicationBackendStarted: false }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', out, duration: draft ? null : duration, scratch }));
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(scratch, 'failure.png') }).catch(() => {});
    console.error('debug screenshot:', join(scratch, 'failure.png'));
  }
  throw error;
} finally {
  await context?.close().catch(() => {});
  await browser?.close();
  await server.close();
}
