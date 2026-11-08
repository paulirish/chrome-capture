/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Head-to-head MediaRecorder (getDisplayMedia({preferCurrentTab: true}) + MediaRecorder,
 * matching `tab-recorder.js`) benchmark runner using the same 16-bit rAF pixel barcode
 * canvas workload as `stress-test-barcode.py`.
 *
 * Usage:
 *   node benchmarks/compare_mediarecorder.mjs
 *   node benchmarks/compare_mediarecorder.mjs --out-dir=./recordings/mediarecorder --duration=4000
 *   node benchmarks/compare_mediarecorder.mjs --headless --chrome="/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
 *
 * Inspect the output files afterward with:
 *   python3 benchmarks/analyze_mp4.py --dir=./recordings/mediarecorder
 */

import {spawn} from 'node:child_process';
import {access, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {platform, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {connectCdpSession} from '../capture-cdp.js';

async function findChrome(explicitPath) {
  if (explicitPath) return explicitPath;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = platform() === 'darwin'
    ? [
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
        '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ]
    : ['/usr/bin/google-chrome-unstable', '/usr/bin/google-chrome'];
  for (const c of candidates) {
    try {
      await access(c);
      return c;
    } catch {
      // Try next candidate.
    }
  }
  return candidates[0];
}

function makeHtml(w, h) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; overflow: hidden; background: #0b0f19; }
  canvas { display: block; width: 100vw; height: 100vh; }
</style></head><body>
<canvas id="c"></canvas>
<script>
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { alpha: false });
const W = ${w}, H = ${h};
canvas.width = W; canvas.height = H;
window.__rafCount = 0;
window.__startTime = performance.now();
const BLOCK_W = 24, BLOCK_H = 32;

function drawBarcode(frameIdx) {
  ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, BLOCK_W * 20, BLOCK_H + 8);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, BLOCK_W, BLOCK_H);
  ctx.fillStyle = '#000000'; ctx.fillRect(BLOCK_W, 0, BLOCK_W, BLOCK_H);
  for (let b = 0; b < 16; b++) {
    const bit = (frameIdx >> (15 - b)) & 1;
    ctx.fillStyle = bit ? '#ffffff' : '#000000';
    ctx.fillRect((b + 2) * BLOCK_W, 0, BLOCK_W, BLOCK_H);
  }
}

