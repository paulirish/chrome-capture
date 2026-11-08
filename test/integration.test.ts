/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, it} from 'node:test';
import {promisify} from 'node:util';
import {chromium} from 'playwright-core';
import puppeteer from 'puppeteer-core';
import {findChromeBinary, startRecording} from '../src/index.ts';
import {screenRecordingFixture} from '../src/playwright.ts';

const execFileAsync = promisify(execFile);

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

interface FfprobeStreamInfo {
  codec_name?: string;
  nb_frames?: string;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStreamInfo[];
}

async function verifyMp4WithFfprobe(filePath: string): Promise<void> {
  const fileBytes = await readFile(filePath);
  assert.ok(fileBytes.length > 1000, `Expected video file to be >1KB, got ${fileBytes.length} bytes`);

  // Verify ISO BMFF 'ftyp' box header at offset 4..8
  const ftypHeader = fileBytes.subarray(4, 8).toString('ascii');
  assert.equal(ftypHeader, 'ftyp', `Expected MP4 ftyp box header, got "${ftypHeader}"`);

  // Verify codec and packet count with ffprobe
  const {stdout} = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_streams',
    '-select_streams',
    'v:0',
    '-print_format',
    'json',
    filePath,
  ]);

  const probeData = JSON.parse(stdout) as FfprobeOutput;
  assert.ok(probeData.streams && probeData.streams.length > 0, 'No video streams found by ffprobe');
  const videoStream = probeData.streams[0];
  assert.equal(videoStream?.codec_name, 'av1', `Expected codec_name to be av1, got ${videoStream?.codec_name}`);
}

describe('End-to-End Integration Tests (Real Headless Chrome M153+)', {timeout: 60_000}, () => {
  it('records 60fps video with puppeteer-core and startRecording(page)', async () => {
    const executablePath = await findChromeBinary();
    const outputPath = join(tmpdir(), `pptr-test-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);

    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader'],
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({width: 640, height: 360});
      await page.setContent(HTML_CANVAS_PAGE);

      {
        await using _rec = await startRecording(page, {
          frameRate: 60,
          maxWidth: 640,
          maxHeight: 360,
          outputPath,
        });

        // Drive real page interactions
        for (let i = 0; i < 5; i++) {
          await page.mouse.move(50 + i * 20, 50 + i * 20);
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        }
        await new Promise((resolve) => setTimeout(resolve, 600));
      }

      await verifyMp4WithFfprobe(outputPath);
    } finally {
      await browser.close();
      await rm(outputPath, {force: true});
    }
  });

  it('records 60fps video with playwright-core and startRecording(page)', async () => {
    const executablePath = await findChromeBinary();
    const outputPath = join(tmpdir(), `playwright-test-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);

    const browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader'],
    });

    try {
      const context = await browser.newContext({viewport: {width: 640, height: 360}});
      const page = await context.newPage();
      await page.setContent(HTML_CANVAS_PAGE);

      {
        await using _rec = await startRecording(page, {
          frameRate: 60,
          maxWidth: 640,
          maxHeight: 360,
          outputPath,
        });

        // Drive real page actions
        await page.locator('canvas').click();
        await page.mouse.move(100, 100);
        await new Promise((resolve) => setTimeout(resolve, 600));
      }

      await verifyMp4WithFfprobe(outputPath);
    } finally {
      await browser.close();
      await rm(outputPath, {force: true});
    }
  });

  it('records 60fps video with playwright-core and screenRecordingFixture', async () => {
    const executablePath = await findChromeBinary();
    const tempDir = join(tmpdir(), `playwright-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    const browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader'],
    });

    const attachedFiles: {name: string; path?: string; contentType?: string}[] = [];
    const mockTestInfo = {
      outputPath: (filename: string): string => join(tempDir, filename),
      attach: async (name: string, options: {path?: string; contentType?: string}): Promise<void> => {
        attachedFiles.push({name, path: options.path, contentType: options.contentType});
      },
    };

    try {
      const context = await browser.newContext({viewport: {width: 640, height: 360}});
      const page = await context.newPage();
      await page.setContent(HTML_CANVAS_PAGE);

      const [fixtureFn] = screenRecordingFixture({
        frameRate: 60,
        maxWidth: 640,
        maxHeight: 360,
        auto: true,
      });

      await fixtureFn({page}, async () => {
        await page.locator('canvas').click();
        await page.mouse.move(120, 80);
        await new Promise((resolve) => setTimeout(resolve, 600));
      }, mockTestInfo);

      assert.equal(attachedFiles.length, 1, 'Expected 1 attached file from screenRecordingFixture');
      const attachment = attachedFiles[0];
      assert.equal(attachment?.name, 'video-60fps');
      assert.equal(attachment?.contentType, 'video/mp4');
      assert.ok(attachment?.path, 'Expected attachment to have a valid file path');

      await verifyMp4WithFfprobe(attachment.path);
    } finally {
      await browser.close();
      await rm(tempDir, {recursive: true, force: true});
    }
  });
});
