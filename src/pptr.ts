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
 *   import {startRecording} from 'chrome-capture-60fps/pptr';
 *   const recording = await startRecording(page, {frameRate: 60, audio: true});
 *   await page.goto('https://example.com');
 *   const mp4 = await recording.stop('out.mp4');
 */

export * from './index.ts';
