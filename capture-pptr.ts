#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Puppeteer (`puppeteer` / `puppeteer-core`) integration for 60-120fps / 4K
 * native CDP `Page.startScreenRecording`.
 *
 * Usage:
 *   node capture-pptr.ts [url] [output] [duration]
 *
 * Or import `recordWithPuppeteerPage(page, options)` in your own Puppeteer scripts:
 *   const session = await page.createCDPSession();
 *   const recorder = new CdpScreenRecorder(session);
 *   await recorder.start({frameRate: 60, maxWidth: 1920, maxHeight: 1080, audio: true});
 *   // ... interact with page ...
 *   const mp4 = await recorder.stop();
 */

import {writeFile} from 'node:fs/promises';
import {platform} from 'node:os';
import {fileURLToPath} from 'node:url';
import type {Page} from 'puppeteer-core';
import {
  CdpScreenRecorder,
  type CdpSessionLike,
  findChromeBinary,
  parseDuration,
  type ScreenRecordingOptions,
} from './capture-cdp.ts';

export interface PuppeteerPageLike {
  createCDPSession(): Promise<CdpSessionLike & {detach(): Promise<void>}>;
}

/**
 * Attaches a `CdpScreenRecorder` to a Puppeteer `Page` via `page.createCDPSession()`.
 */
export async function createPuppeteerRecorder(
  page: Page | PuppeteerPageLike,
  options: ScreenRecordingOptions = {},
): Promise<{
  recorder: CdpScreenRecorder;
  stop: () => Promise<Buffer>;
}> {
  const cdpSession = await (page as PuppeteerPageLike).createCDPSession();
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
  const outPath = args[1] ?? 'pptr-60fps.mp4';
  const durationMs = parseDuration(args[2], 3000);
  const width = 1280;
  const height = 720;
  const frameRate = 60;

  const {default: puppeteer} = await import('puppeteer-core');
  const executablePath = await findChromeBinary();
  const browser = await puppeteer.launch({
    executablePath,
    headless: platform() !== 'darwin',
    defaultViewport: {width, height},
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
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.goto(url, {waitUntil: 'domcontentloaded'});

    const {stop} = await createPuppeteerRecorder(page, {
      frameRate,
      maxWidth: width,
      maxHeight: height,
      audio: true,
    });

    await new Promise(r => setTimeout(r, durationMs));
    const mp4Buffer = await stop();
    await writeFile(outPath, mp4Buffer);
    console.log(`[Puppeteer] Saved ${outPath} (${mp4Buffer.byteLength.toLocaleString()} bytes, ${width}x${height} @ ${frameRate}fps)`);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli();
}
