#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Out-of-band tab video recording via CDP `Page.startScreenRecording` (shipped in Chrome M153).
 *
 * Runs in the browser process (`WebContentsVideoCaptureDevice` -> `content::protocol::MediaRecorder`)
 * and encodes AV1 video + 48kHz stereo Opus audio into MP4 inside a utility process
 * (`devtools_media_encoding_server`), returning an `IO.StreamHandle`.
 *
 * See also:
 * - `./capture-pptr.ts` for Puppeteer integration (`page.createCDPSession()`)
 * - `./capture-playwright.ts` for Playwright integration (`page.context().newCDPSession(page)`)
 */

import {spawn, type ChildProcess} from 'node:child_process';
import {access, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {homedir, platform, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import type {Protocol} from 'devtools-protocol';
import type {ProtocolMapping} from 'devtools-protocol/types/protocol-mapping.js';

export type ScreenRecordingOptions = Protocol.Page.StartScreenRecordingRequest;

export interface CdpSessionLike {
  send<K extends keyof ProtocolMapping.Commands>(
    method: K,
    ...params: ProtocolMapping.Commands[K]['paramsType']
  ): Promise<ProtocolMapping.Commands[K]['returnType']>;
}

export interface LaunchChromeOptions {
  explicitPath?: string;
  width?: number;
  height?: number;
  headless?: boolean;
  audio?: boolean;
  uncap?: boolean;
  extraArgs?: string[];
  url?: string;
}

export interface LaunchedChrome {
  proc: ChildProcess;
  browserWsUrl: string;
  pageTargetWs: string;
  userDataDir: string;
  close: () => Promise<void>;
}

interface CdpRpcError {
  code: number;
  message: string;
}

interface CdpRpcMessage {
  id?: number;
  result?: ProtocolMapping.Commands[keyof ProtocolMapping.Commands]['returnType'];
  error?: CdpRpcError;
}

export class CdpScreenRecorder {
  session: CdpSessionLike;
  streamHandle: Protocol.IO.StreamHandle | undefined;

  constructor(session: CdpSessionLike) {
    this.session = session;
    this.streamHandle = undefined;
  }

  /**
   * Starts native CDP screen recording (AV1 video + optional 48kHz stereo Opus loopback audio in MP4).
   *
   * NOTE on >60fps and VSync:
   * - On macOS with a ProMotion display (90Hz/120Hz) in headed mode, `CVDisplayLink` drives
   *   `ExternalBeginFrameSourceMac` at up to 120Hz natively — sustaining 89.4 unique fps at
   *   1080p@90, 120.2 unique fps at 1080p@120, and 60.2 unique fps at 4K (3840x2160)@60.
   * - Do NOT pass `--disable-frame-rate-limit --disable-gpu-vsync` on hardware-accelerated
   *   macOS: switching to `BackToBackBeginFrameSource` spins in-page `rAF` at 1,600-9,800 fps,
   *   flooding the Viz GPU compositor command queue and starving `FrameSinkVideoCapturerImpl`
   *   readback down to 0.3-11.7 fps.
   */
  async start(options: ScreenRecordingOptions = {}): Promise<Protocol.IO.StreamHandle> {
    const request: Protocol.Page.StartScreenRecordingRequest = {
      frameRate: 60,
      ...options,
    };
    const {stream} = await this.session.send('Page.startScreenRecording', request);
    this.streamHandle = stream;
    return stream;
  }

  /**
   * Stops the active recording, drains the `IO.StreamHandle`, and returns the MP4 bytes.
   */
  async stop(): Promise<Buffer> {
    const {stream} = await this.session.send('Page.stopScreenRecording');
    const handle = stream || this.streamHandle;
    if (!handle) {
      throw new Error('No active stream handle from Page.stopScreenRecording.');
    }

    const chunks: Buffer[] = [];
    try {
      while (true) {
        const {data, base64Encoded, eof} = await this.session.send('IO.read', {handle});
        if (data) {
          chunks.push(Buffer.from(data, base64Encoded ? 'base64' : 'utf8'));
        }
        if (eof) break;
      }
    } finally {
      await this.session.send('IO.close', {handle}).catch(() => {});
      this.streamHandle = undefined;
    }
    return Buffer.concat(chunks);
  }
}

/**
 * Minimal WebSocket-backed CDP session typed against `devtools-protocol`'s `ProtocolMapping.Commands`.
 */
export async function connectCdpSession(wsUrl: string, connectTimeoutMs = 10_000): Promise<CdpSessionLike & {close: () => void}> {
  const ws = new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    if (connectTimeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // Ignore
        }
        reject(new Error(`WebSocket connection timed out after ${connectTimeoutMs}ms: ${wsUrl}`));
      }, connectTimeoutMs);
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
    };

    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error(`WebSocket connection failed: ${wsUrl}`));
    };

    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
  });

  let nextId = 1;
  let isClosed = false;
  const pending = new Map<
    number,
    {
      resolve: (val: CdpRpcMessage['result']) => void;
      reject: (err: Error) => void;
    }
  >();

  const rejectAllPending = (err: Error) => {
    isClosed = true;
    for (const entry of pending.values()) {
      entry.reject(err);
    }
    pending.clear();
  };

  ws.addEventListener('close', () => {
    rejectAllPending(new Error(`WebSocket connection closed: ${wsUrl}`));
  });

  ws.addEventListener('error', () => {
    rejectAllPending(new Error(`WebSocket error on connection: ${wsUrl}`));
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data)) as CdpRpcMessage;
    if (!msg || typeof msg.id !== 'number') return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) {
      entry.reject(new Error(`${msg.error.message} (${msg.error.code})`));
    } else {
      entry.resolve(msg.result);
    }
  });

  return {
    send<K extends keyof ProtocolMapping.Commands>(
      method: K,
      ...args: ProtocolMapping.Commands[K]['paramsType']
    ): Promise<ProtocolMapping.Commands[K]['returnType']> {
      if (isClosed) {
        return Promise.reject(new Error(`Cannot send CDP command ${String(method)}: WebSocket is closed`));
      }
      const id = nextId++;
      const params = args[0] ?? {};
      const {promise, resolve, reject} = Promise.withResolvers<ProtocolMapping.Commands[K]['returnType']>();
      pending.set(id, {
        resolve: resolve as (val: CdpRpcMessage['result']) => void,
        reject,
      });
      try {
        ws.send(JSON.stringify({id, method, params}));
      } catch (err) {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
      return promise;
    },
    close() {
      isClosed = true;
      try {
        ws.close();
      } catch {
        // Ignore close errors
      }
      rejectAllPending(new Error(`WebSocket closed by client: ${wsUrl}`));
    },
  };
}

