/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {CdpScreenRecorder, parseDuration} from '../capture-cdp.js';

describe('parseDuration', () => {
  it('parses milliseconds, seconds, and shorthand numbers', () => {
    assert.equal(parseDuration(undefined, 3000), 3000);
    assert.equal(parseDuration('3000ms'), 3000);
    assert.equal(parseDuration('4.5s'), 4500);
    assert.equal(parseDuration('5'), 5000);
    assert.equal(parseDuration(2500), 2500);
  });
});

describe('CdpScreenRecorder', () => {
  it('starts Page.startScreenRecording at 60fps default and drains IO.read chunks on stop()', async () => {
    /** @type {Array<{method: string, params: Record<string, unknown>}>} */
    const calls = [];
    const chunks = [
      {data: Buffer.from('ftypmp42').toString('base64'), base64Encoded: true, eof: false},
      {data: Buffer.from('-av01-opus').toString('base64'), base64Encoded: true, eof: true},
    ];
    let readIdx = 0;

    const fakeSession = {
      async send(method, params = {}) {
        calls.push({method, params});
        if (method === 'Page.startScreenRecording') {
          return {stream: 'stream-42'};
        }
        if (method === 'Page.stopScreenRecording') {
          return {stream: 'stream-42'};
        }
        if (method === 'IO.read') {
          return chunks[readIdx++];
        }
        if (method === 'IO.close') {
          return {};
        }
        throw new Error(`Unexpected CDP call: ${method}`);
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
});
