#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command-line interface for `chrome-capture-60fps`.
 *
 * Usage:
 *   chrome-capture-60fps [url] [output] [duration] [options]
 *   node src/cli.ts https://paulirish.github.io/chrome-capture-60fps/ demo.mp4 4s
 */

import {writeFile} from 'node:fs/promises';
import {platform} from 'node:os';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import type {Protocol} from 'devtools-protocol';
import {
  CdpScreenRecorder,
  connectCdpSession,
  launchChrome,
  parseDuration,
} from './index.ts';

export async function cli(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    console.log(`Usage: chrome-capture-60fps [url] [output] [duration] [options]

Arguments:
  url                         Target page URL (default: https://paulirish.github.io/chrome-capture-60fps/)
  output                      Output MP4 file path (default: demo-60fps.mp4)
  duration                    Duration in ms or seconds (e.g. 3000, 3s, 5s) (default: 3000ms)

Options:
  --duration=<val>            Recording duration (e.g. 3000, 3s, 3000ms)
  --fps=<num>                 Target frame rate (default: 60)
  --width=<pixels>            Viewport width (default: 1280)
  --height=<pixels>           Viewport height (default: 720)
  --warmup=<ms>               Warmup delay before recording starts (default: 1000ms)
  --capture-area=<area>       'target' (tab viewport) or 'browserWindow' (default: target)
  --audio                     Enable audio track recording (default)
  --no-audio                  Disable audio track recording
  --headful                   Run in headful mode (default on macOS)
  --headless                  Run in --headless=new mode (default on Linux)
  --with-devtools             Open screencast + DevTools side-by-side in inspector.html
  --chrome=<path>             Path to Google Chrome executable
  -h, --help                  Show this help message
`);
    return;
  }

  const parsed = parseArgs({
    args: rawArgs,
    options: {
      duration: {type: 'string'},
      fps: {type: 'string'},
      frameRate: {type: 'string'},
      width: {type: 'string'},
      height: {type: 'string'},
      warmup: {type: 'string'},
      'capture-area': {type: 'string'},
      audio: {type: 'boolean'},
      'no-audio': {type: 'boolean'},
      headful: {type: 'boolean'},
      headed: {type: 'boolean'},
      headless: {type: 'boolean'},
      'with-devtools': {type: 'boolean'},
      chrome: {type: 'string'},
      url: {type: 'string'},
      out: {type: 'string'},
      output: {type: 'string'},
      help: {type: 'boolean', short: 'h'},
    },
    allowPositionals: true,
  });

  const url = parsed.values.url ?? parsed.positionals[0] ?? 'https://paulirish.github.io/chrome-capture-60fps/';
  const outPath = parsed.values.out ?? parsed.values.output ?? parsed.positionals[1] ?? 'demo-60fps.mp4';
  const rawDuration = parsed.values.duration ?? parsed.positionals[2];
  const durationMs = parseDuration(rawDuration, 3000);
  const width = parseInt(parsed.values.width ?? '1280', 10);
  const height = parseInt(parsed.values.height ?? '720', 10);
  const frameRate = parseInt(parsed.values.fps ?? parsed.values.frameRate ?? '60', 10);
  const warmupMs = parseInt(parsed.values.warmup ?? '1000', 10);
  const rawArea = parsed.values['capture-area'];
  const captureArea: Protocol.Page.StartScreenRecordingRequest['captureArea'] =
    rawArea === 'browserWindow' ? 'browserWindow' : 'target';
  const audio = parsed.values.audio ? true : !parsed.values['no-audio'];
  const headful = Boolean(parsed.values.headful || parsed.values.headed);
  const headless = parsed.values.headless || (!headful && platform() !== 'darwin');
  const withDevTools = Boolean(parsed.values['with-devtools']);
  const explicitChrome = parsed.values.chrome;

  const extraArgs = [
    '--enable-gpu-rasterization',
    '--remote-allow-origins=devtools://devtools',
  ];

  const launched = await launchChrome({
    explicitPath: explicitChrome,
    width,
    height,
    headless,
    audio,
    extraArgs,
    url,
  });

  try {
    let recordTargetWs = launched.pageTargetWs;

    if (withDevTools) {
      const wsHost = launched.pageTargetWs.replace(/^ws:\/\//, '');
      const inspectorUrl = `devtools://devtools/bundled/inspector.html?ws=${wsHost}`;
      const browserSession = await connectCdpSession(launched.browserWsUrl);
      const {targetId} = await browserSession.send('Target.createTarget', {url: inspectorUrl});
      browserSession.close();
      recordTargetWs = new URL(`/devtools/page/${targetId}`, launched.browserWsUrl).toString();
    }

    const session = await connectCdpSession(recordTargetWs);

    try {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    } catch {
      // Ignore if unsupported on target.
    }

    if (warmupMs > 0) {
      await new Promise(r => setTimeout(r, warmupMs));
    }

    const recorder = new CdpScreenRecorder(session);
    await recorder.start({
      frameRate,
      audio,
      maxWidth: width,
      maxHeight: height,
      captureArea,
    });

    await new Promise(r => setTimeout(r, durationMs));
    const mp4Buffer = await recorder.stop();
    session.close();

    await writeFile(outPath, mp4Buffer);
    console.log(`Saved ${outPath} (${mp4Buffer.byteLength.toLocaleString()} bytes, duration: ${durationMs}ms, ${width}x${height} @ ${frameRate}fps)`);
  } finally {
    await launched.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli().catch((err: Error) => {
    console.error(err);
    process.exit(1);
  });
}
