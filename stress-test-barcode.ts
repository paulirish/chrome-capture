#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * macOS ProMotion (90Hz/120Hz) & Hardware-GPU Stress Test for CDP Page.startScreenRecording.
 *
 * Zero third-party runtime dependencies (runs directly with `node stress-test-barcode.ts`).
 * Uses `devtools-protocol` type annotations and CDP session utilities from `./capture-cdp.ts`.
 *
 * Verifies recorded MP4 frames against a 16-bit binary pixel barcode burned into every
 * requestAnimationFrame (rAF) tick, correlating container packet counts against true unique
 * visual frames to measure hardware VSync lock, frame pacing, and duplicate frame ratios.
 *
 * Usage:
 *   node stress-test-barcode.ts
 *   node stress-test-barcode.ts --out-dir=./recordings
 *   node stress-test-barcode.ts --headless
 *   node stress-test-barcode.ts --chrome="/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
 *   node stress-test-barcode.ts --duration=3.0
 */

import {spawn, spawnSync} from 'node:child_process';
import {access, mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {statSync} from 'node:fs';
import {platform, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Protocol} from 'devtools-protocol';
import {CdpScreenRecorder, connectCdpSession} from './capture-cdp.ts';

export interface BarcodeMetrics {
  duration_sec: number;
  container_frames: number;
  container_fps: number;
  unique_frames: number;
  unique_visual_fps: number;
  duplicate_pct: number;
  size_kb: number;
  browser?: string;
  in_page_raf_fps?: number;
  finalize_ms?: number;
  video_path?: string;
  streamHandle?: Protocol.IO.StreamHandle;
}

export interface TestCase {
  label: string;
  width: number;
  height: number;
  fps: number;
  uncap: boolean;
}

interface FfprobeStream {
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeFormat {
  duration?: string;
  size?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

const MAC_CHROME_CANDIDATES: string[] = [
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-unstable',
];

export async function findChrome(explicitPath?: string): Promise<string> {
  if (explicitPath) {
    try {
      await access(explicitPath);
      return explicitPath;
    } catch {
      throw new Error(`Specified Chrome binary not found: ${explicitPath}`);
    }
  }
  for (const cand of MAC_CHROME_CANDIDATES) {
    try {
      await access(cand);
      return cand;
    } catch {
      // Continue to next candidate.
    }
  }
  throw new Error('Could not find Google Chrome (M153+). Pass --chrome="/path/to/Google Chrome"');
}

/**
 * Rich Visual Diagnostic Canvas HTML.
 *
 * HARD INVARIANT:
 * The top-left 16-bit binary pixel barcode consists of 18 blocks of 24x32 pixels at (0, 0):
 * - Block 0 (x=0..24): #ffffff (white reference clock)
 * - Block 1 (x=24..48): #000000 (black reference clock)
 * - Blocks 2..17 (x=48..432): bits 15..0 (MSB to LSB) of the monotonic rAF frame index `f`.
 * This layout is sampled at y=12 by `ffmpeg -vf crop=432:8:0:12,format=gray` and `benchmarks/analyze_mp4.py`.
 */
export const BARCODE_CANVAS_HTML: string = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body {
    margin: 0;
    padding: 0;
    overflow: hidden;
    background: #060913;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    color: #e2e8f0;
  }
  canvas {
    display: block;
    width: 100vw;
    height: 100vh;
  }
</style>
</head>
<body>
<canvas id="c"></canvas>
<script>
(() => {
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d', { alpha: false });
  const W = window.innerWidth;
  const H = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W;
  canvas.height = H;

  window.__rafCount = 0;
  window.__startTime = performance.now();
  let lastNow = performance.now();

  const BLOCK_W = 24;
  const BLOCK_H = 32;

  // Frame timing history buffer for sparkline / jitter strip
  const HISTORY_LEN = 180;
  const deltaHistory = new Float32Array(HISTORY_LEN);
  let historyIdx = 0;
  let minDelta = 999.0;
  let maxDelta = 0.0;
  let deltaSum = 0.0;
  let deltaCount = 0;

  // 1. HARD INVARIANT: Draw top-left 18-block barcode
  function drawBarcode(frameIdx) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, BLOCK_W * 20, BLOCK_H + 8);
    // Block 0: White calibration guard
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, BLOCK_W, BLOCK_H);
    // Block 1: Black calibration guard
    ctx.fillStyle = '#000000';
    ctx.fillRect(BLOCK_W, 0, BLOCK_W, BLOCK_H);
    // Blocks 2..17: 16-bit binary representation of frameIdx (MSB first)
    for (let b = 0; b < 16; b++) {
      const bit = (frameIdx >> (15 - b)) & 1;
      ctx.fillStyle = bit ? '#ffffff' : '#000000';
      ctx.fillRect((b + 2) * BLOCK_W, 0, BLOCK_W, BLOCK_H);
    }
  }

  // 2. High-precision VSync Strobe / Persistence Radial Dial
  function drawStrobeDial(cx, cy, radius, frameIdx) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 18, 0, Math.PI * 2);
    ctx.fillStyle = '#0c1322';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#1e293b';
    ctx.stroke();

    // 60-tick ring markers
    const totalTicks = 60;
    for (let t = 0; t < totalTicks; t++) {
      const angle = (t / totalTicks) * Math.PI * 2 - Math.PI / 2;
      const isMajor = (t % 5 === 0);
      const innerR = radius - (isMajor ? 14 : 7);
      const outerR = radius;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * innerR, cy + Math.sin(angle) * innerR);
      ctx.lineTo(cx + Math.cos(angle) * outerR, cy + Math.sin(angle) * outerR);
      ctx.strokeStyle = isMajor ? '#64748b' : '#334155';
      ctx.lineWidth = isMajor ? 2.5 : 1;
      ctx.stroke();
    }

    // Persistence trail (last 8 frames with decaying alpha)
    for (let trail = 7; trail >= 0; trail--) {
      const pastFrame = frameIdx - trail;
      if (pastFrame < 0) continue;
      const tick = pastFrame % totalTicks;
      const angle = (tick / totalTicks) * Math.PI * 2 - Math.PI / 2;
      const alpha = trail === 0 ? 1.0 : Math.max(0.12, 0.7 - trail * 0.08);

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * (radius - 3), cy + Math.sin(angle) * (radius - 3));
      ctx.strokeStyle = trail === 0 ? '#38bdf8' : 'hsla(' + ((pastFrame * 18) % 360) + ', 95%, 65%, ' + alpha + ')';
      ctx.lineWidth = trail === 0 ? 4 : 2;
      ctx.stroke();

      // Outer head dot
      ctx.beginPath();
      ctx.arc(cx + Math.cos(angle) * (radius - 5), cy + Math.sin(angle) * (radius - 5), trail === 0 ? 5 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = trail === 0 ? '#f0f9ff' : 'hsla(' + ((pastFrame * 18) % 360) + ', 100%, 70%, ' + alpha + ')';
      ctx.fill();
    }

    // Center hub
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#0284c7';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#38bdf8';
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('VSYNC STROBE (60T)', cx, cy + radius + 12);
    ctx.restore();
  }

  // 3. Real-Time Delta-T Sparkline / Frame Pacing Strip
  function drawFrameTimingSparkline(x, y, w, h, currentDt) {
    ctx.save();
    ctx.fillStyle = 'rgba(12, 19, 34, 0.85)';
    ctx.fillRect(x, y, w, h);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#1e293b';
    ctx.strokeRect(x, y, w, h);

    // Target threshold lines: 120Hz (8.33ms), 90Hz (11.11ms), 60Hz (16.67ms), 30Hz (33.33ms)
    // Scale: 0ms at bottom (y + h), 40ms at top (y)
    const maxScaleMs = 40.0;
    const targets = [
      { hz: '120Hz', dt: 8.33, color: '#38bdf8' },
      { hz: '90Hz',  dt: 11.11, color: '#34d399' },
      { hz: '60Hz',  dt: 16.67, color: '#facc15' },
      { hz: '30Hz',  dt: 33.33, color: '#f87171' },
    ];

    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    for (const t of targets) {
      const lineY = y + h - (t.dt / maxScaleMs) * h;
      if (lineY >= y && lineY <= y + h) {
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.moveTo(x, lineY);
        ctx.lineTo(x + w, lineY);
        ctx.strokeStyle = t.color + '55';
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = t.color;
        ctx.fillText(t.hz + ' (' + t.dt.toFixed(1) + 'ms)', x + 8, lineY - 3);
      }
    }

    // Draw historical delta bars
    const barW = Math.max(1, w / HISTORY_LEN);
    for (let i = 0; i < HISTORY_LEN; i++) {
      const idx = (historyIdx + i) % HISTORY_LEN;
      const dt = deltaHistory[idx];
      if (dt <= 0) continue;
      const barH = Math.min(h, (dt / maxScaleMs) * h);
      const barX = x + i * barW;
      const barY = y + h - barH;

      // Color coding: green <= 9ms (120Hz), teal <= 12ms (90Hz), yellow <= 18ms (60Hz), red > 18ms
      if (dt <= 9.0) {
        ctx.fillStyle = '#38bdf8';
      } else if (dt <= 12.0) {
        ctx.fillStyle = '#34d399';
      } else if (dt <= 18.0) {
        ctx.fillStyle = '#fbbf24';
      } else {
        ctx.fillStyle = '#f87171';
      }
      ctx.fillRect(barX, barY, Math.max(1, barW - 0.5), barH);
    }

    // Sparkline title
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'right';
    ctx.fillText('FRAME TIME: ' + currentDt.toFixed(2) + ' ms', x + w - 8, y + 14);
    ctx.restore();
  }

  // 4. Chroma / Luma Subsampling & Color Gamut Inspection Bars
  function drawChromaSharpness(x, y, w, h) {
    ctx.save();
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);

    // 1px alternating black & white vertical luma stripes (Nyquist test)
    const stripeW = Math.floor(w / 4);
    for (let px = 0; px < stripeW; px += 2) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x + px, y, 1, h);
      ctx.fillStyle = '#000000';
      ctx.fillRect(x + px + 1, y, 1, h);
    }

    // 1px alternating red & cyan chroma sharpness stripes (4:2:0 subsampling torture)
    const chromaX = x + stripeW + 4;
    for (let px = 0; px < stripeW; px += 2) {
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(chromaX + px, y, 1, h);
      ctx.fillStyle = '#06b6d4';
      ctx.fillRect(chromaX + px + 1, y, 1, h);
    }

    // 8-bit smooth gradient ramp to reveal quantization banding
    const gradX = chromaX + stripeW + 4;
    const gradW = w - (gradX - x);
    const ramp = ctx.createLinearGradient(gradX, 0, gradX + gradW, 0);
    ramp.addColorStop(0, '#000000');
    ramp.addColorStop(0.5, '#475569');
    ramp.addColorStop(1, '#ffffff');
    ctx.fillStyle = ramp;
    ctx.fillRect(gradX, y, gradW, h);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('1px LUMA', x + 2, y + h + 10);
    ctx.fillText('1px CHROMA 4:2:0', chromaX + 2, y + h + 10);
    ctx.fillText('8-BIT BANDING RAMP', gradX + 2, y + h + 10);
    ctx.restore();
  }

  // 5. Dynamic Moving Stress Elements (smooth multi-speed scrolling)
  function drawStressMotion(f, hue1) {
    const startY = BLOCK_H + 20;
    const bannerY = H - 36;
    const motionH = Math.max(120, H - startY - 260);

    // Multi-color dynamic backdrop gradient
    const grad = ctx.createLinearGradient(0, startY, W, H);
    grad.addColorStop(0, 'hsl(' + hue1 + ', 65%, 12%)');
    grad.addColorStop(1, 'hsl(' + ((hue1 + 130) % 360) + ', 70%, 14%)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, startY, W, H - startY);

    // Dynamic floating velocity bars across canvas (restricted to open areas to keep HUD & graphs pristine)
    const hudAreaRight = Math.min(620, W - 20);
    const hudAreaBottom = startY + 300;
    for (let i = 0; i < 14; i++) {
      const speed = 6 + i * 2.5;
      const bx = ((f * speed + i * 197) % (W + 260)) - 130;
      // Position bars either below HUD/telemetry area or in right half of screen
      let by = startY + 20 + ((i * 47) % Math.max(80, motionH - 50));
      if (bx < hudAreaRight && by < hudAreaBottom) {
        by += hudAreaBottom - startY;
      }
      if (by + 30 > bannerY - 14) {
        by = bannerY - 50;
      }
      const barHue = (hue1 + i * 25) % 360;
      ctx.fillStyle = 'hsla(' + barHue + ', 90%, 60%, 0.8)';
      ctx.fillRect(bx, by, 110, 26);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px monospace';
      ctx.fillText('#' + (i + 1), bx + 6, by + 17);
    }

    // High-speed horizontally scrolling text banner (tests temporal motion smearing)
    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, bannerY - 14, W, 40);
    const scrollText = 'PROMOTION 120HZ VSYNC BENCHMARK - TESTING AV1 HARDWARE ENCODING & CDP SCREEN RECORDING FIDELITY - FRAME ' + f + ' - ';
    const textW = 1200;
    const textX = -((f * 12) % textW);
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 14px monospace';
    for (let ox = textX; ox < W + textW; ox += textW) {
      ctx.fillText(scrollText, ox, bannerY + 12);
    }
  }

  function render(now) {
    window.__render = render;
    window.__rafCount++;
    const f = window.__rafCount;
    const dt = Math.max(0.1, now - lastNow);
    lastNow = now;

    // Timing stats
    deltaHistory[historyIdx] = dt;
    historyIdx = (historyIdx + 1) % HISTORY_LEN;
    if (f > 10) {
      minDelta = Math.min(minDelta, dt);
      maxDelta = Math.max(maxDelta, dt);
      deltaSum += dt;
      deltaCount++;
    }
    const avgDelta = deltaCount > 0 ? (deltaSum / deltaCount) : dt;
    const jitter = Math.abs(dt - avgDelta);

    const elapsed = (now - window.__startTime) / 1000;
    const rollingFps = elapsed > 0 ? (f / elapsed).toFixed(1) : '0.0';
    const hue1 = (f * 2.5) % 360;

    // Draw dynamic background & moving motion stress elements
    drawStressMotion(f, hue1);

    // Live Telemetry HUD Panel
    const hudW = Math.min(580, W - 48);
    const hudH = 148;
    const hudX = 24;
    const hudY = BLOCK_H + 24;
    ctx.save();
    ctx.fillStyle = 'rgba(6, 10, 20, 0.88)';
    ctx.fillRect(hudX, hudY, hudW, hudH);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#38bdf8';
    ctx.strokeRect(hudX, hudY, hudW, hudH);

    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 20px monospace';
    ctx.fillText('rAF FRAME: #' + f + ' (0x' + f.toString(16).toUpperCase().padStart(4, '0') + ')', hudX + 16, hudY + 28);

    // 16-bit binary display matching barcode
    const binStr = (f & 0xffff).toString(2).padStart(16, '0');
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px monospace';
    ctx.fillText('BARCODE BITS: [W B ' + binStr.slice(0, 8) + ' ' + binStr.slice(8) + ']', hudX + 16, hudY + 50);

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 15px monospace';
    ctx.fillText('IN-PAGE rAF: ' + rollingFps + ' FPS  |  t = ' + elapsed.toFixed(2) + 's', hudX + 16, hudY + 76);

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '13px monospace';
    ctx.fillText('Δt: ' + dt.toFixed(2) + 'ms (min: ' + minDelta.toFixed(1) + ' / max: ' + maxDelta.toFixed(1) + ' / j: ' + jitter.toFixed(2) + 'ms)', hudX + 16, hudY + 102);

    ctx.fillStyle = '#a7f3d0';
    ctx.fillText('VIEWPORT: ' + W + 'x' + H + ' (dpr: ' + dpr + ')', hudX + 16, hudY + 128);
    ctx.restore();

    // VSync Strobe Dial (placed to the right of the HUD if space permits)
    const strobeRadius = 58;
    const strobeX = Math.min(W - strobeRadius - 32, hudX + hudW + strobeRadius + 36);
    const strobeY = hudY + strobeRadius + 8;
    if (strobeX - strobeRadius > hudX + hudW + 10 && strobeX + strobeRadius < W) {
      drawStrobeDial(strobeX, strobeY, strobeRadius, f);
    }

    // Frame-timing sparkline / jitter strip
    const sparkW = Math.min(580, W - 48);
    const sparkH = 74;
    const sparkX = 24;
    const sparkY = hudY + hudH + 16;
    drawFrameTimingSparkline(sparkX, sparkY, sparkW, sparkH, dt);

    // Chroma / Luma subsampling & 8-bit banding inspection strip
    const chromaW = Math.min(580, W - 48);
    const chromaH = 22;
    const chromaX = 24;
    const chromaY = sparkY + sparkH + 16;
    drawChromaSharpness(chromaX, chromaY, chromaW, chromaH);

    // Top-left 18-block 16-bit barcode (always drawn last on top)
    drawBarcode(f);

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
})();
</script>
</body>
</html>
`;

/**
 * Decodes 16-bit binary pixel barcodes from the recorded MP4 using ffmpeg + ffprobe.
 */
export function decodeBarcodes(videoPath: string): BarcodeMetrics {
  const cropW = 18 * 24;
  const cropH = 8;
  const rawProc = spawnSync('ffmpeg', [
    '-v', 'error',
    '-i', videoPath,
    '-vsync', '0',
    '-vf', `crop=${cropW}:${cropH}:0:12,format=gray`,
    '-f', 'rawvideo',
    'pipe:1',
  ], {maxBuffer: 500 * 1024 * 1024});

  if (rawProc.error) {
    throw new Error(`ffmpeg execution failed: ${rawProc.error.message}`);
  }
  const raw = rawProc.stdout;
  const stride = cropW * cropH;
  const nFrames = Math.floor(raw.length / stride);

  const probeProc = spawnSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,duration',
    '-show_entries', 'format=duration,size',
    '-of', 'json',
    videoPath,
  ], {encoding: 'utf8'});

  if (probeProc.error) {
    throw new Error(`ffprobe execution failed: ${probeProc.error.message}`);
  }

  const probe: FfprobeOutput = JSON.parse(probeProc.stdout || '{}');
  const stream = (probe.streams && probe.streams[0]) || {};
  const fmt = probe.format || {};
  const dur = parseFloat(stream.duration || fmt.duration || '0.0');

  let fileSizeBytes = 0;
  if (fmt.size) {
    fileSizeBytes = parseInt(fmt.size, 10);
  } else {
    try {
      fileSizeBytes = statSync(videoPath).size;
    } catch {
      fileSizeBytes = 0;
    }
  }
  const sizeKb = fileSizeBytes / 1024.0;

  const barcodes: number[] = [];
  for (let i = 0; i < nFrames; i++) {
    const fbuf = raw.subarray(i * stride, (i + 1) * stride);
    const row = 4 * cropW;
    // Calibration guards: block 0 (white >= 160), block 1 (black <= 96)
    if (fbuf[row + 12] < 160 || fbuf[row + 36] > 96) {
      continue;
    }
    let val = 0;
    for (let b = 0; b < 16; b++) {
      const bit = fbuf[row + (b + 2) * 24 + 12] >= 128 ? 1 : 0;
      val = (val << 1) | bit;
    }
    barcodes.push(val);
  }

  const unique = new Set(barcodes).size;
  let dups = 0;
  for (let i = 1; i < barcodes.length; i++) {
    if (barcodes[i] === barcodes[i - 1]) {
      dups++;
    }
  }

  return {
    duration_sec: Math.round(dur * 100) / 100,
    container_frames: nFrames,
    container_fps: dur > 0 ? Math.round((nFrames / dur) * 10) / 10 : 0.0,
    unique_frames: unique,
    unique_visual_fps: dur > 0 ? Math.round((unique / dur) * 10) / 10 : 0.0,
    duplicate_pct: barcodes.length > 0 ? Math.round((100.0 * dups / barcodes.length) * 10) / 10 : 0.0,
    size_kb: Math.round(sizeKb * 10) / 10,
  };
}

export async function runCase(
  chromeBin: string,
  headless: boolean,
  width: number,
  height: number,
  fps: number,
  uncap: boolean,
  duration: number,
  savePath?: string,
): Promise<BarcodeMetrics> {
  const tmpdirPrefix = join(tmpdir(), 'stress_barcode_');
  const userDataDir = await mkdtemp(tmpdirPrefix);
  const outMp4 = savePath || join(userDataDir, 'out.mp4');

  const chromeArgs = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    '--remote-debugging-port=0',
    'about:blank',
  ];
  if (headless) {
    chromeArgs.unshift('--headless=new');
  }
  if (platform() === 'linux') {
    chromeArgs.push('--no-sandbox', '--disable-dev-shm-usage');
  }
  if (uncap) {
    chromeArgs.push('--disable-frame-rate-limit', '--disable-gpu-vsync');
  }

  const proc = spawn(chromeBin, chromeArgs, {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  try {
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let stderrAcc = '';
      const onData = (chunk: Buffer) => {
        stderrAcc += chunk.toString();
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderrAcc);
        if (match) {
          proc.stderr?.off('data', onData);
          resolve(match[1]);
        }
      };
      proc.stderr?.on('data', onData);
      proc.once('error', reject);
      proc.once('exit', (code) => reject(new Error(`Chrome exited prematurely with code ${code}`)));
    });

    const httpBase = wsUrl.replace('ws://', 'http://').replace(/\/devtools\/.*/, '');
    let browserVer = 'unknown';
    try {
      const resp = await fetch(`${httpBase}/json/version`);
      const info = await resp.json() as {Browser?: string};
      if (info && typeof info.Browser === 'string') {
        browserVer = info.Browser;
      }
    } catch {
      // Continue with unknown version.
    }

    interface TargetItem {
      id: string;
      type: string;
      url: string;
      webSocketDebuggerUrl: string;
    }
    const targets = await (await fetch(`${httpBase}/json/list`)).json() as TargetItem[];
    const pageTarget = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
    if (!pageTarget) {
      throw new Error('No page target found');
    }

    const pageSession = await connectCdpSession(pageTarget.webSocketDebuggerUrl);

    await pageSession.send('Page.enable');
    await pageSession.send('Runtime.enable');
    await pageSession.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const frameTreeRes = await pageSession.send('Page.getFrameTree');
    const frameId = frameTreeRes.frameTree.frame.id;
    await pageSession.send('Page.setDocumentContent', {
      frameId,
      html: BARCODE_CANVAS_HTML,
    });

    await new Promise((r) => setTimeout(r, 600));

    const eval0 = await pageSession.send('Runtime.evaluate', {
      expression: 'window.__rafCount',
      returnByValue: true,
    });
    const raf0 = typeof eval0.result.value === 'number' ? eval0.result.value : 0;
    const t0 = performance.now();

    const recorder = new CdpScreenRecorder(pageSession);
    await recorder.start({
      frameRate: fps,
      maxWidth: width,
      maxHeight: height,
      audio: false,
    });

    await new Promise((r) => setTimeout(r, duration * 1000));
    const t1 = performance.now();

    const eval1 = await pageSession.send('Runtime.evaluate', {
      expression: 'window.__rafCount',
      returnByValue: true,
    });
    const raf1 = typeof eval1.result.value === 'number' ? eval1.result.value : raf0;

    const mp4Bytes = await recorder.stop();
    const t2 = performance.now();
    pageSession.close();

    await writeFile(outMp4, mp4Bytes);

    const m = decodeBarcodes(outMp4);
    m.browser = browserVer;
    const testDurSec = (t1 - t0) / 1000.0;
    m.in_page_raf_fps = testDurSec > 0 ? Math.round(((raf1 - raf0) / testDurSec) * 10) / 10 : 0.0;
    m.finalize_ms = Math.round((t2 - t1) * 10) / 10;
    if (savePath) {
      m.video_path = savePath;
    }
    return m;
  } finally {
    proc.kill();
    try {
      await rm(userDataDir, {recursive: true, force: true});
    } catch {
      // Ignore cleanup error.
    }
  }
}

export async function cli(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: node stress-test-barcode.ts [options]

macOS ProMotion & Hardware-GPU Stress Test for CDP Page.startScreenRecording.

Options:
  --chrome=<path>        Path to Google Chrome (M153+)
  --headless             Run in --headless=new mode (default on macOS is headed to use ProMotion CVDisplayLink)
  --duration=<sec>       Recording duration per test case in seconds (default: 4.0)
  --out-dir=<path>       Directory to persist recorded .mp4 files for mpv/ffprobe inspection
  -h, --help             Show this help message
`);
    return;
  }

  const getFlagVal = (flag: string): string | undefined => {
    const exact = args.find((a) => a.startsWith(flag + '='));
    if (exact) return exact.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) {
      return args[idx + 1];
    }
    return undefined;
  };

  const explicitChrome = getFlagVal('--chrome');
  const headless = args.includes('--headless');
  const rawDuration = getFlagVal('--duration');
  const duration = rawDuration ? parseFloat(rawDuration) : 4.0;
  const outDir = getFlagVal('--out-dir');

  const chromeBin = await findChrome(explicitChrome);
  if (outDir) {
    await mkdir(outDir, {recursive: true});
  }

  console.log(`[*] Chrome binary: ${chromeBin}`);
  console.log(`[*] Host OS: ${platform()} (${process.arch}) | Mode: ${headless ? 'Headless' : 'Headed (ProMotion CVDisplayLink + Hardware GPU)'}\n`);

  const cases: TestCase[] = [
    { label: '1080p @ 60fps (Native VSync)', width: 1920, height: 1080, fps: 60, uncap: false },
    { label: '1080p @ 90fps (Native ProMotion VSync)', width: 1920, height: 1080, fps: 90, uncap: false },
    { label: '1080p @ 90fps (Uncapped VSync)', width: 1920, height: 1080, fps: 90, uncap: true },
    { label: '1080p @ 120fps (Native ProMotion VSync)', width: 1920, height: 1080, fps: 120, uncap: false },
    { label: '1080p @ 120fps (Uncapped VSync)', width: 1920, height: 1080, fps: 120, uncap: true },
    { label: '1440p @ 60fps (Native VSync)', width: 2560, height: 1440, fps: 60, uncap: false },
    { label: '4K (3840x2160) @ 30fps (Native VSync)', width: 3840, height: 2160, fps: 30, uncap: false },
    { label: '4K (3840x2160) @ 60fps (Native VSync)', width: 3840, height: 2160, fps: 60, uncap: false },
    { label: '4K (3840x2160) @ 60fps (Uncapped VSync)', width: 3840, height: 2160, fps: 60, uncap: true },
  ];

  const rows: Array<{label: string; fps: number; m: BarcodeMetrics}> = [];
  for (const c of cases) {
    console.log(`Running ${c.label}...`);
    let savePath: string | undefined;
    if (outDir) {
      const slug = c.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      savePath = join(outDir, `${slug}.mp4`);
    }
    const m = await runCase(chromeBin, headless, c.width, c.height, c.fps, c.uncap, duration, savePath);
    rows.push({label: c.label, fps: c.fps, m});
    console.log(`  -> rAF: ${m.in_page_raf_fps} fps | Container: ${m.container_fps} fps | True Unique Visual: ${m.unique_visual_fps} fps | Finalize: ${m.finalize_ms} ms\n`);
  }

  console.log('\n### Markdown Results Table\n');
  console.log('| Test Case | Target FPS | In-Page `rAF` FPS | Container FPS | **True Unique Visual FPS** | Duplicate Frames | Finalize Latency | Size (4s MP4) |');
  console.log('| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');
  for (const {label, fps, m} of rows) {
    console.log(
      `| ${label} | ${fps} | ${m.in_page_raf_fps} | ${m.container_fps} |` +
      ` **${m.unique_visual_fps}** (${m.unique_frames}/${m.container_frames}) |` +
      ` ${m.duplicate_pct}% | ${m.finalize_ms} ms | ${m.size_kb} KB |`
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli().catch((err: Error) => {
    console.error(err);
    process.exit(1);
  });
}
