// Prepare compact README media from the isolated English marketing capture.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const input = join(project, 'docs/marketing/assets');
const output = join(input, 'readme');
await mkdir(output, { recursive: true });

for (const [source, target] of [
  ['01-workspace', 'workspace'], ['02-files', 'files'],
  ['02-documents', 'documents'], ['02-editor', 'editor'],
]) {
  await sharp(join(input, 'screenshots', source + '.png'))
    .resize({ width: 1500, withoutEnlargement: true })
    .webp({ quality: 86, effort: 6 }).toFile(join(output, target + '.webp'));
}
// Keep the actual approval dialog readable at GitHub's article width.
await sharp(join(input, '03-agent-review.png'))
  .extract({ left: 464, top: 292, width: 1000, height: 650 })
  .webp({ quality: 88, effort: 6 }).toFile(join(output, 'agent-review.webp'));

const subtitle = await readFile(join(input, 'gxshell-english-demo.srt'), 'utf8');
const times = [...subtitle.matchAll(/^(\d\d):(\d\d):(\d\d),(\d{3}) -->/gm)]
  .map((m) => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000);
assert(times.length >= 3, 'The demo must have workspace, document and approval scenes.');
const starts = [times[0] + 0.4, times[1] + 3, times[2] + 2];
const segments = starts.map((start, i) => `[0:v]trim=start=${start}:duration=2.4,setpts=PTS-STARTPTS[v${i}]`);
const filter = [...segments,
  '[v0][v1][v2]concat=n=3:v=1:a=0,fps=8,scale=960:-1:flags=lanczos,split[a][b]',
  '[a]palettegen=max_colors=96:stats_mode=diff[p]',
  '[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[out]',
].join(';');
const result = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
  '-i', join(input, 'gxshell-english-demo.mp4'), '-filter_complex', filter, '-map', '[out]', '-loop', '0',
  join(output, 'demo-preview.gif')], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
for (const name of ['workspace.webp', 'files.webp', 'documents.webp', 'editor.webp', 'agent-review.webp', 'demo-preview.gif']) {
  console.log(`${name}: ${(await stat(join(output, name))).size} bytes`);
}
