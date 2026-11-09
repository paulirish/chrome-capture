/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {access, readFile, rm} from 'node:fs/promises';
import {platform, tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, it} from 'node:test';
import {chromium} from 'playwright-core';
import puppeteer from 'puppeteer-core';
import {connectCdpSession, findChromeBinary, launchChrome, startRecording} from '../src/index.ts';
import {screenRecordingFixture} from '../src/playwright.ts';

const HTML_CANVAS_PAGE = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin: 0; background: #111; overflow: hidden; }
    canvas { display: block; width: 640px; height: 360px; }
  </style>
</head>
<body>
  <canvas id="c" width="640" height="360"></canvas>
  <script>
    const canvas = document.getElementById('c');
    const ctx = canvas.getContext('2d');
    let frame = 0;
    function render() {
      frame++;
      ctx.fillStyle = (frame % 2 === 0) ? '#ff0055' : '#00e5ff';
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect((frame * 4) % 600, 50, 40, 40);
      requestAnimationFrame(render);
    }
    requestAnimationFrame(render);
  </script>
</body>
</html>`;

async function verifyMp4(
  filePath: string,
  expected: {width?: number; height?: number; minFrames?: number; hasAudio?: boolean} = {},
): Promise<void> {
  const fileBytes = await readFile(filePath);
  assert.ok(fileBytes.length > 1000, `Expected video file to be >1KB, got ${fileBytes.length} bytes`);
  assert.equal(fileBytes.subarray(4, 8).toString('ascii'), 'ftyp', 'Expected MP4 ftyp box header');

  const stsdIdx = fileBytes.indexOf('stsd');
  assert.ok(stsdIdx !== -1, 'Expected stsd box in MP4');
  const av01Idx = fileBytes.indexOf('av01', stsdIdx);
  assert.ok(av01Idx !== -1, 'Expected av01 VisualSampleEntry inside stsd');

  const width = fileBytes.readUInt16BE(av01Idx + 28);
  const height = fileBytes.readUInt16BE(av01Idx + 30);
  assert.equal(width, expected.width ?? 640, 'MP4 video width mismatch');
  assert.equal(height, expected.height ?? 360, 'MP4 video height mismatch');

  let videoFrames = 0;
  for (let i = 0; (i = fileBytes.indexOf('tfhd', i)) !== -1; i += 4) {
    const trackId = fileBytes.readUInt32BE(i + 8);
    if (trackId === 1) {
      const trunIdx = fileBytes.indexOf('trun', i);
      assert.ok(trunIdx !== -1, 'Expected trun box after video tfhd');
      videoFrames += fileBytes.readUInt32BE(trunIdx + 8);
    }
  }
  const minFrames = expected.minFrames ?? 5;
  assert.ok(videoFrames >= minFrames, `Expected >= ${minFrames} video frames in trun, got ${videoFrames}`);

  if (expected.hasAudio) {
    assert.ok(fileBytes.indexOf('Opus', stsdIdx) !== -1, 'Expected Opus audio track in stsd');
  }
}

const LAUNCH_ARGS = [
  '--window-size=640,360',
  ...(platform() === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader'] : []),
];

describe('End-to-End Integration Tests (Real Headless Chrome M153+)', {timeout: 60_000}, () => {
  it('records 60fps video with puppeteer-core and startRecording(page)', async () => {
    const executablePath = await findChromeBinary();
    const outputPath = join(tmpdir(), `pptr-test-${Date.now()}.mp4`);
    const browser = await puppeteer.launch({executablePath, headless: true, args: LAUNCH_ARGS});

    try {
      const page = await browser.newPage();
      await page.setViewport({width: 640, height: 360});
      await page.setContent(HTML_CANVAS_PAGE);

      {
        await using _rec = await startRecording(page, {frameRate: 60, maxWidth: 640, maxHeight: 360, outputPath});
        await page.mouse.move(100, 100);
        await new Promise((resolve) => setTimeout(resolve, 600));
      }

      await verifyMp4(outputPath);
    } finally {
      await browser.close();
      await rm(outputPath, {force: true});
    }
  });

  it('records 60fps video with playwright-core and startRecording(page)', async () => {
    const executablePath = await findChromeBinary();
    const outputPath = join(tmpdir(), `playwright-test-${Date.now()}.mp4`);
    const browser = await chromium.launch({executablePath, headless: true, args: LAUNCH_ARGS});

    try {
      const page = await browser.newPage({viewport: {width: 640, height: 360}});
      await page.setContent(HTML_CANVAS_PAGE);

      {
        await using _rec = await startRecording(page, {frameRate: 60, maxWidth: 640, maxHeight: 360, outputPath});
        await page.locator('canvas').click();
        await new Promise((resolve) => setTimeout(resolve, 600));
      }

      await verifyMp4(outputPath);
    } finally {
      await browser.close();
      await rm(outputPath, {force: true});
    }
  });

  it('records 60fps video with playwright-core and screenRecordingFixture', async () => {
    const executablePath = await findChromeBinary();
    const tempDir = join(tmpdir(), `playwright-fixture-${Date.now()}`);
    const browser = await chromium.launch({executablePath, headless: true, args: LAUNCH_ARGS});
    const attachedFiles: Array<{name: string; path?: string; contentType?: string}> = [];

    try {
      const page = await browser.newPage({viewport: {width: 640, height: 360}});
      await page.setContent(HTML_CANVAS_PAGE);

      const [fixtureFn] = screenRecordingFixture({frameRate: 60, maxWidth: 640, maxHeight: 360, auto: true});
      await fixtureFn(
        {page},
        async () => {
          await page.locator('canvas').click();
          await new Promise((resolve) => setTimeout(resolve, 600));
        },
        {
          outputPath: (filename: string) => join(tempDir, filename),
          attach: async (name: string, options: {path?: string; contentType?: string}) => {
            attachedFiles.push({name, path: options.path, contentType: options.contentType});
          },
        },
      );

      assert.equal(attachedFiles.length, 1);
      assert.equal(attachedFiles[0]?.name, 'video-60fps');
      assert.equal(attachedFiles[0]?.contentType, 'video/mp4');
      assert.ok(attachedFiles[0]?.path);
      await verifyMp4(attachedFiles[0].path);
    } finally {
      await browser.close();
      await rm(tempDir, {recursive: true, force: true});
    }
  });

  it('records 60fps video + Opus audio via launchChrome(), connectCdpSession(), and raw CDP session', async () => {
    const outputPath = join(tmpdir(), `raw-cdp-test-${Date.now()}.mp4`);
    const dataUrl = `data:text/html,${encodeURIComponent(HTML_CANVAS_PAGE)}`;
    const launched = await launchChrome({
      width: 640,
      height: 360,
      url: dataUrl,
      audio: true,
      extraArgs: LAUNCH_ARGS,
    });

    try {
      const session = await connectCdpSession(launched.pageTargetWs);
      try {
        await session.send('Emulation.setDeviceMetricsOverride', {
          width: 640,
          height: 360,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 150));

        {
          await using _rec = await startRecording(session, {
            frameRate: 60,
            maxWidth: 640,
            maxHeight: 360,
            audio: true,
            outputPath,
          });
          await new Promise((resolve) => setTimeout(resolve, 600));
        }
      } finally {
        session.close();
      }

      await verifyMp4(outputPath, {width: 640, height: 360, minFrames: 5, hasAudio: true});
    } finally {
      await launched.close();
      await rm(outputPath, {force: true});
    }

    await assert.rejects(access(launched.userDataDir), 'Expected launchChrome.close() to remove temporary userDataDir');
  });
});
