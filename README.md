# `chrome-capture-60fps`

Zero-dependency **60–120fps** (up to **4K `3840x2160`**) tab video + loopback audio capture from Chromium (M153+) using native CDP [`Page.startScreenRecording`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreenRecording) and [`Page.stopScreenRecording`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-stopScreenRecording).

Instead of piping base64 JPEGs over a WebSocket into a single-threaded `ffmpeg` subprocess (`Page.startScreencast` / Playwright `record_video_dir`, which is hard-capped at **25fps** with no audio), Chromium M153+ captures `WebContents` frames in the browser process via `viz::FrameSinkVideoCapturer` shared memory and encodes **AV1 video + 48kHz stereo Opus loopback audio** out-of-process into an `.mp4` stream (`IO.read`).

---

## Quick Start (CLI)

Requires **Node 24+** (native `.ts` execution + built-in `WebSocket`) and **Chrome / Chromium M153+**:

```bash
# 1. Raw CDP (zero runtime dependencies)
node capture-cdp.ts https://example.com demo-60fps.mp4 4s

# Record 1080p @ 120fps on a 120Hz display (e.g. macOS ProMotion)
node capture-cdp.ts https://example.com demo-120fps.mp4 --fps=120 --width=1920 --height=1080 --duration=5s

# Record 4K (3840x2160) @ 60fps
node capture-cdp.ts https://example.com demo-4k60.mp4 --fps=60 --width=3840 --height=2160 --duration=4s

# Record the live page AND Chrome DevTools panels side-by-side in one tab
node capture-cdp.ts https://example.com devtools-split.mp4 5s --with-devtools

# 2. Puppeteer CLI
node capture-pptr.ts https://example.com demo-pptr.mp4 4s

# 3. Playwright CLI
node capture-playwright.ts https://example.com demo-pw.mp4 4s
```

---

## Programmatic Usage (Playwright / Puppeteer / Raw CDP)

Strongly typed against `devtools-protocol` (`Protocol.Page.StartScreenRecordingRequest`). You can use the framework-specific helpers ([`capture-playwright.ts`](./capture-playwright.ts), [`capture-pptr.ts`](./capture-pptr.ts)) or wrap any CDP client Directly with [`CdpScreenRecorder`](./capture-cdp.ts):

### Playwright (`capture-playwright.ts`)

```ts
import {writeFile} from 'node:fs/promises';
import {createPlaywrightRecorder} from './capture-playwright.ts';

const recorder = await createPlaywrightRecorder(page, {
  frameRate: 60,     // 60, 90, or 120
  maxWidth: 1920,
  maxHeight: 1080,
  audio: true,       // 48kHz stereo Opus tab loopback audio
});

// ... drive Playwright UI interactions (survives cross-origin navigations!) ...

const mp4Buffer = await recorder.stop();
await writeFile('recording.mp4', mp4Buffer);
```

### Puppeteer (`capture-pptr.ts`)

```ts
import {writeFile} from 'node:fs/promises';
import {createPuppeteerRecorder} from './capture-pptr.ts';

const recorder = await createPuppeteerRecorder(page, {
  frameRate: 60,
  maxWidth: 1920,
  maxHeight: 1080,
  audio: true,
});

// ... drive Puppeteer UI interactions ...

const mp4Buffer = await recorder.stop();
await writeFile('recording.mp4', mp4Buffer);
```

### Raw CDP (`capture-cdp.ts`)

```ts
import {writeFile} from 'node:fs/promises';
import {CdpScreenRecorder, connectCdpSession} from './capture-cdp.ts';

const session = await connectCdpSession(pageWebSocketDebuggerUrl);
const recorder = new CdpScreenRecorder(session);

await recorder.start({frameRate: 60, maxWidth: 1920, maxHeight: 1080, audio: true});
// ...
const mp4Buffer = await recorder.stop();
await writeFile('recording.mp4', mp4Buffer);
session.close();
```

---

## How Much Better Is It?

Full architectural breakdown and benchmark tables are in **[`cdp-screen-recording-benchmarks.md`](./cdp-screen-recording-benchmarks.md)**.

### 1. Head-to-Head vs. Playwright `record_video_dir` (`1280x800`, 6.44s UI Replay)

| Metric (`1280x800` Replay) | Playwright (`record_video_dir` + `libx264`) | CDP `Page.startScreenRecording` (60fps) | Net Improvement |
| :--- | :---: | :---: | :---: |
| **Max Output Frame Rate** | Hardcoded `25 fps` (`videoRecorder.js`) | **`60–120 fps`** | **2.4x–4.8x higher frame rate** |
| **Total Wall-Clock Time** | `21.19 s` | **`11.55 s`** | **1.83x faster** (`-9.6 s`) |
| **Stop & Finalize Latency** | `3,824.5 ms` (`20,467 ms` at 4K) | **`16.9 ms`** (`90.6 ms` at 4K@60) | **226x faster finalization** |
| **Live WebSocket IPC During Capture** | `10,740.1 KB` (`10.5 MB` base64 JPEGs) | **`6.5 KB`** (`448.9 KB` incl. final `IO.read`) | **1,652x less live IPC chatter** |
| **Visual Fidelity (PSNR vs Lossless PNG)** | `32.28 dB` (`484 KB` `.mp4`) | **`34.82 dB`** (`331 KB` `.mp4`) | **+2.54 dB PSNR, 32% smaller file** |
| **Tab Loopback Audio** | None (`-an`) | **48kHz Stereo Opus** | **Works in headless & headed** |

