#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Static-idle -> 120Hz burst -> static-idle VFR & GOP inspector for CDP Page.startScreenRecording.
 *
 * Zero external npm dependencies (requires Node 24+, Chrome M153+, ffprobe, and ffmpeg).
 *
 * Usage:
 *   node benchmarks/vfr-burst-test.ts
 *   node benchmarks/vfr-burst-test.ts --out-dir=./recordings/vfr_burst
 *   node benchmarks/vfr-burst-test.ts --headless --chrome="/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
 */

import {statSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {
  CdpScreenRecorder,
  connectCdpSession,
  findChromeBinary,
  launchChrome,
} from '../src/index.ts';
import {inspectFile} from './analyze-mp4.ts';
import {setupBarcodePage} from './stress-test-barcode.ts';

const BURST_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; overflow: hidden; background: #0b0f19; }
  canvas { display: block; width: 100vw; height: 100vh; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<script>
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { alpha: false });
const W = window.innerWidth;
const H = window.innerHeight;
canvas.width = W;
canvas.height = H;

const BLOCK_W = 24;
const BLOCK_H = 32;
let frameIdx = 0;
let running = false;

function drawBarcode(idx) {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, BLOCK_W * 20, BLOCK_H + 8);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, BLOCK_W, BLOCK_H);
  ctx.fillStyle = '#000000';
  ctx.fillRect(BLOCK_W, 0, BLOCK_W, BLOCK_H);
  for (let b = 0; b < 16; b++) {
    const bit = (idx >> (15 - b)) & 1;
    ctx.fillStyle = bit ? '#ffffff' : '#000000';
    ctx.fillRect((b + 2) * BLOCK_W, 0, BLOCK_W, BLOCK_H);
  }
}

function drawStatic(label) {
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#e5e7eb';
  ctx.font = 'bold 36px monospace';
  ctx.fillText(label + ' | frame #' + frameIdx, 40, 120);
  drawBarcode(frameIdx);
}

