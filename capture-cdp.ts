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

import {spawn} from 'node:child_process';
import {access, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {homedir, platform, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Protocol} from 'devtools-protocol';
import type {ProtocolMapping} from 'devtools-protocol/types/protocol-mapping.js';

export type ScreenRecordingOptions = Protocol.Page.StartScreenRecordingRequest;

export interface CdpSessionLike {
  send<K extends keyof ProtocolMapping.Commands>(
    method: K,
    ...params: ProtocolMapping.Commands[K]['paramsType']
  ): Promise<ProtocolMapping.Commands[K]['returnType']>;
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

interface CdpTargetInfo {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

function isRecord(val: object | null): val is Record<string, object | string | number | boolean | undefined> {
  return typeof val === 'object' && val !== null;
}

function parseCdpRpcMessage(raw: string): CdpRpcMessage | null {
  const parsed: object | null = JSON.parse(raw);
  if (!isRecord(parsed)) return null;
  const id = typeof parsed.id === 'number' ? parsed.id : undefined;
  let error: CdpRpcError | undefined;
  if (typeof parsed.error === 'object' && parsed.error !== null && isRecord(parsed.error)) {
    const code = typeof parsed.error.code === 'number' ? parsed.error.code : -1;
    const message = typeof parsed.error.message === 'string' ? parsed.error.message : 'CDP error';
    error = {code, message};
  }
  const result = parsed.result as CdpRpcMessage['result'];
  return {id, result, error};
}

function parseTargetList(raw: string): CdpTargetInfo[] {
  const parsed: object | null = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  const targets: CdpTargetInfo[] = [];
  for (const item of parsed) {
    if (
      typeof item === 'object' &&
      item !== null &&
      typeof item.id === 'string' &&
      typeof item.type === 'string' &&
      typeof item.url === 'string' &&
      typeof item.webSocketDebuggerUrl === 'string'
    ) {
      targets.push({
        id: item.id,
        type: item.type,
        url: item.url,
        webSocketDebuggerUrl: item.webSocketDebuggerUrl,
      });
    }
  }
  return targets;
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
      await this.session.send('IO.close', {handle});
      this.streamHandle = undefined;
    }
    return Buffer.concat(chunks);
  }
}

/**
 * Minimal WebSocket-backed CDP session typed against `devtools-protocol`'s `ProtocolMapping.Commands`.
 */
export async function connectCdpSession(wsUrl: string): Promise<CdpSessionLike & {close: () => void}> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), {once: true});
    ws.addEventListener('error', () => reject(new Error(`WebSocket connection failed: ${wsUrl}`)), {once: true});
  });

  let nextId = 1;
  const pending = new Map<
    number,
    {
      resolve: (val: CdpRpcMessage['result']) => void;
      reject: (err: Error) => void;
    }
  >();

  ws.addEventListener('message', (event) => {
    const msg = parseCdpRpcMessage(String(event.data));
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
      const id = nextId++;
      const params = args[0] ?? {};
      const {promise, resolve, reject} = Promise.withResolvers<ProtocolMapping.Commands[K]['returnType']>();
      pending.set(id, {
        resolve: resolve as (val: CdpRpcMessage['result']) => void,
        reject,
      });
      ws.send(JSON.stringify({id, method, params}));
      return promise;
    },
    close() {
      ws.close();
    },
  };
}

/**
 * Resolves a local Chrome 153+ executable (checks CHROME_PATH, system paths, or Puppeteer cache).
 */
export async function findChromeBinary(): Promise<string> {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

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
    // Fall back to system binary candidates.
  }

  return candidates[0];
}

/**
 * Parses duration from strings like '3000', '3000ms', '3s', '3', or numbers.
 */
export function parseDuration(val: string | number | undefined, defaultMs = 3000): number {
  if (val == null) return defaultMs;
  const str = String(val).trim();
  if (str.endsWith('ms')) return parseFloat(str);
  if (str.endsWith('s')) return parseFloat(str) * 1000;
  const num = parseFloat(str);
  if (Number.isNaN(num)) return defaultMs;
  return num <= 30 ? num * 1000 : num;
}

