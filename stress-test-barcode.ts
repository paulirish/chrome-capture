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

import {spawnSync} from 'node:child_process';
import {readFileSync, statSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {platform} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import type {Protocol} from 'devtools-protocol';
import {
  CdpScreenRecorder,
  connectCdpSession,
  findChromeBinary,
  launchChrome,
} from './capture-cdp.ts';

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

/**
 * Re-export `findChromeBinary` as `findChrome` for backward-compatible imports.
 */
export const findChrome = findChromeBinary;

/**
 * Rich Visual Diagnostic Canvas HTML loaded from standalone `barcode-canvas.html`.
 *
 * HARD INVARIANT:
 * The top-left 16-bit binary pixel barcode consists of 18 blocks of 24x32 pixels at (0, 0):
 * - Block 0 (x=0..24): #ffffff (white reference clock)
 * - Block 1 (x=24..48): #000000 (black reference clock)
 * - Blocks 2..17 (x=48..432): bits 15..0 (MSB to LSB) of the monotonic rAF frame index `f`.
 * This layout is sampled at y=12 by `ffmpeg -vf crop=432:8:0:12,format=gray` and `benchmarks/analyze_mp4.py`.
 */
export const BARCODE_CANVAS_HTML: string = readFileSync(
  new URL('./barcode-canvas.html', import.meta.url),
  'utf8',
);

/**
 * Decodes a single 18-block grayscale row scanline into its 16-bit frame index.
 * Checks white calibration guard (>= 160) at block 0 and black calibration guard (<= 96) at block 1.
 * Returns null if guards fail or scanline is invalid.
 */
export function decodeBarcodeScanline(rowPixels: Uint8Array, blockWidth = 24): number | null {
  if (rowPixels.length < 18 * blockWidth) {
    return null;
  }
  const midOffset = Math.floor(blockWidth / 2);
  const block0Val = rowPixels[midOffset];
  const block1Val = rowPixels[blockWidth + midOffset];

  // Calibration guards: block 0 (white >= 160), block 1 (black <= 96)
  if (block0Val < 160 || block1Val > 96) {
    return null;
  }

  let val = 0;
  for (let b = 0; b < 16; b++) {
    const pixelVal = rowPixels[(b + 2) * blockWidth + midOffset];
    const bit = pixelVal >= 128 ? 1 : 0;
    val = (val << 1) | bit;
  }
  return val;
}

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
  if (rawProc.status !== 0) {
    const errText = rawProc.stderr ? rawProc.stderr.toString('utf8') : `exit code ${rawProc.status}`;
    throw new Error(`ffmpeg crop extraction failed: ${errText}`);
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
  if (probeProc.status !== 0) {
    const errText = probeProc.stderr ? probeProc.stderr.toString() : `exit code ${probeProc.status}`;
    throw new Error(`ffprobe stream inspection failed: ${errText}`);
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

  const barcodes = new Set<number>();
  let dups = 0;
  let lastBarcode = -1;
  let validFrames = 0;

  for (let i = 0; i < nFrames; i++) {
    const fbuf = raw.subarray(i * stride, (i + 1) * stride);
    const rowOffset = 4 * cropW;
    const row = fbuf.subarray(rowOffset, rowOffset + cropW);
    const val = decodeBarcodeScanline(row, 24);
    if (val !== null) {
      barcodes.add(val);
      if (val === lastBarcode) {
        dups++;
      }
      lastBarcode = val;
      validFrames++;
    }
  }

  return {
    duration_sec: Math.round(dur * 100) / 100,
    container_frames: nFrames,
    container_fps: dur > 0 ? Math.round((nFrames / dur) * 10) / 10 : 0.0,
    unique_frames: barcodes.size,
    unique_visual_fps: dur > 0 ? Math.round((barcodes.size / dur) * 10) / 10 : 0.0,
    duplicate_pct: validFrames > 0 ? Math.round((100.0 * dups / validFrames) * 10) / 10 : 0.0,
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
  const launched = await launchChrome({
    explicitPath: chromeBin,
    width,
    height,
    headless,
    uncap,
    audio: false,
  });

  const outMp4 = savePath || join(launched.userDataDir, 'out.mp4');

  try {
    const pageSession = await connectCdpSession(launched.pageTargetWs);
    const {product: browserVer} = await pageSession.send('Browser.getVersion').catch(() => ({product: 'unknown'}));

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

    // Deterministically wait for 2 rAF ticks so canvas renders before recording begins
    await pageSession.send('Runtime.evaluate', {
      expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
      awaitPromise: true,
    });

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
    await launched.close();
  }
}

export async function cli(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
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

  const parsed = parseArgs({
    args: rawArgs,
    options: {
      chrome: {type: 'string'},
      headless: {type: 'boolean'},
      duration: {type: 'string'},
      'out-dir': {type: 'string'},
      help: {type: 'boolean', short: 'h'},
    },
    allowPositionals: true,
  });

  const explicitChrome = parsed.values.chrome;
  const headless = Boolean(parsed.values.headless);
  const rawDuration = parsed.values.duration;
  const duration = rawDuration ? parseFloat(rawDuration) : 4.0;
  const outDir = parsed.values['out-dir'];

  const chromeBin = await findChromeBinary(explicitChrome);
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
