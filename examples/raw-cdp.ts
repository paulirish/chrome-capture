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

import {
  connectCdpSession,
  launchChrome,
  startRecording,
} from '../src/index.ts';

const chrome = await launchChrome({
  width: 1280,
  height: 720,
  headless: false,
  url: 'https://paulirish.github.io/chrome-capture-60fps/',
});

try {
  const session = await connectCdpSession(chrome.pageTargetWs);

  console.log('[*] Starting 60fps CDP screen recording...');
  await using recording = await startRecording(session, {
    frameRate: 60,
    maxWidth: 1280,
    maxHeight: 720,
    audio: true,
    outputPath: 'raw-cdp-demo.mp4',
  });

  await new Promise(r => setTimeout(r, 3000));

  const mp4 = await recording.stop();
  console.log(`[+] Saved raw-cdp-demo.mp4 (${mp4.byteLength.toLocaleString()} bytes)`);
  session.close();
} finally {
  await chrome.close();
}