function tick() {
  if (!running) return;
  frameIdx++;
  const hue1 = (frameIdx * 3) % 360;
  const grad = ctx.createLinearGradient(0, BLOCK_H + 8, W, H);
  grad.addColorStop(0, 'hsl(' + hue1 + ', 75%, 22%)');
  grad.addColorStop(1, 'hsl(' + ((hue1 + 140) % 360) + ', 80%, 24%)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, BLOCK_H + 8, W, H - (BLOCK_H + 8));

  for (let i = 0; i < 16; i++) {
    const bx = ((frameIdx * (8 + i * 2) + i * 173) % (W + 200)) - 100;
    const by = BLOCK_H + 40 + ((i * 61) % Math.max(100, H - 180));
    ctx.fillStyle = 'hsla(' + ((hue1 + i * 22) % 360) + ', 90%, 60%, 0.85)';
    ctx.fillRect(bx, by, 120, 36);
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 32px monospace';
  ctx.fillText('BURST #' + frameIdx, 40, 120);
  drawBarcode(frameIdx);
  requestAnimationFrame(tick);
}

window.__startBurst = () => {
  running = true;
  requestAnimationFrame(tick);
  return frameIdx;
};
window.__stopBurst = () => {
  running = false;
  drawStatic('IDLE AFTER');
  return frameIdx;
};

drawStatic('IDLE BEFORE');
</script>
</body>
</html>
`;

export interface BurstPacketRow {
  idx: number;
  pts_ms: number;
  dpts_ms: number;
  size_kb: number;
  key: boolean;
  barcode: number | null;
}

export interface BurstSummary {
  label: string;
  burst_start_s: number;
  burst_stop_s: number;
  total_wall_s: number;
  end_raf_idx: number;
  total_packets: number;
  size_kb: number;
  keyframes: number[];
  gaps_gt_25ms: BurstPacketRow[];
  rows: BurstPacketRow[];
}

export async function recordBurst(
  chromeBin: string,
  headless: boolean,
  label: string,
  width: number,
  height: number,
  fps: number,
  idleSec: number,
  burstSec: number,
  outDir?: string,
): Promise<BurstSummary> {
  const launched = await launchChrome({
    explicitPath: chromeBin,
    width,
    height,
    headless,
    audio: false,
  });

  const outMp4 = outDir ? join(outDir, `${label}.mp4`) : join(launched.userDataDir, `${label}.mp4`);

  try {
    const session = await connectCdpSession(launched.pageTargetWs);
    await setupBarcodePage(session, width, height, BURST_HTML);

    const t0 = performance.now();
    const recorder = new CdpScreenRecorder(session);
    await recorder.start({
      frameRate: fps,
      maxWidth: width,
      maxHeight: height,
      audio: false,
    });

    await new Promise(r => setTimeout(r, idleSec * 1000));
    const tBurstStart = (performance.now() - t0) / 1000.0;

    await session.send('Runtime.evaluate', {
      expression: 'window.__startBurst()',
      returnByValue: true,
    });

    await new Promise(r => setTimeout(r, burstSec * 1000));
    const tBurstStop = (performance.now() - t0) / 1000.0;

    const stopEval = await session.send('Runtime.evaluate', {
      expression: 'window.__stopBurst()',
      returnByValue: true,
    });
    const endIdx = typeof stopEval.result.value === 'number' ? stopEval.result.value : 0;

    await new Promise(r => setTimeout(r, idleSec * 1000));
    const tEnd = (performance.now() - t0) / 1000.0;

    const mp4Bytes = await recorder.stop();
    session.close();

    await writeFile(outMp4, mp4Bytes);

    const inspection = inspectFile(outMp4, true);
    const rows: BurstPacketRow[] = (inspection.timeline ?? []).map((t) => ({
      idx: t.idx,
      pts_ms: t.pts_ms,
      dpts_ms: t.dpts_ms,
      size_kb: Math.round((t.size_b / 1024) * 100) / 100,
      key: t.key,
      barcode: t.barcode,
    }));

    const sizeBytes = statSync(outMp4).size;
    const sizeKb = Math.round((sizeBytes / 1024) * 10) / 10;
    const keyframes = rows.filter(r => r.key).map(r => r.idx);
    const gapsGt25ms = rows.filter(r => r.dpts_ms > 25.0);

    const summary: BurstSummary = {
      label,
      burst_start_s: Math.round(tBurstStart * 1000) / 1000,
      burst_stop_s: Math.round(tBurstStop * 1000) / 1000,
      total_wall_s: Math.round(tEnd * 1000) / 1000,
      end_raf_idx: endIdx,
      total_packets: rows.length,
      size_kb: sizeKb,
      keyframes,
      gaps_gt_25ms: gapsGt25ms,
      rows,
    };

    if (outDir) {
      await writeFile(join(outDir, `${label}.json`), JSON.stringify(summary, null, 2));
    }

    console.log(`=== ${label}: ${rows.length} packets, end_raf=${endIdx}, size=${summary.size_kb} KB ===`);
    console.log(`  Keyframes: ${JSON.stringify(summary.keyframes)}`);
    for (const g of summary.gaps_gt_25ms) {
      console.log(
        `  Gap >25ms: pkt #${g.idx} pts=${g.pts_ms}ms (+${g.dpts_ms}ms) size=${g.size_kb}KB key=${g.key} barcode=${g.barcode}`,
      );
    }

    return summary;
  } finally {
    await launched.close();
  }
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      chrome: {type: 'string'},
      headless: {type: 'boolean'},
      'idle-sec': {type: 'string'},
      'burst-sec': {type: 'string'},
      'out-dir': {type: 'string'},
      help: {type: 'boolean', short: 'h'},
    },
    allowPositionals: true,
  });

  if (parsed.values.help) {
    console.log(`Usage: node benchmarks/vfr-burst-test.ts [options]

Static-idle -> 120Hz burst -> static-idle VFR & GOP inspector.

Options:
  --chrome=<path>       Path to Google Chrome (M153+)
  --headless            Run in --headless=new mode
  --idle-sec=<sec>      Idle duration before and after burst (default: 1.5)
  --burst-sec=<sec>     Active motion burst duration (default: 2.0)
  --out-dir=<path>      Optional directory to save MP4s and packet JSON
  -h, --help            Show this help message
`);
    return;
  }

  const chromeBin = await findChromeBinary(parsed.values.chrome);
  const headless = Boolean(parsed.values.headless);
  const idleSec = parsed.values['idle-sec'] ? parseFloat(parsed.values['idle-sec']) : 1.5;
  const burstSec = parsed.values['burst-sec'] ? parseFloat(parsed.values['burst-sec']) : 2.0;
  const outDir = parsed.values['out-dir'];

  if (outDir) {
    await mkdir(outDir, {recursive: true});
  }

  await recordBurst(chromeBin, headless, '1080p_120fps_burst', 1920, 1080, 120, idleSec, burstSec, outDir);
  await recordBurst(chromeBin, headless, '4k_60fps_burst', 3840, 2160, 60, idleSec, burstSec, outDir);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: Error) => {
    console.error(err);
    process.exit(1);
  });
}
