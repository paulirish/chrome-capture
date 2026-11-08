#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * High-framerate (90-120fps) 1080p/4K showcase capture of two Gemini 4 Argon WebGL2 + Web Audio demos:
 *   1. Senna 800KG (https://sam1983aing.github.io/senna-800kg/)
 *   2. Ticket Tear (https://sam1983aing.github.io/ticket-tear/)
 *
 * Usage:
 *   node examples/capture-demos.ts
 *   node examples/capture-demos.ts --fps=120
 *   node examples/capture-demos.ts --demo=senna --fps=90
 *   node examples/capture-demos.ts --demo=ticket --fps=90
 */

import {spawnSync} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {platform} from 'node:os';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {chromium, type Page} from 'playwright-core';
import {findChromeBinary, parseDuration, startRecording} from '../src/playwright.ts';

const {values} = parseArgs({
  options: {
    demo: {type: 'string', default: 'all'},
    fps: {type: 'string', default: '90'},
    width: {type: 'string', default: '1920'},
    height: {type: 'string', default: '1080'},
    'senna-duration': {type: 'string', default: '12s'},
    'ticket-duration': {type: 'string', default: '10s'},
    'out-dir': {type: 'string', default: './recordings'},
    chrome: {type: 'string'},
    headless: {type: 'boolean'},
    headful: {type: 'boolean'},
  },
  allowPositionals: true,
});

const fps = parseInt(values.fps ?? '90', 10);
const width = parseInt(values.width ?? '1920', 10);
const height = parseInt(values.height ?? '1080', 10);
const outDir = values['out-dir'] ?? './recordings';
const headless = values.headless ? true : values.headful ? false : platform() !== 'darwin';
const demos = values.demo === 'senna' ? (['senna'] as const) : values.demo === 'ticket' ? (['ticket'] as const) : (['senna', 'ticket'] as const);

interface RafReport {
  frames: number;
  elapsedMs: number;
  avgRafFps: number;
  p50DeltaMs: number;
  p95DeltaMs: number;
}

declare global {
  interface Window {
    __ticketApp?: {
      selectTier(tier: 'silver' | 'gold' | 'ultraviolet'): void;
      toggleXRayMode(enable?: boolean): void;
      toggleFlipPass(): void;
      getEngine(): {
        resetPass(animateEntrance?: boolean): void;
        hoverTiltX: number;
        hoverTiltY: number;
        sliceSeamAtU(u: number, radiusCols?: number): number;
        triggerZipperTear(direction?: 1 | -1): void;
      };
    };
  }
}

function probeMp4(mp4Path: string) {
  const proc = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-show_packets', '-show_entries', 'packet=pts_time,codec_type:stream=codec_name,codec_type,duration:format=duration', '-of', 'json', mp4Path],
    {encoding: 'utf8', maxBuffer: 50 * 1024 * 1024},
  );
  if (proc.error || proc.status !== 0) return null;
  try {
    const data = JSON.parse(proc.stdout || '{}') as {
      streams?: Array<{codec_type?: string; codec_name?: string; duration?: string}>;
      packets?: Array<{codec_type?: string}>;
      format?: {duration?: string};
    };
    const videoStream = data.streams?.find(s => s.codec_type === 'video');
    const packets = data.packets?.filter(p => p.codec_type === 'video').length ?? 0;
    const durationSec = parseFloat(videoStream?.duration || data.format?.duration || '0');
    return {
      packets,
      durationSec: Math.round(durationSec * 100) / 100,
      containerFps: durationSec > 0 ? Math.round((packets / durationSec) * 10) / 10 : 0,
      codec: videoStream?.codec_name ?? 'unknown',
      hasAudio: data.streams?.some(s => s.codec_type === 'audio') ?? false,
    };
  } catch {
    return null;
  }
}

async function warmupDemo(page: Page, demo: 'senna' | 'ticket') {
  if (demo === 'senna') {
    console.log('  [senna] Waiting for 364k-vertex Draco GLB & 56 CFD streamlines (#loader-curtain.is-loaded)...');
    await page.waitForFunction(() => document.getElementById('loader-curtain')?.classList.contains('is-loaded') === true, undefined, {timeout: 45_000});
  } else {
    console.log('  [ticket] Waiting for HolographicTicketApp (window.__ticketApp) and web fonts...');
    await page.waitForFunction(() => typeof window.__ticketApp === 'object', undefined, {timeout: 30_000});
  }
  await page.evaluate(() => document.fonts.ready);

  console.log(`  [${demo}] Pre-warming WebGL2 shaders, textures, and Web Audio...`);
  await page.evaluate(async (isSenna: boolean) => {
    const waitFrames = (n: number) => new Promise<void>(r => {
      let c = 0;
      const step = () => (++c >= n ? r() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });

    if (isSenna) {
      const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const btnXray = document.getElementById('btn-xray');
      btnXray?.click();
      await waitFrames(4);
      for (const frac of [0, 0.22, 0.44, 0.62, 0.78, 0.96]) {
        window.scrollTo({top: frac * maxScroll, behavior: 'instant'});
        await waitFrames(6);
      }
      btnXray?.click();
      window.scrollTo({top: 0, behavior: 'instant'});
      await waitFrames(55); // Let damped smoothScroll settle back to 0.0
      const btnAudio = document.getElementById('btn-audio');
      if (btnAudio && !btnAudio.classList.contains('is-active')) btnAudio.click();
    } else {
      const app = window.__ticketApp;
      if (!app) return;
      app.selectTier('gold');
      await waitFrames(4);
      app.selectTier('ultraviolet');
      await waitFrames(4);
      app.toggleXRayMode(true);
      await waitFrames(4);
      app.toggleXRayMode(false);
      app.selectTier('silver');
      app.getEngine().resetPass(false);
      await waitFrames(30);
    }
  }, demo === 'senna');
}

async function runChoreography(page: Page, demo: 'senna' | 'ticket', durationMs: number): Promise<RafReport> {
  return page.evaluate(({isSenna, totalMs}) => new Promise<RafReport>(resolve => {
    const deltas: number[] = [];
    const startTime = performance.now();
    let lastTime = startTime;
    let frames = 0;
    let prevU = -1;
    let lastSlicedCol = -1;
    const crossed = (t: number, u: number) => prevU < t && u >= t;

    const sliderWind = document.getElementById('slider-wind-speed') as HTMLInputElement | null;
    const btnXray = document.getElementById('btn-xray');
    const btnRevPedal = document.getElementById('btn-rev-pedal');
    const swatches = Array.from(document.querySelectorAll<HTMLButtonElement>('#livery-swatch-row .livery-swatch'));
    const app = window.__ticketApp;
    const verlet = app?.getEngine();
    const stageEl = document.getElementById('canvas-stage');

    const step = (now: number) => {
      const elapsed = now - startTime;
      if (frames++ > 0) deltas.push(now - lastTime);
      lastTime = now;
      const u = Math.min(1, elapsed / totalMs);

      if (isSenna) {
        const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        window.scrollTo({top: (u - Math.sin(u * Math.PI * 2) * 0.018) * maxScroll, behavior: 'instant'});
        window.dispatchEvent(new PointerEvent('pointermove', {
          clientX: window.innerWidth * (0.5 + 0.34 * Math.sin(u * Math.PI * 4)),
          clientY: window.innerHeight * (0.5 + 0.24 * Math.sin(u * Math.PI * 8)),
          bubbles: true,
        }));

        if (crossed(0.19, u)) {
          if (sliderWind) {
            sliderWind.value = '312';
            sliderWind.dispatchEvent(new Event('input', {bubbles: true}));
          }
          document.getElementById('btn-drs-lowdrag')?.click();
        }
        if (crossed(0.37, u)) {
          document.getElementById('btn-drs-downforce')?.click();
          btnXray?.click();
        }
        if (crossed(0.50, u)) btnXray?.click();
        if (crossed(0.55, u)) btnRevPedal?.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true}));
        if (crossed(0.67, u)) window.dispatchEvent(new PointerEvent('pointerup', {bubbles: true}));
        if (crossed(0.78, u)) document.getElementById('btn-pace-brake')?.click();
        if (crossed(0.88, u)) swatches[1]?.click();
        if (crossed(0.94, u)) swatches[0]?.click();
      } else if (app && verlet && stageEl) {
        const rect = stageEl.getBoundingClientRect();
        const angle = u * Math.PI * 6;
        const normX = Math.sin(angle) * 0.72;
        const normY = Math.cos(angle * 0.75) * 0.55;

        stageEl.dispatchEvent(new PointerEvent('pointermove', {
          clientX: rect.left + rect.width * (0.5 + normX * 0.35),
          clientY: rect.top + rect.height * (0.5 + normY * 0.35),
          bubbles: true,
        }));
        verlet.hoverTiltY = normX * 0.36;
        verlet.hoverTiltX = -normY * 0.24;

        if (crossed(0.20, u)) {
          document.getElementById('btn-theme')?.click();
          app.selectTier('gold');
        }
        if (crossed(0.27, u) || crossed(0.39, u)) app.toggleFlipPass();
        if (crossed(0.46, u)) {
          app.selectTier('ultraviolet');
          app.toggleXRayMode(true);
        }
        if (u >= 0.52 && u <= 0.70) {
          const targetU = ((u - 0.52) / 0.18) * 0.52;
          const targetCol = Math.floor(targetU * 24);
          if (targetCol > lastSlicedCol) {
            lastSlicedCol = targetCol;
            verlet.sliceSeamAtU(targetU, 0.85);
          }
        }
        if (crossed(0.73, u)) app.toggleXRayMode(false);
        if (crossed(0.78, u)) verlet.triggerZipperTear(1);
      }

      prevU = u;
      if (elapsed < totalMs) {
        requestAnimationFrame(step);
        return;
      }
      if (isSenna) window.dispatchEvent(new PointerEvent('pointerup', {bubbles: true}));
      const sorted = [...deltas].sort((a, b) => a - b);
      const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
      resolve({
        frames,
        elapsedMs: Math.round(elapsed),
        avgRafFps: Math.round(((frames / elapsed) * 1000) * 10) / 10,
        p50DeltaMs: Math.round(pct(0.5) * 100) / 100,
        p95DeltaMs: Math.round(pct(0.95) * 100) / 100,
      });
    };
    requestAnimationFrame(step);
  }), {isSenna: demo === 'senna', totalMs: durationMs});
}