function render(now) {
  window.__rafCount++;
  const f = window.__rafCount;
  const hue1 = (f * 3) % 360;
  const grad = ctx.createLinearGradient(0, BLOCK_H + 8, W, H);
  grad.addColorStop(0, \`hsl(\${hue1}, 75%, 22%)\`);
  grad.addColorStop(1, \`hsl(\${(hue1 + 140) % 360}, 80%, 24%)\`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, BLOCK_H + 8, W, H - (BLOCK_H + 8));
  for (let i = 0; i < 16; i++) {
    const bx = ((f * (8 + i * 2) + i * 173) % (W + 200)) - 100;
    const by = BLOCK_H + 40 + ((i * 61) % Math.max(100, H - 180));
    ctx.fillStyle = \`hsla(\${(hue1 + i * 22) % 360}, 90%, 60%, 0.85)\`;
    ctx.fillRect(bx, by, 120, 36);
  }
  const elapsed = (now - window.__startTime) / 1000;
  const fps = elapsed > 0 ? (f / elapsed).toFixed(1) : '0.0';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.fillRect(24, BLOCK_H + 24, 540, 110);
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 28px monospace';
  ctx.fillText(\`RES: \${W}x\${H} | rAF FRAME: #\${f}\`, 40, BLOCK_H + 68);
  ctx.fillStyle = '#38bdf8';
  ctx.fillText(\`IN-PAGE rAF: \${fps} FPS | t=\${elapsed.toFixed(2)}s\`, 40, BLOCK_H + 110);
  drawBarcode(f);
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

window.__recordTab = async ({width, height, fps, mimeType, durationMs, videoBitsPerSecond}) => {
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    throw new Error('Unsupported mimeType: ' + mimeType);
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    preferCurrentTab: true,
    video: {
      displaySurface: 'browser',
      frameRate: { ideal: fps, max: fps },
      width: { ideal: width, max: width },
      height: { ideal: height, max: height },
    },
    audio: false,
  });
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings();
  const timestamps = [];
  let readerDone = Promise.resolve();
  if ('MediaStreamTrackProcessor' in window) {
    const proc = new MediaStreamTrackProcessor({ track });
    const reader = proc.readable.getReader();
    readerDone = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        timestamps.push(value.timestamp);
        value.close();
      }
    })();
  }
  const chunks = [];
  const recOpts = { mimeType };
  if (videoBitsPerSecond) recOpts.videoBitsPerSecond = videoBitsPerSecond;
  const rec = new MediaRecorder(stream, recOpts);
  const stopped = new Promise(res => rec.addEventListener('stop', res, {once: true}));
  rec.addEventListener('dataavailable', e => { if (e.data.size > 0) chunks.push(e.data); });

  const raf0 = window.__rafCount;
  const t0 = performance.now();
  rec.start();
  await new Promise(r => setTimeout(r, durationMs));
  const t1 = performance.now();
  const raf1 = window.__rafCount;
  rec.stop();
  await stopped;
  const t2 = performance.now();

  stream.getTracks().forEach(t => t.stop());
  await readerDone.catch(() => {});

  const blob = new Blob(chunks, { type: mimeType });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return {
    b64: btoa(bin),
    mimeUsed: rec.mimeType,
    settings,
    trackTimestampsUs: timestamps,
    rafFps: Number(((raf1 - raf0) / ((t1 - t0) / 1000)).toFixed(1)),
    finalizeMs: Number((t2 - t1).toFixed(1)),
  };
};
</script></body></html>`;
}

async function runCase(chromeBin, headless, outDir, {label, width, height, fps, mimeType, videoBitsPerSecond, durationMs}) {
  const html = makeHtml(width, height);
  const server = createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(html);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const userDataDir = await mkdtemp(join(tmpdir(), 'mr-rec-'));

  const chromeArgs = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--auto-accept-this-tab-capture',
    '--use-fake-ui-for-media-stream',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    '--remote-debugging-port=0',
    `http://127.0.0.1:${port}/`,
  ];
  if (headless) chromeArgs.unshift('--headless=new');
  if (platform() === 'linux') chromeArgs.push('--no-sandbox', '--disable-dev-shm-usage');

  const chrome = spawn(chromeBin, chromeArgs);
  const chromeExited = new Promise(resolve => chrome.once('exit', resolve));

  try {
    const browserWsUrl = await new Promise((resolve, reject) => {
      chrome.stderr.on('data', chunk => {
        const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(chunk.toString());
        if (m) resolve(m[1]);
      });
      chrome.once('error', reject);
      chrome.once('exit', c => reject(new Error(`Chrome exited early (${c})`)));
    });
    const httpBase = browserWsUrl.replace('ws://', 'http://').replace(/\/devtools\/.*/, '');
    await new Promise(r => setTimeout(r, 800));
    const targets = await (await fetch(`${httpBase}/json/list`)).json();
    const pageTarget = targets.find(t => t.type === 'page');
    const session = await connectCdpSession(pageTarget.webSocketDebuggerUrl);
    await session.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false});
    await new Promise(r => setTimeout(r, 600));

    const expr = `window.__recordTab(${JSON.stringify({width, height, fps, mimeType, durationMs, videoBitsPerSecond})})`;
    const evalRes = await session.send('Runtime.evaluate', {expression: expr, awaitPromise: true, returnByValue: true});
    if (evalRes.exceptionDetails) {
      throw new Error(JSON.stringify(evalRes.exceptionDetails));
    }
    const val = evalRes.result.value;
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const outPath = join(outDir, `${label}.${ext}`);
    await writeFile(outPath, Buffer.from(val.b64, 'base64'));
    await writeFile(join(outDir, `${label}.meta.json`), JSON.stringify({
      label,
      mimeUsed: val.mimeUsed,
      settings: val.settings,
      rafFps: val.rafFps,
      finalizeMs: val.finalizeMs,
      trackTimestampsCount: val.trackTimestampsUs.length,
      trackTimestampsUs: val.trackTimestampsUs,
    }, null, 2));
    console.log(`${label}: saved ${outPath} (${val.mimeUsed}, ${val.settings.width}x${val.settings.height}@${val.settings.frameRate}, raf=${val.rafFps}, finalize=${val.finalizeMs}ms)`);
    session.close();
  } finally {
    chrome.kill('SIGTERM');
    await Promise.race([chromeExited, new Promise(r => setTimeout(r, 3000))]);
    await rm(userDataDir, {recursive: true, force: true});
    server.closeAllConnections?.();
    server.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: node benchmarks/compare_mediarecorder.mjs [options]

Options:
  --out-dir=<path>    Output directory (default: ./recordings/mediarecorder)
  --duration=<ms>     Recording duration in ms (default: 4000)
  --chrome=<path>     Path to Chrome binary
  --headless          Run in --headless=new mode
  -h, --help          Show this help message`);
    return;
  }
  const getFlag = (flag) => {
    const eq = args.find(a => a.startsWith(flag + '='));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : undefined;
  };

  const outDir = getFlag('--out-dir') ?? join(process.cwd(), 'recordings', 'mediarecorder');
  const durationMs = Number(getFlag('--duration') ?? '4000');
  const headless = args.includes('--headless');
  const chromeBin = await findChrome(getFlag('--chrome'));

  await mkdir(outDir, {recursive: true});

  const cases = [
    {label: 'mr_1080p_60_vp9_default_2.5m', width: 1920, height: 1080, fps: 60, mimeType: 'video/webm; codecs=vp9', durationMs},
    {label: 'mr_1080p_60_vp9_8m', width: 1920, height: 1080, fps: 60, mimeType: 'video/webm; codecs=vp9', videoBitsPerSecond: 8_000_000, durationMs},
    {label: 'mr_1080p_120_vp9_12m', width: 1920, height: 1080, fps: 120, mimeType: 'video/webm; codecs=vp9', videoBitsPerSecond: 12_000_000, durationMs},
    {label: 'mr_1080p_120_av1_mp4_12m', width: 1920, height: 1080, fps: 120, mimeType: 'video/mp4; codecs=av01.0.04M.08', videoBitsPerSecond: 12_000_000, durationMs},
    {label: 'mr_4k_60_vp9_15m', width: 3840, height: 2160, fps: 60, mimeType: 'video/webm; codecs=vp9', videoBitsPerSecond: 15_000_000, durationMs},
  ];

  for (const c of cases) {
    try {
      await runCase(chromeBin, headless, outDir, c);
    } catch (err) {
      console.error(`FAILED ${c.label}:`, err.message);
    }
  }
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
