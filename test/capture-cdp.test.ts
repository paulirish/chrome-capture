/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {ProtocolMapping} from 'devtools-protocol/types/protocol-mapping.js';
import {CdpScreenRecorder, type CdpSessionLike, parseDuration} from '../capture-cdp.ts';
import {createPlaywrightRecorder, type PlaywrightPageLike} from '../capture-playwright.ts';
import {createPuppeteerRecorder, type PuppeteerPageLike} from '../capture-pptr.ts';
import {BARCODE_CANVAS_HTML, decodeBarcodeScanline} from '../stress-test-barcode.ts';

describe('parseDuration', () => {
  it('parses milliseconds, seconds, and shorthand numbers', () => {
    assert.equal(parseDuration(undefined, 3000), 3000);
    assert.equal(parseDuration('3000ms'), 3000);
    assert.equal(parseDuration('4.5s'), 4500);
    assert.equal(parseDuration('5'), 5000);
    assert.equal(parseDuration(2500), 2500);
    assert.equal(parseDuration(30), 30000);
    assert.equal(parseDuration(500), 500000);
    assert.equal(parseDuration('1500'), 1500);
  });

  it('throws on invalid or unparseable duration values', () => {
    assert.throws(() => parseDuration('invalid'), /Invalid duration value/);
    assert.throws(() => parseDuration('0s'), /Invalid duration value/);
    assert.throws(() => parseDuration(-10), /Invalid duration value/);
    assert.throws(() => parseDuration(NaN), /Invalid duration value/);
  });
});

describe('decodeBarcodeScanline', () => {
  it('decodes 16-bit binary barcodes correctly from synthetic scanlines', () => {
    const makeScanline = (frameId: number, blockW = 24): Uint8Array => {
      const pixels = new Uint8Array(18 * blockW);
      // Block 0: white (255)
      pixels.fill(255, 0, blockW);
      // Block 1: black (0)
      pixels.fill(0, blockW, 2 * blockW);
      // Blocks 2..17: bits 15..0
      for (let b = 0; b < 16; b++) {
        const bit = (frameId >> (15 - b)) & 1;
        const val = bit ? 255 : 0;
        pixels.fill(val, (b + 2) * blockW, (b + 3) * blockW);
      }
      return pixels;
    };

    assert.equal(decodeBarcodeScanline(makeScanline(0x0001)), 0x0001);
    assert.equal(decodeBarcodeScanline(makeScanline(0xCAFE)), 0xCAFE);
    assert.equal(decodeBarcodeScanline(makeScanline(0xFFFF)), 0xFFFF);
    assert.equal(decodeBarcodeScanline(makeScanline(0x0000)), 0x0000);
  });

  it('rejects scanlines with invalid calibration guards or truncated lengths', () => {
    const blockW = 24;
    const truncated = new Uint8Array(10 * blockW);
    assert.equal(decodeBarcodeScanline(truncated), null);

    // Bad white guard (< 160)
    const badWhite = new Uint8Array(18 * blockW);
    badWhite.fill(120, 0, blockW); // Block 0 too dark
    badWhite.fill(0, blockW, 2 * blockW);
    assert.equal(decodeBarcodeScanline(badWhite), null);

    // Bad black guard (> 96)
    const badBlack = new Uint8Array(18 * blockW);
    badBlack.fill(255, 0, blockW);
    badBlack.fill(130, blockW, 2 * blockW); // Block 1 too bright
    assert.equal(decodeBarcodeScanline(badBlack), null);
  });
});

