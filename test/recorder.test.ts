/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, it} from 'node:test';
import type {ProtocolMapping} from 'devtools-protocol/types/protocol-mapping.js';
import {
  CdpScreenRecorder,
  type CdpSessionLike,
  parseDuration,
  type PlaywrightPageLike,
  type PuppeteerPageLike,
  startRecording,
} from '../src/index.ts';
import {screenRecordingFixture} from '../src/playwright.ts';
import {decodeBarcodeScanline} from '../benchmarks/stress-test-barcode.ts';

function createMockSession(opts: {
  streamId?: string;
  payload?: string;
  chunks?: Array<{data: string; base64Encoded: boolean; eof: boolean}>;
  ioCloseError?: boolean;
} = {}): CdpSessionLike & {
  detach(): Promise<void>;
  calls: Array<{method: string; params: object | undefined}>;
  detached: number;
} {
  let readIdx = 0;
  const mock = {
    calls: [] as Array<{method: string; params: object | undefined}>,
    detached: 0,
    async send<K extends keyof ProtocolMapping.Commands>(
      method: K,
      ...params: ProtocolMapping.Commands[K]['paramsType']
    ): Promise<ProtocolMapping.Commands[K]['returnType']> {
      mock.calls.push({method, params: params[0] as object | undefined});
      if (method === 'Page.startScreenRecording' || method === 'Page.stopScreenRecording') {
        return {stream: opts.streamId ?? 'stream-mock'} as ProtocolMapping.Commands[K]['returnType'];
      }
      if (method === 'IO.read') {
        if (opts.chunks) {
          return opts.chunks[readIdx++] as ProtocolMapping.Commands[K]['returnType'];
        }
        return {
          data: Buffer.from(opts.payload ?? 'mock-mp4').toString('base64'),
          base64Encoded: true,
          eof: true,
        } as ProtocolMapping.Commands[K]['returnType'];
      }
      if (method === 'IO.close') {
        if (opts.ioCloseError) throw new Error('IO.close failed');
        return {} as ProtocolMapping.Commands[K]['returnType'];
      }
      return {} as ProtocolMapping.Commands[K]['returnType'];
    },
    async detach(): Promise<void> {
      mock.detached++;
    },
  };
  return mock;
}

describe('parseDuration', () => {
  it('parses milliseconds, seconds, and shorthand numbers', async (t) => {
    const validCases: Array<[string | number | undefined, number]> = [
      [undefined, 3000],
      ['3000ms', 3000],
      ['4.5s', 4500],
      ['5', 5000],
      [2500, 2500],
      [30, 30000],
      [500, 500000],
      ['1500', 1500],
    ];
    for (const [input, expected] of validCases) {
      await t.test(`parses ${String(input)} -> ${expected}ms`, () => {
        assert.equal(parseDuration(input, 3000), expected);
      });
    }
  });

  it('throws on invalid or unparseable duration values', async (t) => {
    for (const invalid of ['invalid', '0s', -10, NaN]) {
      await t.test(`rejects ${String(invalid)}`, () => {
        assert.throws(() => parseDuration(invalid), /Invalid duration value/);
      });
    }
  });
});

describe('decodeBarcodeScanline', () => {
  it('decodes 16-bit binary barcodes correctly from synthetic scanlines', async (t) => {
    const makeScanline = (frameId: number, blockW = 24): Uint8Array => {
      const pixels = new Uint8Array(18 * blockW);
      pixels.fill(255, 0, blockW);
      pixels.fill(0, blockW, 2 * blockW);
      for (let b = 0; b < 16; b++) {
        const bit = (frameId >> (15 - b)) & 1;
        pixels.fill(bit ? 255 : 0, (b + 2) * blockW, (b + 3) * blockW);
      }
      return pixels;
    };

    for (const id of [0x0001, 0xCAFE, 0xFFFF, 0x0000]) {
      await t.test(`decodes 0x${id.toString(16).padStart(4, '0')}`, () => {
        assert.equal(decodeBarcodeScanline(makeScanline(id)), id);
      });
    }
  });

  it('rejects scanlines with invalid calibration guards or truncated lengths', () => {
    const blockW = 24;
    const truncated = new Uint8Array(10 * blockW);
    assert.equal(decodeBarcodeScanline(truncated), null);

    const badWhite = new Uint8Array(18 * blockW);
    badWhite.fill(120, 0, blockW);
    badWhite.fill(0, blockW, 2 * blockW);
    assert.equal(decodeBarcodeScanline(badWhite), null);

    const badBlack = new Uint8Array(18 * blockW);
    badBlack.fill(255, 0, blockW);
    badBlack.fill(130, blockW, 2 * blockW);
    assert.equal(decodeBarcodeScanline(badBlack), null);
  });
});

