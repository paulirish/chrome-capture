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
 */

import {spawn, type ChildProcess} from 'node:child_process';
import {access, mkdir, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {homedir, platform, tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import type {Protocol} from 'devtools-protocol';
import type {ProtocolMapping} from 'devtools-protocol/types/protocol-mapping.js';
import type {Page as PlaywrightPage} from 'playwright-core';
import type {Page as PuppeteerPage} from 'puppeteer-core';

export interface ScreenRecordingOptions extends Protocol.Page.StartScreenRecordingRequest {
  outputPath?: string;
}

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

export class CdpScreenRecorder {
  readonly session: CdpSessionLike;

  constructor(session: CdpSessionLike) {
    this.session = session;
  }

  /**
   * Starts native CDP screen recording (AV1 video + optional 48kHz stereo Opus loopback audio in MP4).
   *
   * NOTE on >60fps and VSync:
   * - On macOS with a ProMotion display (90Hz/120Hz) in headed mode, `CVDisplayLink` drives
   *   `ExternalBeginFrameSourceMac` at up to 120Hz natively — sustaining 89.4 unique fps at
   *   1080p@90, 120.2 unique fps at 1080p@120, and 60.2 unique fps at 2160p (3840x2160)@60.
   * - Do NOT pass `--disable-frame-rate-limit --disable-gpu-vsync` on hardware-accelerated
   *   macOS: switching to `BackToBackBeginFrameSource` spins in-page `rAF` at 1,600-9,800 fps,
   *   flooding the Viz GPU compositor command queue and starving `FrameSinkVideoCapturerImpl`
   *   readback down to 0.3-11.7 fps.
   */
  async start(options: ScreenRecordingOptions = {}): Promise<Protocol.IO.StreamHandle> {
    const {outputPath: _outputPath, ...cdpOptions} = options;
    const request: Protocol.Page.StartScreenRecordingRequest = {
      frameRate: 60,
      ...cdpOptions,
    };
    const {stream} = await this.session.send('Page.startScreenRecording', request);
    return stream;
  }

  /**
   * Stops the active recording, drains the `IO.StreamHandle`, and returns the MP4 bytes.
   */
  async stop(): Promise<Buffer> {
    const {stream: handle} = await this.session.send('Page.stopScreenRecording');
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
    const timer = connectTimeoutMs > 0
      ? setTimeout(() => {
          try { ws.close(); } catch {}
          reject(new Error(`WebSocket connection timed out after ${connectTimeoutMs}ms: ${wsUrl}`));
        }, connectTimeoutMs)
      : undefined;

    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once: true});
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`WebSocket connection failed: ${wsUrl}`)); }, {once: true});
  });

  type CommandReturn = ProtocolMapping.Commands[keyof ProtocolMapping.Commands]['returnType'];
  let nextId = 1;
  let isClosed = false;
  const pending = new Map<number, {resolve: (val: CommandReturn) => void; reject: (err: Error) => void}>();

  const rejectAllPending = (err: Error) => {
    isClosed = true;
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  };

  ws.addEventListener('close', () => rejectAllPending(new Error(`WebSocket connection closed: ${wsUrl}`)));
  ws.addEventListener('error', () => rejectAllPending(new Error(`WebSocket error on connection: ${wsUrl}`)));
  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(String(event.data)) as {id?: number; result?: CommandReturn; error?: {code: number; message: string}};
      const entry = typeof msg?.id === 'number' ? pending.get(msg.id) : undefined;
      if (!entry || typeof msg.id !== 'number') return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else entry.resolve(msg.result as CommandReturn);
    } catch {}
  });

  return {
    send<K extends keyof ProtocolMapping.Commands>(
      method: K,
      ...args: ProtocolMapping.Commands[K]['paramsType']
    ): Promise<ProtocolMapping.Commands[K]['returnType']> {
      if (isClosed) return Promise.reject(new Error(`Cannot send CDP command ${String(method)}: WebSocket is closed`));
      const id = nextId++;
      const {promise, resolve, reject} = Promise.withResolvers<ProtocolMapping.Commands[K]['returnType']>();
      pending.set(id, {resolve: resolve as (val: CommandReturn) => void, reject});
      try {
        ws.send(JSON.stringify({id, method, params: args[0] ?? {}}));
      } catch (err) {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
      return promise;
    },
    close() {
      isClosed = true;
      try { ws.close(); } catch {}
      rejectAllPending(new Error(`WebSocket closed by client: ${wsUrl}`));
    },
  };
}

/**
 * Resolves the path to a Google Chrome (M153+) binary.
 * If explicitPath is given, checks existence and throws if missing.
 * Otherwise checks CHROME_PATH, standard OS locations, and Puppeteer cache.
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
    } catch {}
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
    } catch {}
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
  } catch {}

  throw new Error('Could not find Google Chrome (M153+). Set CHROME_PATH or pass --chrome=/path/to/chrome');
}

/**
 * Launches Chrome with a dedicated temporary user-data-dir and resolves the WebSocket endpoint and initial page target.
 */
