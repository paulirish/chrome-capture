# chrome-capture

Record a Chrome tab at 60-120fps (up to 4K) straight to a AV1 `.mp4`. Tab audio too. No ffmpeg.

```bash
npx chrome-capture https://paulirish.github.io/chrome-capture/ demo.mp4 4s
```

## Chrome 153+ has a native MP4 tab recorder! 😻

For the past ~decade, [`Page.startScreencast`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast) was the only way to get video frames out of CDP. That API is from ~2013, built so DevTools could show a live preview of a USB-tethered Android. (So good!) Both Playwright (`recordVideo`) and Puppeteer (`page.screencast()`) built their video capture on top of it: Chrome JPEG-encodes each frame, base64s it into JSON over CDP, waits for an ack, and the library pipes those JPEGs into `ffmpeg`. It's served us well.

In Sept 2026… the new [`Page.startScreenRecording`](https://chromium-review.googlesource.com/c/chromium/src/+/7736461) landed. Frames go **straight from the compositor** to an out-of-process encoder over shared memory, and Chrome **writes AV1 into the mp4** as it goes (plus optional tab audio). 💅 Stopping is ~instant because the encoding is already done (no multi-second `ffmpeg` flush on `context.close()`). And you can start/stop recording whenever you want: log in, warm up the page, then record just the interaction.

**In short: It's hot. It's good. really good.**

<!-- senna-800kg-1920x1080-120fps.mp4 -->
https://github.com/user-attachments/assets/e17ffe7e-e868-40d5-adc9-df85eeb3dae8

_(Thx [github.com/Sam1983Aing/senna-800kg](https://github.com/Sam1983Aing/senna-800kg) for this Gemini Argon generation.)_

Puppeteer v25.10+ wraps this in an experimental `page.record()` (deprecating `page.screencast()`). Playwright is still on `Page.startScreencast` (plus [recent](https://github.com/microsoft/playwright/pull/42929) [upgrades](https://github.com/microsoft/playwright/pull/42752)), but I suspect they'll get on this pretty soon…

## CLI

```bash
# 720p @ 60fps for 4s, with tab audio
npx chrome-capture https://paulirish.github.io/chrome-capture/ demo.mp4 4s

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

// `page` can be a Playwright Page, a Puppeteer Page, or a CDP session!!
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

Same 6.4s UI replay (typing, clicks, drag-and-drop, scroll) at 1280x800, comparing the `Page.startScreencast` + `ffmpeg` pipeline (`recordVideo`) against `Page.startScreenRecording` (`chrome-capture` at its default 60fps) on an M4 Max. Methodology and the full numbers are in [benchmarks/README.md](./benchmarks/README.md).

| | `recordVideo` (`startScreencast`) | `chrome-capture` (`startScreenRecording`) |
| :--- | ---: | ---: |
| Output fps | 25 (up to 60) | 60 (up to 120) |
| Total wall-clock | 21s | 11s |
| Stop + finalize | 3,800ms | 17ms |
| WebSocket traffic | 10.5 MB | 450 KB |
| Final file size | 480 KB | 330 KB |
| PSNR vs. lossless screenshot | 32 dB | 34 dB |
| Audio | none | optional |

Because Chrome encodes the video in-flight instead of piping JPEGs to `ffmpeg`, stopping takes 17ms instead of 3.8s (or 91ms vs 20.5s at 4K), and the whole test finishes ~10s quicker. 

**What about bitrate and visual quality?** There's no bitrate/CRF knob (yet). Under the hood, Chrome encodes on the fly with `libaom` AV1 in realtime 1-pass VBR and scales target bitrate linearly with pixel rate (`2 Mbps` at 720p30 -> `9 Mbps` at 1080p60 -> `18 Mbps` at 1080p120 -> `72 Mbps` at 4K120). 

The **high bitrate sweet spot** is 1080p60 (`9 Mbps`) and up (bumping resolution or `frameRate` doubles as a backdoor bitrate multiplier). If you ever need lossless 1px text fidelity and only care about ~10-15fps, an offline `Page.startScreencast({format: 'png'})` -> `ffmpeg` pipeline still has a place.

### How high can it go?

Video files can lie about fps. So the stress test ([demo](https://paulirish.github.io/chrome-capture/)) draws a binary frame counter on every `requestAnimationFrame`, then decodes it back out of the mp4 to count unique frames:

<!-- barcode-1920x1080-120fps.mp4 -->
https://github.com/user-attachments/assets/67734ccb-b986-4d66-a7d4-84bf05f7af87

* **Mac (`--headless=new`)**: **4K @ 60fps** (60 unique fps). Headless Chrome still gets full Metal GPU acceleration, so 1080p, 1440p, and 4K all lock at 60fps, but headless drives `rAF` from a synthetic 60Hz timer instead of the display's `CVDisplayLink`.
* **Mac (`--headful` on 120Hz ProMotion)**: **1080p @ 120fps** and **4K @ 120fps** 😲 (`119.9 fps`, 59.8 Mbps AV1 + stereo Opus on Three.js/WebGL2 scenes in [`examples/capture-demos.ts`](./examples/capture-demos.ts)).
* **Headless Linux (no GPU / CI)**: **1080p @ 60fps** (60.4 unique fps) or **1440p @ 60fps** (~58 unique fps) on standard 60Hz vsync, and up to **1080p @ 75-83fps** if you uncap vsync (`--disable-frame-rate-limit --disable-gpu-vsync`).
* **Other setups (Windows / Linux w/ discrete GPU)**: ?

One macOS gotcha: don't pass `--disable-frame-rate-limit --disable-gpu-vsync` on a GPU-accelerated Mac. `rAF` spins at 1,600-9,800fps, floods the Metal command queue, and starves the capture readback (dropping 4K@60 to 0.3fps). Leave native vsync alone; it's what gets you to 120.