describe('CdpScreenRecorder', () => {
  it('starts Page.startScreenRecording at 60fps default and drains IO.read chunks on stop()', async () => {
    const fakeSession = createMockSession({
      streamId: 'stream-42',
      chunks: [
        {data: Buffer.from('ftypmp42').toString('base64'), base64Encoded: true, eof: false},
        {data: Buffer.from('-av01-opus').toString('base64'), base64Encoded: true, eof: true},
      ],
    });

    const recorder = new CdpScreenRecorder(fakeSession);
    const handle = await recorder.start({
      maxWidth: 1920,
      maxHeight: 1080,
      audio: true,
      outputPath: '/tmp/stripped-from-cdp-wire.mp4',
    });
    assert.equal(handle, 'stream-42');
    assert.deepEqual(fakeSession.calls[0], {
      method: 'Page.startScreenRecording',
      params: {frameRate: 60, maxWidth: 1920, maxHeight: 1080, audio: true},
    });

    const mp4 = await recorder.stop();
    assert.equal(mp4.toString('utf8'), 'ftypmp42-av01-opus');
    assert.equal(fakeSession.calls.at(-1)?.method, 'IO.close');
  });

  it('safely handles IO.close failure without masking errors during stop()', async () => {
    const recorder = new CdpScreenRecorder(createMockSession({payload: 'chunk', ioCloseError: true}));
    await recorder.start();
    const mp4 = await recorder.stop();
    assert.equal(mp4.toString('utf8'), 'chunk');
  });
});

describe('startRecording & asyncDispose', () => {
  it('supports universal target recording (Playwright, Puppeteer, CDP), idempotent stop, and Symbol.asyncDispose', async () => {
    const pwSession = createMockSession({payload: 'universal-mp4'});
    const pwPage: PlaywrightPageLike = {
      context: () => ({newCDPSession: async () => pwSession}),
    };

    let resultBuf: Buffer | undefined;
    {
      await using rec = await startRecording(pwPage, {frameRate: 60});
      const firstStop = await rec.stop();
      assert.equal(firstStop.toString('utf8'), 'universal-mp4');
      const secondStop = await rec.stop();
      assert.equal(secondStop.toString('utf8'), 'universal-mp4');
      resultBuf = secondStop;
    }
    assert.equal(resultBuf.toString('utf8'), 'universal-mp4');
    assert.equal(pwSession.detached, 1);

    const pptrSession = createMockSession({payload: 'pptr-mp4'});
    const pptrPage: PuppeteerPageLike = {
      createCDPSession: async () => pptrSession,
    };
    const pptrRec = await startRecording(pptrPage, {frameRate: 120});
    assert.equal((await pptrRec.stop()).toString('utf8'), 'pptr-mp4');
    assert.equal(pptrSession.detached, 1);

    const rawSession = createMockSession({payload: 'raw-cdp-mp4'});
    const tempDir = await mkdtemp(join(tmpdir(), 'rec-unit-'));
    const outPath = join(tempDir, 'nested', 'out.mp4');
    try {
      {
        await using rec = await startRecording(rawSession, {outputPath: outPath});
        await rec.stop();
      }
      const onDisk = await readFile(outPath, 'utf8');
      assert.equal(onDisk, 'raw-cdp-mp4');
      assert.equal(rawSession.detached, 0);
    } finally {
      await rm(tempDir, {recursive: true, force: true});
    }
  });
});

describe('screenRecordingFixture', () => {
  it('manages fixture lifecycle and attaches recording to testInfo', async () => {
    const pwPage: PlaywrightPageLike = {
      context: () => ({newCDPSession: async () => createMockSession({payload: 'fixture-mp4'})}),
    };

    const attachments: Array<{name: string; path?: string; contentType?: string}> = [];
    const fakeTestInfo = {
      outputPath: (name: string) => `/tmp/test-out/${name}`,
      attach: async (name: string, opts: {path?: string; contentType?: string}) => {
        attachments.push({name, ...opts});
      },
    };

    const [fixtureFn, meta] = screenRecordingFixture({auto: true, frameRate: 60});
    assert.equal(meta.auto, true);

    let executed = false;
    await fixtureFn({page: pwPage}, async (_controller) => {
      executed = true;
    }, fakeTestInfo);

    assert.equal(executed, true);
    assert.deepEqual(attachments, [
      {
        name: 'video-60fps',
        path: '/tmp/test-out/recording-60fps.mp4',
        contentType: 'video/mp4',
      },
    ]);
  });
});
