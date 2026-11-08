/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Clean programmatic raw CDP screen recording example.
 *
 * Usage:
 *   node examples/raw-cdp.ts
 */

import {writeFile} from 'node:fs/promises';
import {
  CdpScreenRecorder,
  connectCdpSession,
  launchChrome,
} from '../src/index.ts';

const chrome = await launchChrome({
  width: 1280,
  height: 720,
  headless: false,
  url: 'https://paulirish.github.io/chrome-capture-60fps/',
});

try {
  const session = await connectCdpSession(chrome.pageTargetWs);
  const recorder = new CdpScreenRecorder(session);

  console.log('[*] Starting 60fps CDP screen recording...');
  await recorder.start({frameRate: 60, maxWidth: 1280, maxHeight: 720, audio: true});

  await new Promise(r => setTimeout(r, 3000));

  const mp4Buffer = await recorder.stop();
  session.close();

  await writeFile('raw-cdp-demo.mp4', mp4Buffer);
  console.log(`[+] Saved raw-cdp-demo.mp4 (${mp4Buffer.byteLength.toLocaleString()} bytes)`);
} finally {
  await chrome.close();
}
