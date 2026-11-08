/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Clean programmatic Puppeteer screen recording example.
 *
 * Usage:
 *   node examples/puppeteer.ts
 */

import puppeteer from 'puppeteer-core';
import {findChromeBinary, startRecording} from '../src/index.ts';

const browser = await puppeteer.launch({
  executablePath: await findChromeBinary(),
  headless: false,
  defaultViewport: {width: 1280, height: 720},
});

try {
  const page = (await browser.pages())[0] ?? (await browser.newPage());

  console.log('[*] Starting 60fps recording with await using...');
  await using recording = await startRecording(page, {
    frameRate: 60,
    audio: true,
    outputPath: 'puppeteer-demo.mp4',
  });

  await page.goto('https://paulirish.github.io/chrome-capture-60fps/', {waitUntil: 'domcontentloaded'});
  await new Promise(r => setTimeout(r, 3000));

  const mp4 = await recording.stop();
  console.log(`[+] Saved puppeteer-demo.mp4 (${mp4.byteLength.toLocaleString()} bytes)`);
} finally {
  await browser.close();
}
