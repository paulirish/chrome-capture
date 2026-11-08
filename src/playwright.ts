/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Playwright (`playwright` / `playwright-core` / `@playwright/test`) integration for 60-120fps / 4K
 * native CDP `Page.startScreenRecording`.
 *
 * Usage with Playwright Library:
 *   import {startRecording} from 'chrome-capture/playwright';
 *   const recording = await startRecording(page, {frameRate: 60, audio: true});
 *   await page.goto('https://example.com');
 *   const mp4 = await recording.stop('out.mp4');
 *
 * Usage with @playwright/test:
 *   import {test as base} from '@playwright/test';
 *   import {screenRecordingFixture} from 'chrome-capture/playwright';
 *
 *   export const test = base.extend({
 *     recordVideo60fps: screenRecordingFixture({auto: true, frameRate: 60}),
 *   });
 */

import type {Page} from 'playwright-core';
import {
  startRecording,
  type ActiveRecording,
  type PlaywrightPageLike,
  type ScreenRecordingOptions,
} from './index.ts';

export * from './index.ts';

export interface PlaywrightFixtureTestInfoLike {
  outputPath(...pathSegments: string[]): string;
  attach(
    name: string,
    options: {
      path?: string;
      body?: Buffer;
      contentType?: string;
    },
  ): Promise<void>;
}

export interface ScreenRecordingFixtureOptions extends ScreenRecordingOptions {
  auto?: boolean;
  fileName?: string;
  attachmentName?: string;
}

export interface ScreenRecordingController {
  start(options?: ScreenRecordingOptions): Promise<ActiveRecording>;
  stop(outPath?: string): Promise<Buffer | undefined>;
}

/**
 * Fixture factory for `@playwright/test`'s `test.extend()`.
 * Automatically manages high-framerate tab recording lifecycle and attaches MP4s to test reports.
 */
export function screenRecordingFixture(
  defaultOptions: ScreenRecordingFixtureOptions = {},
): [
  (
    fixtures: {page: Page | PlaywrightPageLike},
    use: (controller: ScreenRecordingController) => Promise<void>,
    testInfo: PlaywrightFixtureTestInfoLike,
  ) => Promise<void>,
  {auto: boolean},
] {
  const isAuto = defaultOptions.auto ?? false;

  const fixtureFn = async (
    {page}: {page: Page | PlaywrightPageLike},
    use: (controller: ScreenRecordingController) => Promise<void>,
    testInfo: PlaywrightFixtureTestInfoLike,
  ): Promise<void> => {
    let active: ActiveRecording | undefined;

    const controller: ScreenRecordingController = {
      async start(opts = {}): Promise<ActiveRecording> {
        if (active) {
          await active.stop();
        }
        active = await startRecording(page, {...defaultOptions, ...opts});
        return active;
      },
      async stop(outPath?: string): Promise<Buffer | undefined> {
        if (!active) return undefined;
        const res = await active.stop(outPath);
        active = undefined;
        return res;
      },
    };

    if (isAuto) {
      active = await startRecording(page, defaultOptions);
    }

    try {
      await use(controller);
    } finally {
      if (active) {
        const fileName = defaultOptions.fileName ?? 'recording-60fps.mp4';
        const targetPath = testInfo.outputPath(fileName);
        const mp4 = await active.stop(targetPath);
        active = undefined;
        if (mp4.byteLength > 0) {
          await testInfo.attach(defaultOptions.attachmentName ?? 'video-60fps', {
            path: targetPath,
            contentType: 'video/mp4',
          });
        }
      }
    }
  };

  return [fixtureFn, {auto: isAuto}];
}
