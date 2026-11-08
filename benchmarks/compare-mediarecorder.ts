#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Head-to-head MediaRecorder (getDisplayMedia({preferCurrentTab: true}) + MediaRecorder)
 * benchmark runner using the same 16-bit rAF pixel barcode diagnostic canvas workload
 * as `stress-test-barcode.ts`.
 *
 * Usage:
 *   node benchmarks/compare-mediarecorder.ts
 *   node benchmarks/compare-mediarecorder.ts --out-dir=./recordings/mediarecorder --duration=4000
 *   node benchmarks/compare-mediarecorder.ts --headless --chrome="/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
 *
 * Inspect the output files afterward with:
 *   node benchmarks/analyze-mp4.ts --dir=./recordings/mediarecorder
 */

import {mkdir, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {
  connectCdpSession,
  findChromeBinary,
  launchChrome,
  parseDuration,
} from '../src/index.ts';
import {BARCODE_CANVAS_HTML} from './stress-test-barcode.ts';

export interface MediaRecorderResult {
  b64: string;
  mimeUsed: string;
  settings: {
    width?: number;
    height?: number;
    frameRate?: number;
    displaySurface?: string;
  };
  trackTimestampsUs: number[];
  rafFps: number;
  finalizeMs: number;
}

export interface MediaRecorderTestCase {
  label: string;
  width: number;
  height: number;
  fps: number;
  mimeType: string;
  durationMs: number;
  videoBitsPerSecond?: number;
}

/**
 * Embeds MediaRecorder runner harness into BARCODE_CANVAS_HTML.
 */
function makeBenchmarkHtml(): string {
  const runnerScript = `
<script>
window.__recordTab = async ({width, height, fps, mimeType, durationMs, videoBitsPerSecond}) => {
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    throw new Error('Unsupported mimeType: ' + mimeType);
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    preferCurrentTab: true,
    video: {
      displaySurface: 'browser',
      frameRate: { ideal: fps, max: fps },
      width: { ideal: width, max: width },
      height: { ideal: height, max: height },
    },
    audio: false,
  });
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings();
  const timestamps = [];
  let readerDone = Promise.resolve();
  if ('MediaStreamTrackProcessor' in window) {
    const proc = new MediaStreamTrackProcessor({ track });
    const reader = proc.readable.getReader();
    readerDone = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        timestamps.push(value.timestamp);
        value.close();
      }
    })();
  }
  const chunks = [];
  const recOpts = { mimeType };
  if (videoBitsPerSecond) recOpts.videoBitsPerSecond = videoBitsPerSecond;
  const rec = new MediaRecorder(stream, recOpts);
  const stopped = new Promise(res => rec.addEventListener('stop', res, {once: true}));
  rec.addEventListener('dataavailable', e => { if (e.data.size > 0) chunks.push(e.data); });

  const raf0 = window.__rafCount;
  const t0 = performance.now();
  rec.start();
  await new Promise(r => setTimeout(r, durationMs));
  const t1 = performance.now();
  const raf1 = window.__rafCount;
  rec.stop();
  await stopped;
  const t2 = performance.now();

  stream.getTracks().forEach(t => t.stop());
  await readerDone.catch(() => {});

  const blob = new Blob(chunks, { type: mimeType });
  return {
    b64: new Uint8Array(await blob.arrayBuffer()).toBase64(),
    mimeUsed: rec.mimeType,
    settings,
    trackTimestampsUs: timestamps,
    rafFps: Number(((raf1 - raf0) / ((t1 - t0) / 1000)).toFixed(1)),
    finalizeMs: Number((t2 - t1).toFixed(1)),
  };
};
</script>
`;

  return BARCODE_CANVAS_HTML.replace('</body>', `${runnerScript}</body>`);
}

export async function runCase(
  chromeBin: string,
  headless: boolean,
  outDir: string,
  testCase: MediaRecorderTestCase,
): Promise<void> {
  const html = makeBenchmarkHtml();
  const server = createServer((_req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(html);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', () => r(undefined)));
  try {
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 8080;
    const targetUrl = `http://127.0.0.1:${port}/`;

    const launched = await launchChrome({
      explicitPath: chromeBin,
      width: testCase.width,
      height: testCase.height,
      headless,
      extraArgs: [
        '--auto-accept-this-tab-capture',
        '--use-fake-ui-for-media-stream',
      ],
      url: targetUrl,
    });

    try {
      const session = await connectCdpSession(launched.pageTargetWs);

      try {
        await session.send('Emulation.setDeviceMetricsOverride', {
          width: testCase.width,
          height: testCase.height,
          deviceScaleFactor: 1,
          mobile: false,
        });
      } catch {}

      await session.send('Runtime.evaluate', {
        expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
        awaitPromise: true,
      });

      const expr = `window.__recordTab(${JSON.stringify({
        width: testCase.width,
        height: testCase.height,
        fps: testCase.fps,
        mimeType: testCase.mimeType,
        durationMs: testCase.durationMs,
        videoBitsPerSecond: testCase.videoBitsPerSecond,
      })})`;

      const evalRes = await session.send('Runtime.evaluate', {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
      });

      if (evalRes.exceptionDetails) {
        throw new Error(`MediaRecorder execution error: ${JSON.stringify(evalRes.exceptionDetails)}`);
      }

      const val = evalRes.result.value as MediaRecorderResult;
      const ext = testCase.mimeType.includes('mp4') ? 'mp4' : 'webm';
      const outPath = join(outDir, `${testCase.label}.${ext}`);
      await writeFile(outPath, Buffer.from(val.b64, 'base64'));
      await writeFile(
        join(outDir, `${testCase.label}.meta.json`),
        JSON.stringify(
          {
            label: testCase.label,
            mimeUsed: val.mimeUsed,
            settings: val.settings,
            rafFps: val.rafFps,
            finalizeMs: val.finalizeMs,
            trackTimestampsCount: val.trackTimestampsUs.length,
            trackTimestampsUs: val.trackTimestampsUs,
          },
          null,
          2,
        ),
      );

      console.log(
        `${testCase.label}: saved ${outPath} (${val.mimeUsed}, ${val.settings.width}x${val.settings.height}@${val.settings.frameRate}, raf=${val.rafFps}, finalize=${val.finalizeMs}ms)`,
      );

      session.close();
    } finally {
      await launched.close();
    }
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      'out-dir': {type: 'string'},
      duration: {type: 'string'},
      chrome: {type: 'string'},
      headless: {type: 'boolean'},
      help: {type: 'boolean', short: 'h'},
    },
    allowPositionals: true,
  });

  if (parsed.values.help) {
    console.log(`Usage: node benchmarks/compare-mediarecorder.ts [options]

Options:
  --out-dir=<path>    Output directory (default: ./recordings/mediarecorder)
  --duration=<ms>     Recording duration in ms (default: 4000)
  --chrome=<path>     Path to Chrome binary
  --headless          Run in --headless=new mode
  -h, --help          Show this help message
`);
    return;
  }

  const outDir = parsed.values['out-dir'] ?? join(process.cwd(), 'recordings', 'mediarecorder');
  const durationMs = parseDuration(parsed.values.duration, 4000);
  const headless = Boolean(parsed.values.headless);
  const chromeBin = await findChromeBinary(parsed.values.chrome);

  await mkdir(outDir, {recursive: true});

  const cases: MediaRecorderTestCase[] = [
    {label: 'mr_1080p_60_vp9_default_2.5m', width: 1920, height: 1080, fps: 60, mimeType: 'video/webm; codecs=vp9', durationMs},
    {label: 'mr_1080p_60_vp9_8m', width: 1920, height: 1080, fps: 60, mimeType: 'video/webm; codecs=vp9', videoBitsPerSecond: 8_000_000, durationMs},
    {label: 'mr_1080p_120_vp9_12m', width: 1920, height: 1080, fps: 120, mimeType: 'video/webm; codecs=vp9', videoBitsPerSecond: 12_000_000, durationMs},
    {label: 'mr_1080p_120_av1_mp4_12m', width: 1920, height: 1080, fps: 120, mimeType: 'video/mp4; codecs=av01.0.04M.08', videoBitsPerSecond: 12_000_000, durationMs},
    {label: 'mr_4k_60_vp9_15m', width: 3840, height: 2160, fps: 60, mimeType: 'video/webm; codecs=vp9', videoBitsPerSecond: 15_000_000, durationMs},
  ];

  for (const c of cases) {
    try {
      await runCase(chromeBin, headless, outDir, c);
    } catch (err) {
      console.error(`FAILED ${c.label}:`, err instanceof Error ? err.message : String(err));
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: Error) => {
    console.error(err);
    process.exit(1);
  });
}