/**
 * Resolves a local Chrome 153+ executable (checks explicitPath, CHROME_PATH, system paths, or Puppeteer cache).
 */
export async function findChromeBinary(explicitPath?: string): Promise<string> {
  if (explicitPath) {
    try {
      await access(explicitPath);
      return explicitPath;
    } catch {
      throw new Error(`Specified Chrome binary not found: ${explicitPath}`);
    }
  }

  if (process.env.CHROME_PATH) {
    try {
      await access(process.env.CHROME_PATH);
      return process.env.CHROME_PATH;
    } catch {
      // Continue searching
    }
  }

  const candidates = platform() === 'darwin'
    ? [
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
        '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ]
    : ['/usr/bin/google-chrome-unstable', '/usr/bin/google-chrome'];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  const pptrCache = join(homedir(), '.cache', 'puppeteer', 'chrome');
  try {
    const entries = (await readdir(pptrCache))
      .filter(e => e.startsWith('linux-') || e.startsWith('mac_arm-') || e.startsWith('mac-'))
      .sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
    const newest = entries.at(-1);
    if (newest) {
      const candidate = platform() === 'darwin'
        ? join(pptrCache, newest, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
        : join(pptrCache, newest, 'chrome-linux64', 'chrome');
      await access(candidate);
      return candidate;
    }
  } catch {
    // Fall back to throw below.
  }

  throw new Error('Could not find Google Chrome (M153+). Set CHROME_PATH or pass --chrome=/path/to/chrome');
}

/**
 * Launches Chrome with a dedicated temporary user-data-dir and resolves the WebSocket endpoint and initial page target.
 */
export async function launchChrome(options: LaunchChromeOptions = {}): Promise<LaunchedChrome> {
  const chromePath = await findChromeBinary(options.explicitPath);
  const userDataDir = await mkdtemp(join(tmpdir(), 'cdp-rec-'));

  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const headless = options.headless ?? (platform() !== 'darwin');

  const chromeArgs = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    '--remote-debugging-port=0',
  ];

  if (headless) {
    chromeArgs.unshift('--headless=new');
  }
  if (platform() === 'linux') {
    chromeArgs.push('--no-sandbox', '--disable-dev-shm-usage');
  }
  if (options.audio) {
    chromeArgs.push('--autoplay-policy=no-user-gesture-required');
  }
  if (options.uncap) {
    chromeArgs.push('--disable-frame-rate-limit', '--disable-gpu-vsync');
  }
  if (options.extraArgs) {
    chromeArgs.push(...options.extraArgs);
  }

  chromeArgs.push(options.url ?? 'about:blank');

  const proc = spawn(chromePath, chromeArgs, {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      proc.kill('SIGKILL');
    } catch {
      // Ignore
    }
    try {
      await rm(userDataDir, {recursive: true, force: true});
    } catch {
      // Ignore
    }
  };

  const sigintHandler = () => {
    void cleanup().finally(() => process.exit(130));
  };
  const sigtermHandler = () => {
    void cleanup().finally(() => process.exit(143));
  };

  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigtermHandler);

  try {
    const browserWsUrl = await new Promise<string>((resolve, reject) => {
      let stderrAcc = '';
      const onData = (chunk: Buffer) => {
        stderrAcc += chunk.toString();
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderrAcc);
        if (match) {
          proc.stderr?.off('data', onData);
          resolve(match[1]);
        }
      };
      proc.stderr?.on('data', onData);
      proc.once('error', reject);
      proc.once('exit', code => reject(new Error(`Chrome exited early (${code})`)));
    });

    const browserSession = await connectCdpSession(browserWsUrl);
    let pageTargetWs: string | undefined;
    try {
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        const {targetInfos} = await browserSession.send('Target.getTargets');
        const pageTarget = targetInfos.find(t => t.type === 'page' && !t.url.startsWith('devtools://'));
        if (pageTarget) {
          pageTargetWs = new URL(`/devtools/page/${pageTarget.targetId}`, browserWsUrl).toString();
          break;
        }
        await new Promise(r => setTimeout(r, 50));
      }
    } finally {
      browserSession.close();
    }

    if (!pageTargetWs) {
      throw new Error('Timed out waiting for Chrome page target');
    }

    return {
      proc,
      browserWsUrl,
      pageTargetWs,
      userDataDir,
      close: async () => {
        process.removeListener('SIGINT', sigintHandler);
        process.removeListener('SIGTERM', sigtermHandler);
        await cleanup();
      },
    };
  } catch (err) {
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
    await cleanup();
    throw err;
  }
}

