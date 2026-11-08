# CDP `Page.startScreenRecording` vs. Playwright Screen Capture: Scaling & Benchmarks

Chromium M153+ added native out-of-band tab video recording via CDP [`Page.startScreenRecording`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreenRecording) ([crrev.com/c/7736461](https://chromium-review.googlesource.com/c/chromium/src/+/7736461), [Chromium `page_handler.cc`](https://source.chromium.org/chromium/chromium/src/+/main:content/browser/devtools/protocol/page_handler.cc)).

This document captures how `Page.startScreenRecording` scales up to **1080p @ 120fps** and **4K (`3840x2160`) @ 60fps**, why it outperforms Playwright's `record_video_dir` (`Page.startScreencast` + `ffmpeg` pipe), and why `--disable-frame-rate-limit --disable-gpu-vsync` must not be used on hardware-accelerated macOS.

---

## 1. Architectural Comparison

```
Legacy Playwright (record_video_dir / Page.startScreencast):
  Viz Compositor -> CopyOutputRequest (Bitmap) -> Browser JPEG Encode (q=90)
  -> Base64 JSON over CDP WebSocket (27-140 Mbps!) -> 35ms FrameThrottler ACK
  -> Node.js Buffer (padded to hardcoded 25fps buckets) -> stdin image2pipe
  -> ffmpeg -threads 1 -c:v libvpx -b:v 1M -an (.webm) -> 2nd ffmpeg libx264 (.mp4)

Native CDP (Page.startScreenRecording):
  Viz FrameSinkVideoCapturer -> kSharedMemory I420 pool + LoopbackAudioInputIPC
  -> Utility Process (devtools_media_encoding_server: libaom-av1 + 48kHz stereo Opus)
  -> DevToolsStreamFile -> Page.stopScreenRecording + IO.read (.mp4)
```

### Why Playwright's `record_video_dir` Hits a Hard Wall

Inspecting `playwright-core` (`lib/server/screencast.js` and `lib/server/videoRecorder.js`) reveals four bottlenecks:

1. **Hardcoded 25 FPS Output Cap (`videoRecorder.js`)**: Playwright hardcodes `const fps = 25;` and pads time gaps between incoming frames by writing duplicate JPEG buffers into `ffmpeg`'s `stdin` in a synchronous loop (`repeat = round(fps * duration)`).
2. **35ms `setTimeout` ACK Throttler (`screencast.js`)**: Playwright wraps `Page.screencastFrameAck` in `new FrameThrottler(10, 35, 200)`, enforcing a minimum `35ms` interval between ACKs (`1000 / 35 = 28.57 fps` maximum delivery rate).
3. **Single-Threaded `image2pipe` MJPEG -> VP8 Subprocess**: Playwright launches `ffmpeg` with `-c:v mjpeg -i pipe:0 -r 25 -c:v libvpx -b:v 1M -threads 1 -an`. At 1080p and 4K, single-threaded MJPEG decode + VP8 encode stalls `context.close()` for **7 to 20.5 seconds** on a 4-second clip.
4. **No Audio (`-an`) & Lifecycle Tied to `BrowserContext`**: Recording starts on `browser.new_context()` (capturing initial blank/loading frames) and only flushes on `context.close()`.

---

## 2. Head-to-Head UI Automation Replay (`1280x800`, 6.44s Trajectory)

Measured on an identical 10-step UI interaction sequence (typing, hotkeys, single/double/triple/right/middle clicks, hover, drag-and-drop, scroll, and submit), comparing the final video frame against a lossless `Page.captureScreenshot(png)` reference:

| Metric (`1280x800` Replay) | Playwright (`record_video_dir` + `libx264`) | CDP `Page.startScreenRecording` (30fps) | CDP `Page.startScreenRecording` (60fps) | Net Improvement |
| :--- | :---: | :---: | :---: | :---: |
| **Total Wall-Clock Time** | `21.19 s` | **`11.36 s`** | **`11.55 s`** | **1.87x faster** (`-9.8 s`) |
| **Non-Action Pipeline Overhead** | `14.76 s` | **`4.93 s`** | **`5.11 s`** | **3.0x lower overhead** |
| **Stop & Finalize Latency** | `3,824.5 ms` | **`13.5 ms`** | **`16.9 ms`** | **226x–283x faster finalization** |
| **WebSocket IPC During Active Capture** | `10,740.1 KB` (`10.5 MB`) | **`6.5 KB`** | **`6.5 KB`** | **1,652x less live IPC chatter** |
| **Total WebSocket IPC (incl. `IO.read`)** | `10,740.1 KB` | **`379.2 KB`** | **`448.9 KB`** | **24x–28x less total IPC** |
| **Disk Footprint (Temp + Final)** | `921.7 KB` `.webm` + `484.0 KB` `.mp4` | **`278.9 KB`** `.mp4` | **`331.2 KB`** `.mp4` | **32%–42% smaller final MP4** |
| **Visual Fidelity (PSNR vs Lossless PNG)** | `32.28 dB` | **`36.41 dB`** | **`34.82 dB`** | **+2.53 to +4.13 dB PSNR** |
| **Structural Similarity (SSIM vs Lossless)** | `0.9761` | **`0.9874`** | **`0.9806`** | **+0.0114 higher SSIM** |
| **App Audio Capture** | None (`-an`) | **48kHz Stereo Opus Loopback** | **48kHz Stereo Opus Loopback** | **Native tab audio in headless/headed** |

---

## 3. Stress-Test Methodology: 16-Bit Binary Pixel Frame Barcode

Container packet counts (`ffprobe`) cannot distinguish between 90 genuinely rendered frames/sec and a 60Hz framebuffer duplicated 90 times.

In [`stress-test-barcode.ts`](./stress-test-barcode.ts), every `requestAnimationFrame` callback increments a monotonic counter `f` and draws a **16-bit binary pixel barcode** (`18` blocks of `24x32` pure black/white pixels with a 2-block sync header) at the top-left of the canvas alongside a full-viewport animated gradient and moving bars. After recording, `ffmpeg -vsync 0` samples the center luminance of each barcode block on every encoded video packet to measure:
* **Container FPS**: Total encoded packets / duration.
* **True Unique Visual FPS**: Distinct decoded `rAF` barcode IDs / duration.
* **Duplicate Frame %**: Packets where `barcode[i] == barcode[i - 1]`.

---

## 4. Scaling Results: macOS ProMotion (`120Hz CVDisplayLink` + Apple Silicon Metal GPU)

On a MacBook Pro with ProMotion (`120Hz` native `CVDisplayLink`) and hardware Metal GPU compositing, `Page.startScreenRecording` sustains **100% of the target unique visual frame rate at `1080p @ 90fps`, `1080p @ 120fps`, and `4K (3840x2160) @ 60fps`**:

| Test Case (macOS ProMotion + Metal GPU) | Target FPS | In-Page `rAF` FPS | Container FPS | **True Unique Visual FPS** | Duplicate Frames | Finalize Latency | Size (4s MP4) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`1080p @ 60fps` (Native VSync)** | `60` | `114.8` | `62.5` | **`62.2 fps`** (`236/237`) | `0.4%` | **`23.7 ms`** | `2,802.1 KB` |
| **`1080p @ 90fps` (Native ProMotion VSync)** | `90` | `120.1` | `89.6` | **`89.4 fps`** (`358/359`) | `0.3%` | **`47.6 ms`** | `4,047.5 KB` |
| `1080p @ 90fps` (Uncapped VSync) | `90` | `9795.9` | `12.0` | `11.7 fps` (`51/52`) | `1.9%` | `11.6 ms` | `694.5 KB` |
| **`1080p @ 120fps` (Native ProMotion VSync)** | `120` | `120.1` | `120.4` | **`120.2 fps`** (`480/481`) | **`0.2%`** | **`67.2 ms`** | `5,394.2 KB` |
| `1080p @ 120fps` (Uncapped VSync) | `120` | `8474.0` | `122.2` | `121.9 fps` (`489/490`) | `0.2%` | `487.4 ms` | `6,137.5 KB` |
| **`1440p @ 60fps` (Native VSync)** | `60` | `120.0` | `60.2` | **`60.0 fps`** (`240/241`) | `0.4%` | **`43.7 ms`** | `4,266.6 KB` |
| **`4K (3840x2160) @ 30fps` (Native VSync)** | `30` | `119.8` | `30.4` | **`30.1 fps`** (`121/122`) | `0.8%` | **`27.3 ms`** | `3,632.0 KB` |
| **`4K (3840x2160) @ 60fps` (Native VSync)** | `60` | `120.1` | `60.5` | **`60.2 fps`** (`241/242`) | **`0.4%`** | **`90.6 ms`** | `7,377.3 KB` |
| `4K (3840x2160) @ 60fps` (Uncapped VSync) | `60` | `1625.7` | `0.7` | `0.3 fps` (`1/2`) | `50.0%` | `114.3 ms` | `11.9 KB` |

### Critical Finding: Why `--disable-frame-rate-limit --disable-gpu-vsync` Starves Capture on macOS

* When VSync is disabled (`--disable-frame-rate-limit --disable-gpu-vsync`) on Apple Silicon, Chromium switches to `BackToBackBeginFrameSource`, spinning `requestAnimationFrame` at **9,796 FPS at 1080p** and **1,626 FPS at 4K**.
* That tight submission loop floods the Viz GPU compositor command queue and starves `FrameSinkVideoCapturerImpl`'s `CopyOutputRequest` readback pipeline—collapsing 4K@60 capture to **`0.3 fps` (`1` unique frame)** and 1080p@90 capture to **`11.7 fps`**.
* With **Native ProMotion VSync (`CVDisplayLink`)**, macOS paces `BeginFrame` cleanly at `120Hz`, allowing Metal GPU compositing and out-of-process AV1 encoding to hit **`60.2 true unique visual FPS` at 4K**, **`89.4 FPS` at 1080p@90**, and **`120.2 FPS` at 1080p@120** with `< 91 ms` finalization.

### Headless (`--headless=new`) vs. Headful on macOS Apple Silicon (M4 Max)

Running the same 9-case matrix with `node benchmarks/stress-test-barcode.ts --headless` on the M4 Max confirms how `--headless=new` behaves on macOS:

| Test Case (macOS M4 Max `--headless=new`) | Target FPS | In-Page `rAF` FPS | Container FPS | **True Unique Visual FPS** | Duplicate Frames | Finalize Latency | Size (4s MP4) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`1080p @ 60fps` (Native VSync)** | `60` | `57.7` | `60.0` | **`59.7 fps`** (`231/232`) | `0.4%` | `115.0 ms` | `3,501.9 KB` |
| `1080p @ 90fps` (Native VSync) | `90` | `60.0` | `60.6` | **`60.4 fps`** (`240/241`) | `0.4%` | `118.2 ms` | `3,689.2 KB` |
| `1080p @ 90fps` (Uncapped VSync) | `90` | `4003.9` | `26.9` | `26.6 fps` (`103/104`) | `1.0%` | `54.3 ms` | `1,610.4 KB` |
| `1080p @ 120fps` (Native VSync) | `120` | `60.0` | `60.6` | **`60.4 fps`** (`240/241`) | `0.4%` | `131.3 ms` | `3,668.4 KB` |
| `1080p @ 120fps` (Uncapped VSync) | `120` | `3980.4` | `30.6` | `30.3 fps` (`118/119`) | `0.8%` | `65.3 ms` | `1,843.2 KB` |
| **`1440p @ 60fps` (Native VSync)** | `60` | `60.0` | `60.3` | **`60.0 fps`** (`240/241`) | `0.4%` | `203.3 ms` | `6,162.0 KB` |
| **`4K (3840x2160) @ 30fps` (Native VSync)** | `30` | `60.0` | `30.3` | **`30.1 fps`** (`121/122`) | `0.8%` | `180.7 ms` | `6,235.1 KB` |
| **`4K (3840x2160) @ 60fps` (Native VSync)** | `60` | `60.0` | `60.6` | **`60.3 fps`** (`240/241`) | `0.4%` | `418.7 ms` | `12,609.5 KB` |
| `4K (3840x2160) @ 60fps` (Uncapped VSync) | `60` | `2548.3` | `14.9` | `14.4 fps` (`57/59`) | `1.7%` | `133.0 ms` | `2,997.6 KB` |

* **Metal GPU acceleration remains active in `--headless=new` on macOS**: `1080p@60`, `1440p@60`, and **`4K (3840x2160) @ 60fps`** all sustain **`60.0–60.3` true unique visual fps** with `0.4%` duplicates in `--headless=new` (without opening a visible browser window).
* **`--headless=new` caps `BeginFrame` (`rAF`) at `60Hz`**: Without an on-screen `NSWindow` bound to the display's `120Hz` ProMotion `CVDisplayLink`, headless Chromium drives `BeginFrame` from a synthetic `60Hz` timer (`In-Page rAF FPS = 60.0`), capping `90fps` and `120fps` captures at `60.4` unique visual fps. Use `--headful` when recording at `> 60fps` (`90fps` / `120fps`).

---

## 5. Scaling Results: Headless Linux Without Hardware GPU (`--headless=new --disable-gpu`)

On a GPU-less Linux workstation where both Skia rasterization and `libaom-av1` encoding run on CPU:

| Resolution & Target FPS | VSync Mode | Workload | In-Page `rAF` FPS | Container FPS | **True Unique Visual FPS** | Finalize Latency |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **`1280x800 @ 60fps`** | Default (60Hz) | Full-Canvas Shader | `60.2` | `60.56` | **`60.31 fps`** (`239/240`) | `83.9 ms` |
| **`1920x1080 (1080p) @ 60fps`** | Default (60Hz) | Full-Canvas Shader | `60.0` | `60.61` | **`60.36 fps`** (`240/241`) | `225.7 ms` |
| **`1920x1080 (1080p) @ 90fps`** | Default (60Hz) | Full-Canvas Shader | `60.0` | `60.42` | **`60.17 fps`** (`239/240`) | `111.0 ms` |
| **`1920x1080 (1080p) @ 90fps`** | Uncapped | Full-Canvas Shader | `112.5` | `75.39` | **`75.15 fps`** (`313/314`) | `1,202.1 ms` |
| **`1920x1080 (1080p) @ 90fps`** | Uncapped | Typical Web UI | `1275.3` | `83.62` | **`83.37 fps`** (`328/329`) | `40.1 ms` |
| **`2560x1440 (1440p) @ 60fps`** | Uncapped | Typical Web UI | `1804.4` | `58.47` | **`58.23 fps`** (`237/238`) | `259.9 ms` |
| **`3840x2160 (4K) @ 60fps`** | Default (60Hz) | Typical Web UI | `23.0` | `22.29` | **`22.05 fps`** (`92/93`) | `592.6 ms` |
| **`3840x2160 (4K)` Playwright `record_video_dir`** | Uncapped | Full-Canvas Shader | `30.1` | `25.0` (padded) | **`12.07 fps`** (`49` unique) | **`20,466.9 ms`** |

---

## 6. Deep-Dive: VFR Timestamp Jitter, `VideoCaptureOracle` Phase-Lock & `rAF` Barcode Cadence

Per-packet `ffprobe` PTS/DTS telemetry correlated against decoded 16-bit `rAF` barcodes via [`benchmarks/analyze-mp4.ts`](./analyze-mp4.ts) (Apple M4 Max · ProMotion 120Hz · Chrome `159.0.8149.0` Canary · FFmpeg `8.1`):

| Stream (`Native VSync` unless noted) | Timebase | Bitrate (`kbps`) | Packets (`Unique`) | `dPTS` P05 / **P50** / P95 / Max (`ms`) | `dPTS` Stdev (`ms`) | `dRAF` Histogram (`{ΔrAF: count}`) | Boundary Anomalies Observed |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| **`1080p @ 60fps`** | `1/60000` | `5,859.5` | `242` (`241`) | `16.65` / **`16.65`** / `16.67` / `25.07` | `1.49` | `{0:1, 1:2, 2:236, 3:2}` | `#0→1` `1.72ms`; `#241` dup `6.18ms` |
| **`1080p @ 90fps`** | `1/90000` | `8,604.7` | `358` (`357`) | `8.32` / **`11.10`** / `16.66` / `17.59` | `2.10` | `{0:1, 1:232, 2:124}` | Raw `8.33/16.67ms` until `#87` (`~1.0s`), then snaps to `11.11ms`; `#357` dup `4.22ms` |
| **`1080p @ 120fps`** | `1/120000` | `11,202.2` | `483` (`482`) | `8.32` / **`8.33`** / `8.33` / `9.86` | **`0.45`** | `{0:1, 1:481}` | `#0→1` `2.48ms`; `#482` dup `1.15ms` |
| `1080p @ 120fps` (Uncapped) | `1/120000` | `12,498.8` | `490` (`489`) | `7.92` / `8.22` / `8.70` / `12.06` | `0.54` | `35–135` (`rAF` @ `8,344 fps`) | `#0` & `#1` both `pts=0.000ms` (non-mono DTS) |
| **`1440p @ 60fps`** | `1/60000` | `8,735.1` | `242` (`241`) | `16.65` / **`16.67`** / `16.67` / `17.97` | `1.01` | `{0:1, 1:1, 2:239}` | `#0→1` `2.33ms`; `#241` dup `10.32ms` |
| **`4K @ 30fps`** | `1/30000` | `7,531.1` | `122` (`121`) | `33.27` / **`33.33`** / `33.33` / `34.47` | `3.28` | `{0:1, 2:1, 4:119}` | `#0→1` `7.30ms`; `#121` dup `7.93ms` |
| **`4K @ 60fps`** | `1/60000` | `15,193.9` | `242` (`241`) | `16.60` / **`16.65`** / `16.68` / `18.15` | `1.26` | `{0:1, 1:1, 2:238, 3:1}` | `#0` & `#1` both `pts=0.000ms` (non-mono DTS); `#241` dup `6.75ms` |

### Key Findings from PTS + Barcode Correlation

1. **`VideoCaptureOracle` ~1s Phase-Lock on `1080p @ 90fps` Masks Visual Beat Judder Behind Smooth Container PTS**:
   * For the first `86` frames (`0–1.0s`), `1080p@90` emits raw ProMotion `CVDisplayLink` intervals (`[8.33, 8.33, 16.66]` ms).
   * At **frame `#87` (`~1.0s`)**, Chromium's `VideoCaptureOracle` timestamp smoother locks on and snaps container `dPTS` to `[11.09, 11.12, 11.10]` ms (`1/90s`) for the rest of the clip (`#87–#355`).
   * **However**, the in-frame `rAF` barcode delta `dRAF` remains `[1, 1, 2]` (`232` ones, `124` twos ≈ `2:1`, matching `120Hz / 90fps = 4/3`). The MP4 container advertises uniform `11.11ms` presentation spacing while the rendered pixels step by `8.33ms / 8.33ms / 16.67ms` — causing 90-vs-120Hz beat micro-judder invisible to `ffprobe` PTS metrics alone. Integer divisors of `120Hz` (`30fps` → `dRAF=4`, `60fps` → `dRAF=2`, `120fps` → `dRAF=1`) have zero beat judder.
2. **Start & Stop Boundary Timestamp Quirks**:
   * **Frame `#0 → #1`**: In `4K@60` and `1080p@120 (Uncapped)`, packets `#0` (`barcode=18`) and `#1` (`barcode=19`, a distinct visual frame) are both stamped `pts=0.000ms / dts=0.000ms`. In the other clips, `#0 → #1` has a truncated startup delta (`1.72–7.30ms`).
   * **Final frame (`stopScreenRecording`)**: Every recording ends with a duplicated barcode (`dRAF = 0`) at a truncated `dPTS` (`1.15–10.32ms`), consistent with `stopScreenRecording` flushing a final compositor frame.
3. **Color Metadata & Packet-Indexed GOP Structure**:
   * All CDP MP4s signal **`yuv420p` full-range (`pc`), `bt709` matrix, `iec61966-2-1` (sRGB transfer), `smpte432` (Display P3 primaries)** — preserving macOS wide-gamut/sRGB color metadata without TV-range clamping.
   * Keyframes are placed strictly by **packet count at `2 * target_fps`** (`[0, 120, 240]` @ 60fps; `[0, 180]` @ 90fps; `[0, 240, 480]` @ 120fps; `[0, 60, 120]` @ 30fps).

---

## 7. `mpv` Playback Decode Cost, Drops & VSync Telemetry (`mpv v0.41.0`, Apple M4 Max)

Measured via [`benchmarks/mpv_telemetry.lua`](./mpv_telemetry.lua) and [`benchmarks/run-mpv-bench.ts`](./run-mpv-bench.ts) across windowed ProMotion playback (`--vo=gpu-next`, `display-fps=120`) with default audio-clock sync vs `--video-sync=display-resample`, and untimed max-speed decode (`--vo=null --untimed`, measuring `file-loaded -> eof` wall time):

| Recording | `gpu-next + videotoolbox` (default sync) Drops (VO/Dec) | `gpu-next + videotoolbox` (`display-resample`) Drops / Delayed / Avg Jitter | `gpu-next + libdav1d (sw)` (`display-resample`) Drops / Delayed / Avg Jitter | `null --untimed` SW `libdav1d` Decode Time (**FPS**) | `null --untimed` HW `videotoolbox-copy` Time (**FPS**) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **`1080p @ 60fps`** | `4 / 0` | `1 / 0` · `5` del · `0.116` | `1 / 0` · `6` del · `0.148` | `0.189 s` (**`1,280 fps`**) | `0.614 s` (`394 fps`) |
| **`1080p @ 90fps`** | `3 / 0` | `0 / 0` · `4` del · `0.090` | `0 / 0` · `6` del · `0.145` | `0.250 s` (**`1,431 fps`**) | `0.985 s` (`363 fps`) |
| **`1080p @ 120fps`** | **`12 / 0`** | **`0 / 0`** · `9` del · `0.091` | `2 / 0` · `2` del · `0.056` | **`0.304 s` (`1,589 fps`)** | `1.329 s` (`363 fps`) |
| **`1440p @ 60fps`** | `4 / 0` | `1 / 0` · `4` del · `0.080` | `0 / 0` · `2` del · `0.052` | `0.276 s` (**`876 fps`**) | `1.172 s` (`207 fps`) |
| **`4K @ 30fps`** | `0 / 0` | `0 / 0` · `4` del · `0.069` | `0 / 0` · `0` del · `0.034` | `0.279 s` (**`438 fps`**) | `0.949 s` (`129 fps`) |
| **`4K @ 60fps`** | `0 / 0` | **`0 / 0`** · `5` del · `0.087` | `1 / 0` · `5` del · `0.083` | **`0.475 s` (`509 fps`)** | `1.809 s` (`134 fps`) |

* **`decoder-frame-drop-count` is `0` everywhere**: Neither Apple `videotoolbox` AV1 hardware decode nor `libdav1d` software decode ever drops a frame up to `4K@60` and `1080p@120`.
* **`--video-sync=display-resample` eliminates `1080p@120` presentation drops**: Default audio-clock sync drops `12` VO frames on `1080p@120` when VFR packet jitter collides with `120Hz` ProMotion vsyncs; `--video-sync=display-resample` with `videotoolbox` drops `0` frames on `1080p@90`, `1080p@120`, `4K@30`, and `4K@60`.
* **`libdav1d` software decode hits `509 fps` at `4K@60` (`8.5x` realtime) and `1,589 fps` at `1080p@120` (`13.2x` realtime)**: Note that `--vo=null` forces `videotoolbox-copy` CPU readback (`134–394 fps`), whereas `--vo=gpu-next` uses zero-copy `videotoolbox` `IOSurface`.

---

## 8. Static Idle → Sudden 120Hz Burst → Static Idle VFR Behavior

Tested via [`benchmarks/vfr-burst-test.ts`](./vfr-burst-test.ts) on a `5.0s` sequence (`1.5s` static idle → `2.0s` full-canvas 120Hz burst → `1.5s` static idle):

| Case | Total Packets (`end_raf`) | Idle Before (`0–1.5s`) | Burst Wakeup Latency & Cadence | Idle After (`3.5–5.0s`) | Keyframe Behavior & Size Adaptation | `mpv` Playback (`display-resample`) |
| :--- | :---: | :---: | :--- | :--- | :--- | :--- |
| **`1080p @ 120fps`** (`2,443.8 KB`) | `245` (`241`) | `1` packet (`#0` @ `0.00ms`, `2.36 KB`) | `#1` (`barcode=1`) @ `1513.03ms`, then locked `8.33ms` (`dRAF=1`) | `#241` (`3512.9ms`), dup `#242` (`+8.32ms`, `7.00 KB`), then **`1,476.12ms` gap** → `0.11 KB` keepalive @ `4997.4ms` | **No spurious I-frame on burst start** (`#1` is P-frame `4.87 KB`). I-frame at **packet `#240`** (`15.36 KB`), not wall-clock `2.0s` | `0` drops, `0` mistimed, `1` delayed, jitter `0.048` |
| **`4K @ 60fps`** (`3,308.2 KB`) | `126` (`241`) | `1` packet (`#0` @ `0.00ms`, `2.81 KB`) | `#1` (`barcode=1`) @ `1493.22ms`, then `16.65ms` (`dRAF=2`) | `#122` (`3508.4ms`), `+265.41ms` refinement (`#123`, `8.04 KB`), then **`1,217.27ms` gap** → `0.24 KB` keepalive @ `4991.1ms` | `#1` is P-frame `7.25 KB` (no pumping). I-frame at **packet `#120`** (`30.62 KB`), followed by a brief **`7.08 KB` post-I-frame dip** on `#121` | `1` VO drop, `0` mistimed, jitter `0.024` |

* **True zero-damage idle suspension**: During static idle, `FrameSinkVideoCapturer` emits **0 keepalive packets for ~1.2–1.5 seconds**, yet wakes up immediately on **`barcode=1`** (the very first rendered `rAF` frame) with zero lost transition frames.
* **Packet-indexed GOPs avoid wakeup bitrate spikes**: Because keyframes fire every `2 * target_fps` *encoded packets* rather than wall-clock seconds, resuming from a long idle stretch emits a compact P-frame (`4.87–7.25 KB`) without triggering an I-frame quality oscillation.

---

## 9. `Page.startScreenRecording` vs. In-Renderer `MediaRecorder` (`getDisplayMedia` + `MediaRecorder`)

Comparing `Page.startScreenRecording` against in-renderer `navigator.mediaDevices.getDisplayMedia({preferCurrentTab: true})` + `MediaRecorder` (automated via [`benchmarks/compare-mediarecorder.ts`](./compare-mediarecorder.ts)) on the same `4.0s` 16-bit barcode workload:

| Path & Config | Codec / Color | Bitrate (`kbps`) | Timebase | `dPTS` P50 / Max (`ms`) | `dPTS` Stdev (`ms`) | Unique `rAF` Frames (`dRAF` Hist) | GOP (`kf_indices`) | Finalize (`ms`) | `mpv` Drops (`gpu-next+dr`) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **CDP `1080p@60`** | AV1 · `pc/srgb/p3` | `5,859.5` | `1/60000` | `16.65` / `25.07` | `1.49` | `241` (`{0:1,1:2,2:236,3:2}`) | `120` (`2.0s`) | `20.9` | `1 / 0` |
| **MR `1080p@60` VP9 (default `2.5M`)** | VP9 · `tv/bt709` | **`2,003.6`** | `1/1000` | `17.00` / **`34.00`** | **`3.90`** | `239` (`{1:18, 2:211, 3:1, 4:8}`) | `101` (`1.68s`) | **`0.4`** | `0 / 0` |
| **MR `1080p@60` VP9 (`8M`)** | VP9 · `tv/bt709` | `5,720.8` | `1/1000` | `17.00` / `18.00` | **`0.53`** | `239` (`{2:238}`) | `101` (`1.68s`) | `0.5` | `1 / 0` |
| **CDP `1080p@120`** | AV1 · `pc/srgb/p3` | `11,202.2` | `1/120000` | `8.33` / `9.86` | `0.45` | `482` (`{0:1, 1:481}`) | `240` (`2.0s`) | `50.6` | `0 / 0` |
| **MR `1080p@120` VP9 (`12M`)** | VP9 · `tv/bt709` | `9,510.8` | `1/1000` | `8.00` / `10.00` | `0.63` | `480` (`{1:479}`) | `101` (`0.84s`) | `0.9` | `1 / 0` |
| **MR `1080p@120` AV1 MP4 (`12M`)** | AV1 · `tv/bt709` | `7,654.3` | `1/120004` | `8.30` / `9.40` | **`0.39`** | `480` (`{1:479}`) | `101` (`0.84s`) | `1.4` | `1 / 0` |
| **CDP `4K@60`** | AV1 · `pc/srgb/p3` | `15,193.9` | `1/60000` | `16.65` / `18.15` | `1.26` | `241` (`{0:1,1:1,2:238,3:1}`) | `120` (`2.0s`) | `76.5` | `0 / 0` |
| **MR `4K@60` VP9 (`15M`)** | VP9 · `tv/bt709` | `11,353.4` | `1/1000` | `17.00` / `19.00` | **`0.75`** | `239` (`{2:238}`) | `101` (`1.68s`) | `0.7` | `0 / 0` |

### Takeaways: `Page.startScreenRecording` vs. In-Renderer `MediaRecorder`

* **Default `2.5 Mbps` Bitrate Trap in `MediaRecorder`**: Leaving `videoBitsPerSecond` unset in `MediaRecorder` caps VP9 at **`2.5 Mbps`** (`2,003.6 kbps` actual), causing `libvpx` rate-control frame drops (`8` jumps of `34ms` / `ΔrAF=4`, `stdev=3.90ms`). `Page.startScreenRecording` auto-scales bitrate cleanly (`5.86–15.19 Mbps`) with zero bitrate-starvation drops.
* **Pacing & PTS Precision**: When given explicit bitrate headroom (`8–15 Mbps`), in-renderer `MediaRecorder` (`1/1000` WebM ms timestamps, or `1/120004` MP4 AV1) achieves slightly lower `dPTS` jitter (`0.39–0.75ms` stdev) and **no `pts=0` frame-0/1 collision or trailing stop-flush duplicate** (`239/239` or `480/480` clean frames, `0.4–1.4ms` `stop()` vs `21–77ms` CDP `IO.read` drain).
* **Color Gamut, GOP Scaling & Lifecycle Isolation**: `Page.startScreenRecording` preserves **full-range sRGB / Display P3 (`pc/iec61966-2-1/smpte432`)**, scales GOP cleanly to **`2 * target_fps`**, runs completely out-of-process, and survives cross-origin navigations without user prompts or injected page script, whereas `MediaRecorder` clamps color metadata to **`tv/bt709`** and hardcodes a **`101`-frame GOP** (`0.84s` at 120fps).

---

## 10. Practical Playbook & Decision Matrix for Chromium Video Capture

### A. Which Chromium Capture Pipeline Should You Use?

| Feature / Dimension | CDP `Page.startScreenRecording` ([`src/cli.ts`](../src/cli.ts) / [`src/index.ts`](../src/index.ts)) | In-Renderer `getDisplayMedia` + `MediaRecorder` ([`benchmarks/compare-mediarecorder.ts`](./compare-mediarecorder.ts)) | Playwright `record_video_dir` (`Page.startScreencast`) |
| :--- | :--- | :--- | :--- |
| **Capture Layer** | Browser Process (`WebContentsVideoCaptureDevice` -> shared-memory `I420` -> utility process `libaom-av1` + `Opus`) | Renderer Process (`FrameSinkVideoCaptureDevice` -> Blink `MediaStreamTrack` -> `MediaRecorder`) | Browser JPEG (`q=90`) -> Base64 JSON over CDP WebSocket -> Node.js `image2pipe` -> `ffmpeg -threads 1` |
| **Max Verified Real-Time Throughput (M4 Max ProMotion)** | **`1080p @ 120.2 fps`**, **`1080p @ 89.4 fps`**, **`4K @ 60.2 fps`** | **`1080p @ 120 fps`**, **`4K @ 60 fps`** *(requires `videoBitsPerSecond >= 8M–15M`)* | Hard-capped at **`25 fps` container** / **`~12–21 unique fps`** (`35ms` `FrameThrottler` ACK cap) |
| **Stop / Finalize Latency (4–6s clip)** | **`13–91 ms`** (`IO.read` chunked stream drain) | **`0.4–1.4 ms`** (in-memory `BlobEvent`) | **`3,825–20,467 ms`** (`context.close()` blocks on single-threaded `ffmpeg`) |
| **Audio Support** | **Native 48kHz Stereo Opus** (`captureAudio: true`, works in headless & headed) | Optional tab audio track via `getDisplayMedia({audio: true})` | **None** (hardcoded `-an`) |
| **Color Signaling** | **Full-range (`pc`), sRGB transfer (`iec61966-2-1`), Display P3 primaries (`smpte432`)** | Limited TV range (`tv`), `bt709` | Limited TV range (`tv`), JPEG `yuvj420p` -> `yuv420p` |
| **GOP / Keyframe Interval** | **Packet-indexed `2 * target_fps`** (`120` pkts @ 60fps, `240` pkts @ 120fps); no I-frame spike after idle | Hardcoded **`101` packets** (`0.84s` @ 120fps, `1.68s` @ 60fps) | `ffmpeg` `libvpx` default |
| **Survives Cross-Process Navigations / Reloads?** | **Yes** (bound to `WebContents` in browser process) | **No** (page navigation destroys the renderer `MediaRecorder` context) | **Yes** |
| **Works Without CDP / In Normal User Session?** | **No** (requires CDP session, Chrome M153+) | **Yes** (standard Web APIs with user gesture) | **No** (requires CDP) |

### B. Rules of Thumb & Gotchas When Building on `Page.startScreenRecording`

1. **Never pass `--disable-frame-rate-limit --disable-gpu-vsync` on hardware-accelerated macOS**:
   * Disabling VSync switches Chromium to `BackToBackBeginFrameSource`, spinning `requestAnimationFrame` at **1,600–9,800 FPS**, saturating the Viz GPU command queue, and starving `FrameSinkVideoCapturerImpl` `CopyOutputRequest` readbacks (collapsing `4K@60` to `0.3 fps`). Let macOS `CVDisplayLink` pace `BeginFrame` natively at `120Hz`.
2. **Pick integer divisors of display refresh (`30`, `60`, `120` on 120Hz ProMotion)**:
   * On a `120Hz` display, `target_fps = 90` produces a `2:1` visual step cadence (`dRAF` alternates `[1, 1, 2]` -> `8.33ms, 8.33ms, 16.67ms`) even though `VideoCaptureOracle` smooths the container PTS to a uniform `11.11ms` after `~1.0s` (frame `#87`). Use `60` or `120` for zero beat micro-judder.
3. **Recommended Chrome launch flags for deterministic capture**:
   * `--autoplay-policy=no-user-gesture-required` (so WebAudio / `<video>` plays without click gestures)
   * `--disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-ipc-flooding-protection`
   * `--enable-gpu-rasterization --ignore-gpu-blocklist`
   * Use `--headless=new` for headless automation (keeps the full browser/utility process pipeline for `Page.startScreenRecording` + `LoopbackAudioInputIPC`), or headed on macOS ProMotion when targeting `>60fps` (`90/120fps`) via native `120Hz CVDisplayLink`.
4. **Account for VFR + Start/Stop boundary packets in downstream tooling**:
   * `Page.startScreenRecording` is true **VFR (Variable Frame Rate)**: static UI regions emit **0 packets for 1.2–1.5s** and wake up on the very first damaged `rAF` frame (`barcode=1`) as a compact P-frame.
   * Under heavy load (`4K@60`), packets `#0` and `#1` can both carry `pts=0.000ms`, and `Page.stopScreenRecording` always flushes one trailing duplicate frame (`dRAF=0`) with a short `dPTS` (`1–10ms`).
   * For smooth playback of `1080p@120` / `4K@60` VFR streams in `mpv`, pass `--vo=gpu-next --video-sync=display-resample` (eliminates VO drops). When extracting raw frames with `ffmpeg`, use `-fps_mode passthrough` (or `-vsync 0`).
5. **If using `MediaRecorder` ([`benchmarks/compare-mediarecorder.ts`](./compare-mediarecorder.ts)), always set `videoBitsPerSecond`**:
   * Chromium's `MediaRecorder` defaults to `2_500_000` (`2.5 Mbps`), which causes `libvpx` rate-control frame drops at `1080p@60+`. Set `videoBitsPerSecond: 8_000_000` (`8 Mbps`) for `1080p@60`, `12_000_000` (`12 Mbps`) for `1080p@120`, and `15_000_000` (`15 Mbps`) for `4K@60`.