await mkdir(outDir, {recursive: true});
const executablePath = await findChromeBinary(values.chrome);
console.log(`[*] Chrome binary: ${executablePath}`);
console.log(`[*] Mode: ${headless ? 'Headless' : 'Headful (macOS ProMotion CVDisplayLink)'} | Target: ${width}x${height} @ ${fps}fps`);

const browser = await chromium.launch({
  executablePath,
  headless,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--enable-gpu-rasterization',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--window-size=${width},${height}`,
  ],
});

try {
  // deviceScaleFactor: 1 keeps Retina macOS from rendering a 3840x2160 (4K) WebGL2 canvas for a 1080p capture.
  const context = await browser.newContext({viewport: {width, height}, deviceScaleFactor: 1});
  const rows: string[] = [];

  for (const demo of demos) {
    const isSenna = demo === 'senna';
    const url = isSenna ? 'https://sam1983aing.github.io/senna-800kg/' : 'https://sam1983aing.github.io/ticket-tear/';
    const durationMs = parseDuration(isSenna ? values['senna-duration'] : values['ticket-duration'], isSenna ? 12_000 : 10_000);
    const outputPath = join(outDir, `${isSenna ? 'senna-800kg' : 'ticket-tear'}-${width}x${height}-${fps}fps.mp4`);

    const page = await context.newPage();
    console.log(`\n[*] Loading ${demo} (${url})`);
    await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 45_000});
    await warmupDemo(page, demo);

    console.log(`  [${demo}] Recording ${fps}fps + 48kHz Opus audio for ${(durationMs / 1000).toFixed(1)}s...`);
    await using rec = await startRecording(page, {frameRate: fps, maxWidth: width, maxHeight: height, audio: true, outputPath});
    const raf = await runChoreography(page, demo, durationMs);
    const mp4 = await rec.stop();
    await page.close();

    const c = probeMp4(outputPath);
    const sizeMb = `${(mp4.byteLength / (1024 * 1024)).toFixed(2)} MB`;
    console.log(`  [+] Saved ${outputPath} (${sizeMb}) | rAF: ${raf.avgRafFps} fps | Container: ${c ? `${c.containerFps} fps` : 'n/a'}`);
    rows.push(`| ${demo} | ${fps} | **${raf.avgRafFps} fps** | **${c ? `${c.containerFps} fps` : 'n/a'}** | ${c ? `${raf.frames} / ${c.packets}` : raf.frames} | ${raf.p50DeltaMs}ms / ${raf.p95DeltaMs}ms | ${c?.hasAudio ? 'Opus' : 'yes'} | ${sizeMb} | \`${outputPath}\` |`);
  }

  console.log('\n| Demo | Target FPS | In-Page `rAF` FPS | MP4 Container FPS | Frames (rAF / MP4) | Frame Δt (p50 / p95) | Audio | Size | Output |');
  console.log('| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |');
  for (const row of rows) console.log(row);
} finally {
  await browser.close();
}