describe('CdpScreenRecorder', () => {
  it('starts Page.startScreenRecording at 60fps default and drains IO.read chunks on stop()', async () => {
    const calls: Array<{method: string; params: object | undefined}> = [];
    const chunks = [
      {data: Buffer.from('ftypmp42').toString('base64'), base64Encoded: true, eof: false},
      {data: Buffer.from('-av01-opus').toString('base64'), base64Encoded: true, eof: true},
    ];
    let readIdx = 0;

    const fakeSession: CdpSessionLike = {
      async send<K extends keyof ProtocolMapping.Commands>(
        method: K,
        ...params: ProtocolMapping.Commands[K]['paramsType']
      ): Promise<ProtocolMapping.Commands[K]['returnType']> {
        calls.push({method, params: params[0] as object | undefined});
        if (method === 'Page.startScreenRecording') {
          return {stream: 'stream-42'} as ProtocolMapping.Commands[K]['returnType'];
        }
        if (method === 'Page.stopScreenRecording') {
          return {stream: 'stream-42'} as ProtocolMapping.Commands[K]['returnType'];
        }
        if (method === 'IO.read') {
          return chunks[readIdx++] as ProtocolMapping.Commands[K]['returnType'];
        }
        if (method === 'IO.close') {
          return {} as ProtocolMapping.Commands[K]['returnType'];
        }
        throw new Error(`Unexpected CDP call: ${String(method)}`);
      },
    };

    const recorder = new CdpScreenRecorder(fakeSession);
    const handle = await recorder.start({maxWidth: 1920, maxHeight: 1080, audio: true});
    assert.equal(handle, 'stream-42');
    assert.deepEqual(calls[0], {
      method: 'Page.startScreenRecording',
      params: {frameRate: 60, maxWidth: 1920, maxHeight: 1080, audio: true},
    });

    const mp4 = await recorder.stop();
    assert.equal(mp4.toString('utf8'), 'ftypmp42-av01-opus');
    assert.equal(calls.at(-1)?.method, 'IO.close');
  });

  it('safely handles IO.close failure without masking errors during stop()', async () => {
    const fakeSession: CdpSessionLike = {
      async send<K extends keyof ProtocolMapping.Commands>(
        method: K,
        ..._params: ProtocolMapping.Commands[K]['paramsType']
      ): Promise<ProtocolMapping.Commands[K]['returnType']> {
        if (method === 'Page.startScreenRecording' || method === 'Page.stopScreenRecording') {
          return {stream: 'stream-err'} as ProtocolMapping.Commands[K]['returnType'];
        }
        if (method === 'IO.read') {
          return {
            data: Buffer.from('chunk').toString('base64'),
            base64Encoded: true,
            eof: true,
          } as ProtocolMapping.Commands[K]['returnType'];
        }
        if (method === 'IO.close') {
          throw new Error('IO.close failed');
        }
        throw new Error(`Unexpected CDP call: ${String(method)}`);
      },
    };

    const recorder = new CdpScreenRecorder(fakeSession);
    await recorder.start();
    const mp4 = await recorder.stop();
    assert.equal(mp4.toString('utf8'), 'chunk');
  });

  it('integrates with Puppeteer and Playwright CDPSession wrappers and detaches on stop()', async () => {
    let detached = 0;
    const makeFakeCdpSession = () => ({
      async send<K extends keyof ProtocolMapping.Commands>(
        method: K,
        ..._params: ProtocolMapping.Commands[K]['paramsType']
      ): Promise<ProtocolMapping.Commands[K]['returnType']> {
        if (method === 'Page.startScreenRecording' || method === 'Page.stopScreenRecording') {
          return {stream: 'stream-99'} as ProtocolMapping.Commands[K]['returnType'];
        }
        if (method === 'IO.read') {
          return {
            data: Buffer.from('mp4-bytes').toString('base64'),
            base64Encoded: true,
            eof: true,
          } as ProtocolMapping.Commands[K]['returnType'];
        }
        return {} as ProtocolMapping.Commands[K]['returnType'];
      },
      async detach(): Promise<void> {
        detached++;
      },
    });

    const fakePptrPage: PuppeteerPageLike = {
      createCDPSession: async () => makeFakeCdpSession(),
    };

    const pptrRec = await createPuppeteerRecorder(fakePptrPage, {frameRate: 120});
    const pptrBuf = await pptrRec.stop();
    assert.equal(pptrBuf.toString('utf8'), 'mp4-bytes');
    assert.equal(detached, 1);

    const fakePwPage: PlaywrightPageLike = {
      context: () => ({
        newCDPSession: async () => makeFakeCdpSession(),
      }),
    };

    const pwRec = await createPlaywrightRecorder(fakePwPage, {frameRate: 60});
    const pwBuf = await pwRec.stop();
    assert.equal(pwBuf.toString('utf8'), 'mp4-bytes');
    assert.equal(detached, 2);
  });
});

describe('BARCODE_CANVAS_HTML', () => {
  it('includes the 18-block 24x32 top-left barcode and diagnostic HUD components', () => {
    assert.ok(BARCODE_CANVAS_HTML.includes('const BLOCK_W = 24;'));
    assert.ok(BARCODE_CANVAS_HTML.includes('const BLOCK_H = 32;'));
    assert.ok(BARCODE_CANVAS_HTML.includes('drawStrobeDial'));
    assert.ok(BARCODE_CANVAS_HTML.includes('drawFrameTimingSparkline'));
    assert.ok(BARCODE_CANVAS_HTML.includes('drawChromaSharpness'));
  });
});