### 2. Scaling on macOS ProMotion (`120Hz CVDisplayLink` + Apple Silicon M4 Max)

Verified with a **16-bit per-frame `requestAnimationFrame` pixel barcode** ([`stress-test-barcode.ts`](./stress-test-barcode.ts)) to measure true unique rendered frames vs. container packet counts:

| Test Case (Native ProMotion VSync) | Target FPS | In-Page `rAF` FPS | Container FPS | **True Unique Visual FPS** | `dPTS` P50 (`Stdev`) | Finalize Latency | `mpv` Drops (`display-resample`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`1080p @ 60fps`** | `60` | `114.8` | `62.5` | **`62.2 fps`** (`236/237`) | `16.65 ms` (`1.49 ms`) | **`23.7 ms`** | `1 / 0` |
| **`1080p @ 90fps`** | `90` | `120.1` | `89.6` | **`89.4 fps`** (`358/359`) | `11.10 ms` (`2.10 ms`) | **`47.6 ms`** | **`0 / 0`** |
| **`1080p @ 120fps`** | `120` | `120.1` | `120.4` | **`120.2 fps`** (`480/481`) | `8.33 ms` (**`0.45 ms`**) | **`67.2 ms`** | **`0 / 0`** |
| **`1440p @ 60fps`** | `60` | `120.0` | `60.2` | **`60.0 fps`** (`240/241`) | `16.67 ms` (`1.01 ms`) | **`43.7 ms`** | `1 / 0` |
| **`4K (3840x2160) @ 30fps`** | `30` | `119.8` | `30.4` | **`30.1 fps`** (`121/122`) | `33.33 ms` (`3.28 ms`) | **`27.3 ms`** | **`0 / 0`** |
| **`4K (3840x2160) @ 60fps`** | `60` | `120.1` | `60.5` | **`60.2 fps`** (`241/242`) | `16.65 ms` (`1.26 ms`) | **`90.6 ms`** | **`0 / 0`** |

> [!CAUTION]
> **Never pass `--disable-frame-rate-limit --disable-gpu-vsync` on hardware-accelerated macOS!**
> Disabling VSync switches Chromium to `BackToBackBeginFrameSource`, spinning `rAF` at **1,626–9,796 FPS**, flooding the Viz GPU compositor queue, and starving `FrameSinkVideoCapturerImpl` `CopyOutputRequest` readbacks (collapsing `4K@60` capture to `0.3 fps`). Leave native `CVDisplayLink` VSync enabled.

---

## Benchmark & Telemetry Suite

* **[`cdp-screen-recording-benchmarks.md`](./cdp-screen-recording-benchmarks.md)** — Full writeup covering architecture, `VideoCaptureOracle` ~1s phase-lock vs. `rAF` barcode cadence, full-range Display P3 (`pc/iec61966-2-1/smpte432`) color metadata, packet-indexed `2 * target_fps` GOPs, VFR idle suspension, and `Page.startScreenRecording` vs. `getDisplayMedia` + `MediaRecorder`.
* **[`stress-test-barcode.ts`](./stress-test-barcode.ts)** — TypeScript stress-test runner (`1080p@60/90/120`, `1440p@60`, `4K@30/60`) with a rich live telemetry HUD canvas and 16-bit binary `rAF` barcode verification.
* **[`benchmarks/analyze_mp4.py`](./benchmarks/analyze_mp4.py)** — Per-packet `ffprobe` PTS/DTS + 16-bit `rAF` barcode correlator (`dPTS` percentiles/stdev, `dRAF` histograms, GOP keyframe indices, color tags).
* **[`benchmarks/vfr_burst_test.py`](./benchmarks/vfr_burst_test.py)** — Static-idle → 120Hz burst → static-idle VFR & packet-indexed GOP wakeup test.
* **[`benchmarks/compare_mediarecorder.mjs`](./benchmarks/compare_mediarecorder.mjs)** — Head-to-head `Page.startScreenRecording` vs. web-exposed `getDisplayMedia({preferCurrentTab: true})` + `MediaRecorder` benchmark runner.
* **[`benchmarks/run_mpv_bench.py`](./benchmarks/run_mpv_bench.py)** & **[`benchmarks/mpv_telemetry.lua`](./benchmarks/mpv_telemetry.lua)** — `mpv` playback telemetry harness (VO/decoder frame drops, `--video-sync=display-resample` jitter, and untimed `videotoolbox` vs `libdav1d` decode FPS).
