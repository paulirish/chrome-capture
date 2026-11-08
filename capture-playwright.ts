#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Playwright (`playwright` / `playwright-core`) integration for 60-120fps / 4K
 * native CDP `Page.startScreenRecording`.
 *
 * Replaces Playwright's built-in `recordVideo: {dir}` (`Page.startScreencast` JPEG pipe,
 * which is hardcoded to 25fps in `videoRecorder.js`, throttled to 35ms ACKs, and strips audio)
 * with Chromium M153+'s out-of-process AV1 + Opus MP4 stream.
 *
 * Usage:
 *   node capture-playwright.ts [url] [output] [duration]
 *
 * Or import `createPlaywrightRecorder(page, options)` in your own Playwright scripts:
 *   const {stop} = await createPlaywrightRecorder(page, {frameRate: 60, maxWidth: 1920, maxHeight: 1080, audio: true});
 *   // ... interact with page ...
 *   const mp4 = await stop();
 */

import {writeFile} from 'node:fs/promises';
import {platform} from 'node:os';
import {fileURLToPath} from 'node:url';
import type {Page} from 'playwright-core';
import {
  CdpScreenRecorder,
  type CdpSessionLike,
  findChromeBinary,
  parseDuration,
  type ScreenRecordingOptions,
} from './capture-cdp.ts';

export interface PlaywrightPageLike {
  context(): {
    newCDPSession(page: PlaywrightPageLike | Page): Promise<CdpSessionLike & {detach(): Promise<void>}>;
  };
}

/**
 * Attaches a `CdpScreenRecorder` to a Playwright `Page` via `page.context().newCDPSession(page)`.
 */
export async function createPlaywrightRecorder(
  page: Page | PlaywrightPageLike,
  options: ScreenRecordingOptions = {},
): Promise<{
  recorder: CdpScreenRecorder;
  stop: () => Promise<Buffer>;
}> {
  const cdpSession = await (page as {
    context(): {
      newCDPSession(page: Page | PlaywrightPageLike): Promise<CdpSessionLike & {detach(): Promise<void>}>;
    };
  }).context().newCDPSession(page);
  const recorder = new CdpScreenRecorder(cdpSession);
  await recorder.start(options);
  return {
    recorder,
    async stop(): Promise<Buffer> {
      try {
        return await recorder.stop();
      } finally {
        await cdpSession.detach().catch(() => {});
      }
    },
  };
}

async function cli(): Promise<void> {
  const args = process.argv.slice(2);
  const url = args[0] ?? 'https://example.com';
  const outPath = args[1] ?? 'playwright-60fps.mp4';
  const durationMs = parseDuration(args[2], 3000);
  const width = 1280;
  const height = 720;
  const frameRate = 60;

  const {chromium} = await import('playwright-core');
  const executablePath = await findChromeBinary();
  const browser = await chromium.launch({
    executablePath,
    headless: platform() !== 'darwin',
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--enable-gpu-rasterization',
      `--window-size=${width},${height}`,
    ],
  });

  try {
    const context = await browser.newContext({viewport: {width, height}});
    const page = await context.newPage();
    await page.goto(url, {waitUntil: 'domcontentloaded'});

    const {stop} = await createPlaywrightRecorder(page, {
      frameRate,
      maxWidth: width,
      maxHeight: height,
      audio: true,
    });

    await new Promise(r => setTimeout(r, durationMs));
    const mp4Buffer = await stop();
    await writeFile(outPath, mp4Buffer);
    console.log(`[Playwright] Saved ${outPath} (${mp4Buffer.byteLength.toLocaleString()} bytes, ${width}x${height} @ ${frameRate}fps)`);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli();
}