async function cli(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
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
  -h, --help                  Show this help message
`);
    return;
  }

  const getFlagVal = (flag: string): string | undefined => {
    const exact = args.find(a => a.startsWith(flag + '='));
    if (exact) return exact.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) {
      return args[idx + 1];
    }
    return undefined;
  };

  const positional = args.filter((a, i) => {
    if (a.startsWith('--')) return false;
    const prev = args[i - 1];
    if (prev && prev.startsWith('--') && !prev.includes('=')) return false;
    return true;
  });

  const url = getFlagVal('--url') ?? positional[0] ?? 'http://localhost:8080/';
  const outPath = getFlagVal('--out') ?? getFlagVal('--output') ?? positional[1] ?? 'demo-60fps.mp4';
  const rawDuration = getFlagVal('--duration') ?? positional[2];
  const durationMs = parseDuration(rawDuration, 3000);
  const width = parseInt(getFlagVal('--width') ?? '1280', 10);
  const height = parseInt(getFlagVal('--height') ?? '720', 10);
  const frameRate = parseInt(getFlagVal('--fps') ?? getFlagVal('--frameRate') ?? '60', 10);
  const warmupMs = parseInt(getFlagVal('--warmup') ?? '1000', 10);
  const rawArea = getFlagVal('--capture-area');
  const captureArea: Protocol.Page.StartScreenRecordingRequest['captureArea'] =
    rawArea === 'browserWindow' ? 'browserWindow' : 'target';
  const audio = args.includes('--audio') ? true : !args.includes('--no-audio');
  const headless = args.includes('--headless') || (!args.includes('--headed') && platform() !== 'darwin');
  const withDevTools = args.includes('--with-devtools');

  const chromePath = await findChromeBinary();
  const userDataDir = await mkdtemp(join(tmpdir(), 'cdp-rec-'));
  const chromeArgs = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--enable-gpu-rasterization',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=devtools://devtools',
  ];
  if (headless) {
    chromeArgs.unshift('--headless=new');
  }
  if (audio) {
    chromeArgs.push('--autoplay-policy=no-user-gesture-required');
  }
  chromeArgs.push(url);

  const chrome = spawn(chromePath, chromeArgs);

  try {
    const browserWsUrl = await new Promise<string>((resolve, reject) => {
      chrome.stderr.on('data', (chunk: Buffer) => {
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(chunk.toString());
        if (match) resolve(match[1]);
      });
      chrome.once('error', reject);
      chrome.once('exit', code => reject(new Error(`Chrome exited early (${code})`)));
    });

    const httpBase = browserWsUrl.replace('ws://', 'http://').replace(/\/devtools\/.*/, '');
    await new Promise(r => setTimeout(r, 800));

    const targets = parseTargetList(await (await fetch(`${httpBase}/json/list`)).text());
    const pageTarget = targets.find(t => t.type === 'page' && !t.url.startsWith('devtools://'));
    if (!pageTarget) throw new Error('No page target found.');

    let recordTargetWs = pageTarget.webSocketDebuggerUrl;

    if (withDevTools) {
      const wsHost = pageTarget.webSocketDebuggerUrl.replace(/^ws:\/\//, '');
      const inspectorUrl = `devtools://devtools/bundled/inspector.html?ws=${wsHost}`;
      const browserSession = await connectCdpSession(browserWsUrl);
      const {targetId} = await browserSession.send('Target.createTarget', {url: inspectorUrl});
      browserSession.close();

      await new Promise(r => setTimeout(r, 2000));
      const updatedTargets = parseTargetList(await (await fetch(`${httpBase}/json/list`)).text());
      const inspectorTarget = updatedTargets.find(t => t.id === targetId);
      if (!inspectorTarget) throw new Error('Failed to find inspector.html target.');
      recordTargetWs = inspectorTarget.webSocketDebuggerUrl;
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
    chrome.kill();
    await rm(userDataDir, {recursive: true, force: true});
  }
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli();
}