export async function launchChrome(options: LaunchChromeOptions = {}): Promise<LaunchedChrome> {
  const chromePath = await findChromeBinary(options.explicitPath);
  const userDataDir = await mkdtemp(join(tmpdir(), 'cdp-rec-'));

  const chromeArgs = [
    (options.headless ?? true) ? '--headless=new' : '',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${options.width ?? 1280},${options.height ?? 720}`,
    '--remote-debugging-port=0',
    ...(platform() === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ...(options.audio ? ['--autoplay-policy=no-user-gesture-required'] : []),
    ...(options.uncap ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []),
    ...(options.extraArgs ?? []),
    options.url ?? 'about:blank',
  ].filter(Boolean);

  const proc = spawn(chromePath, chromeArgs, {stdio: ['ignore', 'ignore', 'pipe']});

  let cleanedUp = false;
  const sigintHandler = () => void cleanup().finally(() => process.exit(130));
  const sigtermHandler = () => void cleanup().finally(() => process.exit(143));
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
    proc.stderr?.destroy();
    if (proc.exitCode === null && proc.signalCode === null) {
      const exitPromise = new Promise<void>(resolve => proc.once('exit', () => resolve()));
      try { proc.kill('SIGTERM'); } catch {}
      const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 500);
      killTimer.unref();
      await exitPromise;
      clearTimeout(killTimer);
    }
    proc.unref();
    await rm(userDataDir, {recursive: true, force: true}).catch(() => {});
  };

  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigtermHandler);

  try {
    const browserWsUrl = await new Promise<string>((resolve, reject) => {
      let stderrAcc = '';
      const cleanupListeners = () => {
        proc.stderr?.off('data', onData);
        proc.off('error', onError);
        proc.off('exit', onExit);
      };
      const onData = (chunk: Buffer) => {
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderrAcc += chunk.toString());
        if (match) {
          cleanupListeners();
          proc.stderr?.destroy();
          resolve(match[1]);
        }
      };
      const onError = (err: Error) => { cleanupListeners(); reject(err); };
      const onExit = (code: number | null) => { cleanupListeners(); reject(new Error(`Chrome exited early (${code})`)); };
      proc.stderr?.on('data', onData);
      proc.once('error', onError);
      proc.once('exit', onExit);
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

    if (!pageTargetWs) throw new Error('Timed out waiting for Chrome page target');

    return {
      proc,
      browserWsUrl,
      pageTargetWs,
      userDataDir,
      close: cleanup,
    };
  } catch (err) {
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
  if (val == null || String(val).trim() === '') return defaultMs;
  const match = /^([0-9]*\.?[0-9]+)\s*(ms|s)?$/i.exec(String(val).trim());
  if (!match) throw new Error(`Invalid duration value: ${val}`);
  const num = parseFloat(match[1]);
  if (num <= 0) throw new Error(`Invalid duration value: ${val}`);
  return match[2]?.toLowerCase() === 's' || (!match[2] && num < 1000) ? num * 1000 : num;
}

export interface PlaywrightPageLike {
  context(): {
    newCDPSession(page: PlaywrightPageLike | PlaywrightPage): Promise<CdpSessionLike & {detach(): Promise<void>}>;
  };
}

export interface PuppeteerPageLike {
  createCDPSession(): Promise<CdpSessionLike & {detach(): Promise<void>}>;
}

export interface ActiveRecording {
  recorder: CdpScreenRecorder;
  stop: (outPath?: string) => Promise<Buffer>;
  [Symbol.asyncDispose]: () => Promise<void>;
}

export type RecordingTarget =
  | PlaywrightPage
  | PlaywrightPageLike
  | PuppeteerPage
  | PuppeteerPageLike
  | CdpSessionLike;

function isPlaywrightPage(target: RecordingTarget): target is PlaywrightPageLike {
  return typeof target === 'object' && target !== null && 'context' in target && typeof target.context === 'function';
}

function isPuppeteerPage(target: RecordingTarget): target is PuppeteerPageLike {
  return typeof target === 'object' && target !== null && 'createCDPSession' in target && typeof target.createCDPSession === 'function';
}

function isCdpSession(target: RecordingTarget): target is CdpSessionLike {
  return typeof target === 'object' && target !== null && 'send' in target && typeof target.send === 'function';
}

/**
 * Universal recording entrypoint supporting Playwright Page, Puppeteer Page, and raw CDP session.
 * Returns an ActiveRecording handle compatible with `await using` (`Symbol.asyncDispose`).
 */
export async function startRecording(
  target: RecordingTarget,
  options: ScreenRecordingOptions = {},
): Promise<ActiveRecording> {
  let session: CdpSessionLike;
  let detachSession: (() => Promise<void>) | undefined;

  if (isPlaywrightPage(target)) {
    const cdpSession = await target.context().newCDPSession(target);
    session = cdpSession;
    detachSession = () => cdpSession.detach().catch(() => {});
  } else if (isPuppeteerPage(target)) {
    const cdpSession = await target.createCDPSession();
    session = cdpSession;
    detachSession = () => cdpSession.detach().catch(() => {});
  } else if (isCdpSession(target)) {
    session = target;
  } else {
    throw new Error('Unsupported recording target: must be a Playwright Page, Puppeteer Page, or CDP session.');
  }

  const recorder = new CdpScreenRecorder(session);
  await recorder.start(options);

  let stopPromise: Promise<Buffer> | undefined;
  const writtenPaths = new Set<string>();
  const stop = async (outPath?: string): Promise<Buffer> => {
    stopPromise ??= recorder.stop().finally(() => detachSession?.());
    const buf = await stopPromise;
    const effectiveOutPath = outPath ?? options.outputPath;
    if (effectiveOutPath && !writtenPaths.has(effectiveOutPath)) {
      writtenPaths.add(effectiveOutPath);
      await mkdir(dirname(effectiveOutPath), {recursive: true});
      await writeFile(effectiveOutPath, buf);
    }
    return buf;
  };

  return {
    recorder,
    stop,
    async [Symbol.asyncDispose]() {
      await stop();
    },
  };
}
