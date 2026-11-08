/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Clean programmatic Playwright screen recording example.
 * Shows both direct `startRecording(page)` and `@playwright/test` `screenRecordingFixture()`.
 *
 * Usage:
 *   node examples/playwright.ts
 */

import {chromium} from 'playwright-core';
import {
  findChromeBinary,
  screenRecordingFixture,
  startRecording,
} from '../src/playwright.ts';

// 1. Direct Playwright Library usage with await using
const browser = await chromium.launch({
  executablePath: await findChromeBinary(),
  headless: false,
});

try {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}});

  console.log('[*] Recording with startRecording(page)...');
  await using recording = await startRecording(page, {
    frameRate: 60,
    audio: true,
    outputPath: 'playwright-demo.mp4',
  });

  await page.goto('https://example.com', {waitUntil: 'domcontentloaded'});
  await new Promise(r => setTimeout(r, 3000));

  const mp4 = await recording.stop();
  console.log(`[+] Saved playwright-demo.mp4 (${mp4.byteLength.toLocaleString()} bytes)`);
} finally {
  await browser.close();
}

// 2. Playwright Test fixture declaration pattern (for test.extend):
// import {test as base} from '@playwright/test';
// export const test = base.extend({
//   recordVideo60fps: screenRecordingFixture({auto: true, frameRate: 60}),
// });
export const _exampleFixture = screenRecordingFixture;
