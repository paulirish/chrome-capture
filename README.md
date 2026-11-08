# chrome-capture-60fps

60-120fps (up to 4K) tab video + 48kHz Opus loopback audio capture from Chrome M153+ via native CDP [`Page.startScreenRecording`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreenRecording).

Playwright's built-in `recordVideo` (`Page.startScreencast`) pipes base64 JPEGs over WebSocket into single-threaded `ffmpeg` with a hardcoded 25fps cap and no audio. `Page.startScreenRecording` captures frames in-browser via shared memory and encodes AV1 + Opus `.mp4` out-of-process.

## CLI

```bash
# 720p @ 60fps for 4s (with tab audio)
npx chrome-capture-60fps https://example.com demo.mp4 4s

# 1080p @ 120fps (e.g. macOS ProMotion) or 4K @ 60fps
npx chrome-capture-60fps https://example.com 120fps.mp4 --fps=120 --width=1920 --height=1080 --duration=5s

# Record the live page and DevTools panels side-by-side
npx chrome-capture-60fps https://example.com devtools.mp4 5s --with-devtools
```

## Playwright & Puppeteer (`startRecording`)

`startRecording(target, options)` accepts a Playwright `Page`, a Puppeteer `Page`, or a raw CDP session. It supports `await using` (`Symbol.asyncDispose`), so the stream is flushed, written to disk, and detached when the block exits:

```ts
import {startRecording} from 'chrome-capture-60fps';

{
  await using rec = await startRecording(page, {
    outputPath: 'flow.mp4',
    frameRate: 60,
    maxWidth: 1920,
    maxHeight: 1080,
    audio: true,
  });

  await page.goto('https://example.com');
  await page.click('a');
}
```

Or call `await rec.stop()` manually to get the MP4 `Buffer`.

### `@playwright/test` fixture

Drop 60-120fps capture into an existing Playwright test suite and auto-attach the `.mp4` to `testInfo`:

```ts
import {test as base} from '@playwright/test';
import {screenRecordingFixture} from 'chrome-capture-60fps/playwright';

export const test = base.extend({
  recordVideo60fps: screenRecordingFixture({frameRate: 60, audio: true}),
});
```

### Raw CDP (zero dependencies)

```ts
import {CdpScreenRecorder, connectCdpSession} from 'chrome-capture-60fps';

const session = await connectCdpSession(pageWebSocketDebuggerUrl);
const recorder = new CdpScreenRecorder(session);

await recorder.start({frameRate: 60, maxWidth: 1920, maxHeight: 1080, audio: true});
// ...
const mp4Buffer = await recorder.stop();
session.close();
```

## Benchmarks

From a 6.44s UI replay (`1280x800`) and 16-bit `requestAnimationFrame` pixel-barcode stress tests on macOS ProMotion (`120Hz CVDisplayLink`, M4 Max). Full numbers and methodology are in [benchmarks/README.md](./benchmarks/README.md).

| Metric | Playwright `recordVideo` | `chrome-capture-60fps` |
| :--- | :--- | :--- |
| Max real-time output | 25 fps (hardcoded in `videoRecorder.js`) | **1080p @ 120.2 fps**, **4K @ 60.2 fps** |
| Stop & finalize latency | 3,825 ms (20,467 ms at 4K) | **17 ms** (91 ms at 4K@60) |
| Live WebSocket IPC | 10.5 MB (base64 JPEGs) | **6.5 KB** (449 KB incl. final `IO.read`) |
| Visual fidelity (PSNR) | 32.28 dB (484 KB) | **34.82 dB** (331 KB, full-range Display P3) |
| Tab loopback audio | None (`-an`) | **48kHz stereo Opus** (headless & headed) |

> [!CAUTION]
> Don't pass `--disable-frame-rate-limit --disable-gpu-vsync` on hardware-accelerated macOS. Uncapping VSync spins `rAF` at 1,600-9,800 fps, saturates the Viz GPU command queue, and starves video readback (dropping 4K@60 capture to 0.3 fps). Leave native `CVDisplayLink` VSync enabled.
