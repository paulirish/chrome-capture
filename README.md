# chrome-capture-60fps

Record a Chrome tab at 60fps (up to 120fps, up to 4K) straight to an AV1 `.mp4`. Tab audio too, if you want it. No ffmpeg.

It's a thin wrapper around [`Page.startScreenRecording`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreenRecording), a CDP method that landed in Chrome M153. Chrome does the encoding itself and hands you back an mp4.

```bash
npx chrome-capture-60fps https://paulirish.github.io/chrome-capture-60fps/ demo.mp4 4s
```

Needs Chrome M153+ and Node 24.11+.

## Why not Playwright's `recordVideo`?

Playwright's `recordVideo` (and Puppeteer's old `page.screencast()`) sit on top of [`Page.startScreencast`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast). That API is from ~2013, built so DevTools could show a live preview of a USB-tethered Android phone. Low fps was fine for that. It was never meant to make videos.

Here's the trip each frame takes: Chrome JPEG-encodes it, base64s it into a JSON message, sends it over the CDP WebSocket, and waits for an ack before sending the next one. Playwright throttles those acks (35ms floor), pads gaps up to a hardcoded 25fps by writing duplicate JPEGs, and pipes the lot into `ffmpeg -threads 1 -c:v libvpx -an`.

So you get 25fps at best, no audio (that's the `-an`), and a `context.close()` that hangs for 4-20 seconds while ffmpeg chews through the backlog.

`Page.startScreenRecording` ([crrev.com/c/7736461](https://chromium-review.googlesource.com/c/chromium/src/+/7736461)) skips all of that. Frames go from the compositor to an out-of-process encoder over shared memory, and Chrome writes AV1 into the mp4 as it goes. Stopping is basically instant because the encoding is already done. (Gory pipeline details are in [benchmarks/README.md](./benchmarks/README.md).)

You also get to choose when recording starts and stops. Log in, warm up the page, then record just the interaction. Playwright's recording is tied to the `BrowserContext` lifetime, so you always get those blank loading frames up front.

Doesn't Puppeteer have this already? Kinda. Puppeteer 25 deprecated `page.screencast()` and added an experimental `page.record()` on top of `Page.startScreenRecording`. If you're Puppeteer-only, `page.record({frameRate: 60})` gets you most of the way. (It defaults to 30fps and doesn't expose `captureArea` yet.) Playwright still only has the old screencast path.

## CLI

```bash
# 720p @ 60fps for 4s, with tab audio
npx chrome-capture-60fps https://paulirish.github.io/chrome-capture-60fps/ demo.mp4 4s

# 4K @ 60fps, no audio
npx chrome-capture-60fps https://paulirish.github.io/chrome-capture-60fps/ 4k.mp4 5s --width=3840 --height=2160 --no-audio

# 1080p @ 120fps (needs a 120Hz display and headed Chrome, e.g. a ProMotion MacBook)
npx chrome-capture-60fps https://paulirish.github.io/chrome-capture-60fps/ 120fps.mp4 5s --fps=120 --width=1920 --height=1080 --headed

# Record the page with DevTools open next to it
npx chrome-capture-60fps https://paulirish.github.io/chrome-capture-60fps/ devtools.mp4 5s --with-devtools
```

The CLI records audio by default and runs headless on Linux, headed on macOS. `--help` for the rest.

## Playwright, Puppeteer, or raw CDP

`startRecording()` takes a Playwright `Page`, a Puppeteer `Page`, or a CDP session. It defaults to 60fps and works with `await using`, so the mp4 is written when the block exits:

```ts
import {startRecording} from 'chrome-capture-60fps';

{
  await using rec = await startRecording(page, {outputPath: 'flow.mp4'});
  await page.goto('https://paulirish.github.io/chrome-capture-60fps/');
  await page.click('a');
}
```

Want the bytes instead? `await rec.stop()` returns a `Buffer`.

Everything else passes straight through to the CDP method: `frameRate`, `maxWidth`, `maxHeight`, `captureArea`, and `audio` (48kHz stereo Opus, off by default here).

### `@playwright/test` fixture

Records every test and attaches the mp4 to the report:

```ts
import {test as base} from '@playwright/test';
import {screenRecordingFixture} from 'chrome-capture-60fps/playwright';

export const test = base.extend({
  recordVideo60fps: screenRecordingFixture({auto: true, audio: true}),
});
```

Drop `auto: true` if you'd rather call `recordVideo60fps.start()` yourself, mid-test.

### Raw CDP

```ts
import {CdpScreenRecorder, connectCdpSession} from 'chrome-capture-60fps';

const session = await connectCdpSession(pageWebSocketDebuggerUrl);
const recorder = new CdpScreenRecorder(session);

await recorder.start({maxWidth: 1920, maxHeight: 1080});
// ... do stuff
const mp4 = await recorder.stop();
session.close();
```

## Benchmarks

Same 6.4s UI replay (typing, clicks, drag-and-drop, scroll) at 1280x800, recorded both ways on an M4 Max. Methodology and the full numbers are in [benchmarks/README.md](./benchmarks/README.md).

| | Playwright `recordVideo` | chrome-capture-60fps |
| :--- | ---: | ---: |
| Output fps | 25 | 60 |
| Total wall-clock | 21.2s | 11.6s |
| Stop + finalize | 3,825ms | 17ms |
| WebSocket traffic | 10.5 MB | 449 KB |
| Final file size | 484 KB | 331 KB |
| PSNR vs. lossless screenshot | 32.3 dB | 34.8 dB |
| Audio | none | optional |

So.. 2.4x the frames, in a smaller file, at better quality, and the run finishes ~10s sooner. At 4K the gap is sillier: Playwright's stop takes 20.5s, this takes 91ms.

How high can it go? Video files can lie about fps (a 120fps container full of duplicate frames is still a 60fps video). So the stress test draws a binary frame counter on every `requestAnimationFrame`, then decodes it back out of the mp4 to count unique frames. On a 120Hz ProMotion display:

- 1080p @ 120fps: 120 unique frames/sec
- 4K @ 60fps: 60 unique frames/sec

## Don't uncap vsync on macOS

It's tempting, but don't pass `--disable-frame-rate-limit --disable-gpu-vsync` on a GPU-accelerated Mac. `rAF` spins at 1,600-9,800fps, floods the GPU command queue, and starves the capture readback. 4K@60 drops to 0.3fps. Leave native vsync alone; it's what gets you to 120.