/**
 * Parses duration from strings like '3000', '3000ms', '3s', '3', or numbers.
 * Supports explicit `<num>ms` and `<num>s`. For unitless numbers or numeric strings,
 * treats values `< 1000` as seconds (`val * 1000`) and values `>= 1000` as milliseconds.
 * Throws on invalid or unparseable duration strings.
 */
export function parseDuration(val: string | number | undefined, defaultMs = 3000): number {
  if (val == null) return defaultMs;
  const str = String(val).trim();
  if (!str) return defaultMs;
  const match = /^([0-9]*\.?[0-9]+)\s*(ms|s)?$/i.exec(str);
  if (!match) throw new Error(`Invalid duration value: ${val}`);
  const num = parseFloat(match[1]);
  if (num <= 0) throw new Error(`Invalid duration value: ${val}`);
  if (match[2]?.toLowerCase() === 'ms') return num;
  if (match[2]?.toLowerCase() === 's') return num * 1000;
  return num < 1000 ? num * 1000 : num;
}

async function cli(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    console.log(`Usage: node capture-cdp.ts [url] [output] [duration] [options]

Arguments:
  url                         Target page URL (default: http://localhost:8080/ or https://example.com)
  output                      Output MP4 file path (default: demo-60fps.mp4)
  duration                    Duration in ms or seconds (e.g. 3000, 3s, 5s) (default: 3000ms)

Options:
  --duration=<val>            Recording duration (e.g. 3000, 3s, 3000ms)
  --fps=<num>                 Target frame rate (default: 60)
  --width=<pixels>            Viewport width (default: 1280)
  --height=<pixels>           Viewport height (default: 720)
  --warmup=<ms>               Warmup delay before recording starts (default: 1000ms)
  --capture-area=<area>       'target' (tab viewport) or 'browserWindow' (default: target)
  --audio                     Enable audio track recording (default)
  --no-audio                  Disable audio track recording
  --headed                    Run in headed mode (default on macOS)
  --headless                  Run in --headless=new mode (default on Linux)
  --with-devtools             Open screencast + DevTools side-by-side in inspector.html
  --chrome=<path>             Path to Google Chrome executable
  -h, --help                  Show this help message
`);
    return;
  }

  const parsed = parseArgs({
    args: rawArgs,
    options: {
      duration: {type: 'string'},
      fps: {type: 'string'},
      frameRate: {type: 'string'},
      width: {type: 'string'},
      height: {type: 'string'},
      warmup: {type: 'string'},
      'capture-area': {type: 'string'},
      audio: {type: 'boolean'},
      'no-audio': {type: 'boolean'},
      headed: {type: 'boolean'},
      headless: {type: 'boolean'},
      'with-devtools': {type: 'boolean'},
      chrome: {type: 'string'},
      url: {type: 'string'},
      out: {type: 'string'},
      output: {type: 'string'},
      help: {type: 'boolean', short: 'h'},
    },
    allowPositionals: true,
  });

  const url = parsed.values.url ?? parsed.positionals[0] ?? 'http://localhost:8080/';
  const outPath = parsed.values.out ?? parsed.values.output ?? parsed.positionals[1] ?? 'demo-60fps.mp4';
  const rawDuration = parsed.values.duration ?? parsed.positionals[2];
  const durationMs = parseDuration(rawDuration, 3000);
  const width = parseInt(parsed.values.width ?? '1280', 10);
  const height = parseInt(parsed.values.height ?? '720', 10);
  const frameRate = parseInt(parsed.values.fps ?? parsed.values.frameRate ?? '60', 10);
  const warmupMs = parseInt(parsed.values.warmup ?? '1000', 10);
  const rawArea = parsed.values['capture-area'];
  const captureArea: Protocol.Page.StartScreenRecordingRequest['captureArea'] =
    rawArea === 'browserWindow' ? 'browserWindow' : 'target';
  const audio = parsed.values.audio ? true : !parsed.values['no-audio'];
  const headless = parsed.values.headless || (!parsed.values.headed && platform() !== 'darwin');
  const withDevTools = Boolean(parsed.values['with-devtools']);
  const explicitChrome = parsed.values.chrome;

  const extraArgs = [
    '--enable-gpu-rasterization',
    '--remote-allow-origins=devtools://devtools',
  ];

  const launched = await launchChrome({
    explicitPath: explicitChrome,
    width,
    height,
    headless,
    audio,
    extraArgs,
    url,
  });

  try {
    let recordTargetWs = launched.pageTargetWs;

    if (withDevTools) {
      const wsHost = launched.pageTargetWs.replace(/^ws:\/\//, '');
      const inspectorUrl = `devtools://devtools/bundled/inspector.html?ws=${wsHost}`;
      const browserSession = await connectCdpSession(launched.browserWsUrl);
      const {targetId} = await browserSession.send('Target.createTarget', {url: inspectorUrl});
      browserSession.close();
      recordTargetWs = new URL(`/devtools/page/${targetId}`, launched.browserWsUrl).toString();
    }

    const session = await connectCdpSession(recordTargetWs);

    try {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    } catch {
      // Ignore if unsupported on target.
    }

    if (warmupMs > 0) {
      await new Promise(r => setTimeout(r, warmupMs));
    }

    const recorder = new CdpScreenRecorder(session);
    await recorder.start({
      frameRate,
      audio,
      maxWidth: width,
      maxHeight: height,
      captureArea,
    });

    await new Promise(r => setTimeout(r, durationMs));
    const mp4Buffer = await recorder.stop();
    session.close();

    await writeFile(outPath, mp4Buffer);
    console.log(`Saved ${outPath} (${mp4Buffer.byteLength.toLocaleString()} bytes, duration: ${durationMs}ms, ${width}x${height} @ ${frameRate}fps)`);
  } finally {
    await launched.close();
  }
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli().catch((err: Error) => {
    console.error(err);
    process.exit(1);
  });
}
