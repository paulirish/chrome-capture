# chrome-capture-60fps

60-120fps (up to 4K) tab video + 48kHz Opus loopback audio capture from Chrome M153+ via native CDP [`Page.startScreenRecording`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreenRecording).

## Background: Why browser automation video is stuck at 25-30fps

For the last decade, video recording in Playwright (`newContext({ recordVideo })`) and Puppeteer (`page.screencast()`) has been built on [`Page.startScreencast`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast). That API was built in ~2013 so DevTools could render a low-fps remote preview of a USB-tethered Android phone on your desktop. It was never meant for high-framerate video capture:

- Chrome encodes every frame as a still JPEG (`q=90`), base64-encodes it into JSON, sends it over the CDP WebSocket (10.5 MB of JSON for a 6s clip), and waits for a `Page.screencastFrameAck` round-trip before sending the next frame.
- Playwright throttles those ACKs to a 35ms floor (`screencast.js`), hardcodes `const fps = 25` (`videoRecorder.js`), pads time gaps by writing duplicate JPEG buffers in a loop, and pipes them into a single-threaded `ffmpeg -threads 1 -c:v libvpx -b:v 1M -an` subprocess.
- When you close the context, `context.close()` stalls for 4 to 20 seconds while single-threaded `ffmpeg` chews through the JPEG backlog. And there's no audio (`-an`).

### What landed in Chrome M153 (2026)

To support the [WebDriver BiDi screen recording proposal](https://github.com/w3c/webdriver-bidi/pull/1069) and agentic workflows without requiring a local `ffmpeg` binary, Chrome M153 landed native video recording in CDP: [`Page.startScreenRecording`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreenRecording) ([crrev.com/c/7736461](https://chromium-review.googlesource.com/c/chromium/src/+/7736461), [`page_handler.cc`](https://source.chromium.org/chromium/chromium/src/+/main:content/browser/devtools/protocol/page_handler.cc)).

Instead of shipping base64 JPEGs over WebSocket into `ffmpeg`, Chrome's Viz compositor (`FrameSinkVideoCapturer`) passes shared-memory `I420` frames and `LoopbackAudioInputIPC` tab audio directly to an out-of-process utility encoder (`devtools_media_encoding_server`) that writes **AV1 video + 48kHz stereo Opus audio** straight into an `.mp4`.

What that unlocks (see [Benchmarks](#benchmarks) below):
- **60-120fps up to 4K**: Sustains `1080p @ 120.2 fps` and `4K @ 60.2 fps` true unique rendered frames/sec with 1,652x less live WebSocket chatter (6.5 KB vs 10.5 MB) and **226x faster finalization** (17ms vs 3.8s at 800p; 91ms vs 20.5s at 4K).
- **Native tab audio in headless mode**: Captures 48kHz stereo Opus loopback audio directly from the tab in `--headless=new` (no `Xvfb` or PulseAudio virtual sinks required).
- **Start and stop anywhere**: Recording is a two-line CDP call rather than tied to `BrowserContext` creation/destruction, so you can log in or warm up the page first, record just the interaction, and survive cross-origin navigations.
- **Full-range Display P3 color & zero-damage VFR**: Preserves wide-gamut metadata (`pc/iec61966-2-1/smpte432`), emits 0 packets while the UI is static, and wakes up on the very first damaged `requestAnimationFrame` tick.

*(Status in frameworks today: Playwright still uses `Page.startScreencast` exclusively. Puppeteer 25+ deprecated `page.screencast()` and added an `@experimental` `page.record()` wrapper around `Page.startScreenRecording`, though it defaults to 30fps unless you pass `frameRate: 60` and doesn't yet expose `captureArea`.)*

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

`startRecording(target, options)` accepts a Playwright `Page`, a Puppeteer `Page`, or a raw CDP session. It defaults to `frameRate: 60` and supports `await using` (`Symbol.asyncDispose`), so the stream is flushed, written to disk, and detached when the block exits:

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
