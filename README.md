# chrome-capture

Record a Chrome tab at 60-120fps (up to 4K) straight to an AV1 `.mp4`. Tab audio too, if you want it. No ffmpeg.

```bash
npx chrome-capture https://paulirish.github.io/chrome-capture/ demo.mp4 4s
```

## Brand new Sept 2026 goodness

Until recently, [`Page.startScreencast`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast) was the only way to get video frames out of CDP. That API is from ~2013, built so DevTools could show a live preview of a USB-tethered Android phone. Both Playwright (`recordVideo`) and Puppeteer (`page.screencast()`) built their video capture on top of it: Chrome JPEG-encodes each frame, base64s it into a JSON message over the CDP WebSocket, waits for an ack, and the library pipes those JPEGs into `ffmpeg`.

In Sept 2026, [`Page.startScreenRecording`](https://chromium-review.googlesource.com/c/chromium/src/+/7736461) landed in Chrome M153. Frames go straight from the compositor to an out-of-process encoder over shared memory, and Chrome writes AV1 (plus optional tab audio) into the mp4 as it goes. Stopping is basically instant because the encoding is already done (no multi-second `ffmpeg` flush on `context.close()`). And you can start/stop recording whenever you want: log in, warm up the page, then record just the interaction.

If you're using Puppeteer (v25+), they deprecated `page.screencast()` and added an experimental `page.record()` on top of `Page.startScreenRecording`. `page.record({frameRate: 60})` gets you most of the way there (it defaults to 30fps and doesn't expose `captureArea` yet). Playwright is still on `Page.startScreencast` (they recently landed [`maxFramesInFlight`](https://github.com/microsoft/playwright/pull/42929) and [custom fps](https://github.com/microsoft/playwright/pull/42752) for screencast, with no open issue tracking `Page.startScreenRecording` yet).

## CLI

```bash
# 720p @ 60fps for 4s, with tab audio
npx chrome-capture https://paulirish.github.io/chrome-capture/ demo.mp4 4s

# 4K @ 60fps, no audio
npx chrome-capture https://paulirish.github.io/chrome-capture/ 4k.mp4 5s --width=3840 --height=2160 --no-audio

# 1080p @ 120fps (needs a 120Hz display and headful Chrome, e.g. a ProMotion MacBook)
npx chrome-capture https://paulirish.github.io/chrome-capture/ 120fps.mp4 5s --fps=120 --width=1920 --height=1080 --headful

# Record the page with DevTools open next to it
npx chrome-capture https://paulirish.github.io/chrome-capture/ devtools.mp4 5s --with-devtools
```

The CLI records audio by default and runs headless (`--headless=new`) for `<= 60fps`, automatically switching to `--headful` on macOS when `--fps > 60` so Chrome can lock onto ProMotion's 120Hz `CVDisplayLink`. `--help` for the rest.

## Playwright, Puppeteer, or raw CDP

`startRecording()` takes a Playwright `Page`, a Puppeteer `Page`, or a CDP session. It defaults to 60fps and works with `await using`, so the mp4 is written when the block exits:

```ts
import {startRecording} from 'chrome-capture';

{
  await using rec = await startRecording(page, {
    outputPath: 'flow.mp4',   // optional: omit to get a Buffer from rec.stop()
    frameRate: 60,            // default: 60 (up to 120 on a 120Hz display)
    maxWidth: 1280,           // default: 1280
    maxHeight: 720,           // default: 720
    captureArea: 'target',    // 'target' (viewport) or 'browserWindow'
    audio: false,             // 48kHz stereo Opus tab audio
  });
  await page.goto('https://paulirish.github.io/chrome-capture/');
  await page.click('a');
}
```

### `@playwright/test` fixture

Records every test and attaches the mp4 to the report:

```ts
import {test as base} from '@playwright/test';
import {screenRecordingFixture} from 'chrome-capture/playwright';

export const test = base.extend({
  recordVideo60fps: screenRecordingFixture({auto: true, audio: true}),
});
```

(Drop `auto: true` if you'd rather call `recordVideo60fps.start()` yourself, mid-test.)

### Raw CDP

```ts
import {CdpScreenRecorder, connectCdpSession} from 'chrome-capture';

const session = await connectCdpSession(pageWebSocketDebuggerUrl);
const recorder = new CdpScreenRecorder(session);

await recorder.start({maxWidth: 1920, maxHeight: 1080});
// ... do stuff
const mp4 = await recorder.stop();
session.close();
```

## Benchmarks

Same 6.4s UI replay (typing, clicks, drag-and-drop, scroll) at 1280x800, recorded both ways on an M4 Max. Methodology and the full numbers are in [benchmarks/README.md](./benchmarks/README.md).

| | Playwright `recordVideo` | chrome-capture |
| :--- | ---: | ---: |
| Output fps | 25 | 60 |
| Total wall-clock | 21.2s | 11.6s |
| Stop + finalize | 3,825ms | 17ms |
| WebSocket traffic | 10.5 MB | 449 KB |
| Final file size | 484 KB | 331 KB |
| PSNR vs. lossless screenshot | 32.3 dB | 34.8 dB |
| Audio | none | optional |

So.. 2.4x the frames, in a smaller file, at better quality, and the run finishes ~10s sooner. At 4K the gap is sillier: Playwright's stop takes 20.5s, this takes 91ms.

### How high can it go?

Video files can lie about fps (a 120fps container full of duplicate frames is still a 60fps video). So the stress test ([demo](https://paulirish.github.io/chrome-capture/)) draws a binary frame counter on every `requestAnimationFrame`, then decodes it back out of the mp4 to count unique frames:

* **Mac (`--headless=new`)**: **4K @ 60fps** (60 unique fps). Headless Chrome still gets full Metal GPU acceleration, so 1080p, 1440p, and 4K all lock at 60fps, but headless drives `rAF` from a synthetic 60Hz timer instead of the display's `CVDisplayLink`.
* **Mac (`--headful` on 120Hz ProMotion)**: **1080p @ 120fps** and **4K @ 120fps** (`119.9 fps`, 59.8 Mbps AV1 + stereo Opus on Three.js/WebGL2 scenes in [`examples/capture-demos.ts`](./examples/capture-demos.ts)).
* **Headless Linux (no GPU, CPU-only CI/Cloudtop)**: **1080p @ 60fps** (60.4 unique fps) or **1440p @ 60fps** (~58 unique fps) on standard 60Hz vsync, and up to **1080p @ 75-83fps** if you uncap vsync (`--disable-frame-rate-limit --disable-gpu-vsync`).

One macOS gotcha: don't pass `--disable-frame-rate-limit --disable-gpu-vsync` on a GPU-accelerated Mac. `rAF` spins at 1,600-9,800fps, floods the Metal command queue, and starves the capture readback (dropping 4K@60 to 0.3fps). Leave native vsync alone; it's what gets you to 120.
