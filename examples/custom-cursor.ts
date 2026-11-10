/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live `pointermove` / `pointerdown` custom cursor + expanding click ring for Loom-style recordings.
 * Hides the system cursor (`cursor: none !important`) and tracks native pointer events 1:1 — works
 * identically for manual human browsing (via `Page.addScriptToEvaluateOnNewDocument`) or Playwright
 * scripts using `page.addInitScript(...)` and smooth `page.mouse.move()` sweeps.
 *
 * Usage:
 *   node examples/custom-cursor.ts [output.mp4]
 */

import {chromium, type Page} from 'playwright-core';
import {findChromeBinary, startRecording} from '../src/playwright.ts';

interface CursorTheme {
  width: number;
  height: number;
  fill: string;
  stroke: string;
  ringColor: string;
  ringFill: string;
  ringSize: number;
}

/** Customize the cursor SVG, size, and click ring appearance here. */
const CURSOR_THEME: CursorTheme = {
  width: 24,
  height: 36,
  fill: '#06b6d4',
  stroke: '#ffffff',
  ringColor: 'rgba(34, 211, 238, 0.95)',
  ringFill: 'rgba(6, 182, 212, 0.25)',
  ringSize: 64,
};

/**
 * Browser-side init script (runs in page context via `page.addInitScript` or CDP
 * `Page.addScriptToEvaluateOnNewDocument`). Tracks every live pointer event with zero tween lag.
 */
function installCustomCursor(theme: CursorTheme): void {
  let host: HTMLElement | undefined;
  let root: ShadowRoot | undefined;
  let cursorBox: HTMLDivElement | undefined;
  let cursorSvg: SVGSVGElement | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  function ensureOverlay(): void {
    if (!document.documentElement) return;
    if (!document.getElementById('custom-cursor-hide-style')) {
      const style = document.createElement('style');
      style.id = 'custom-cursor-hide-style';
      style.textContent = '*, *::before, *::after { cursor: none !important; }';
      (document.head ?? document.documentElement).appendChild(style);
    }
    if (host?.isConnected) return;

    host = document.createElement('x-custom-cursor');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    root = host.attachShadow({mode: 'open'});

    // Keep position (`transform: translate3d`) on an outer box so `scale` on the inner SVG
    // only squishes around the pointer tip instead of scaling the viewport translation vector.
    cursorBox = document.createElement('div');
    cursorBox.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 12 18');
    svg.style.cssText = [
      'display:block',
      `width:${theme.width}px`,
      `height:${theme.height}px`,
      'overflow:visible',
      'transform-origin:0 0',
      'transition:scale 80ms ease-out',
      'filter:drop-shadow(0 2px 5px rgba(0,0,0,0.45))',
    ].join(';');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M0 0 L0 15.8 L3.9 12.4 L6.6 18.6 L8.9 17.6 L6.2 11.4 L11.2 11.4 Z');
    path.setAttribute('fill', theme.fill);
    path.setAttribute('stroke', theme.stroke);
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('paint-order', 'stroke');
    svg.appendChild(path);
    cursorBox.appendChild(svg);
    root.appendChild(cursorBox);
    cursorSvg = svg;
    document.documentElement.appendChild(host);
  }

  function spawnClickRing(x: number, y: number): void {
    if (!root) return;
    const half = theme.ringSize / 2;
    const ring = document.createElement('div');
    ring.style.cssText = [
      'position:fixed',
      `left:${x}px`,
      `top:${y}px`,
      `width:${theme.ringSize}px`,
      `height:${theme.ringSize}px`,
      `margin:${-half}px 0 0 ${-half}px`,
      'border-radius:50%',
      'border:3px solid #ffffff',
      `box-shadow:0 0 0 3px ${theme.ringColor}`,
      `background:${theme.ringFill}`,
      'pointer-events:none',
      'box-sizing:border-box',
    ].join(';');
    root.appendChild(ring);
    ring.animate([
      {opacity: 1, transform: 'scale(0.2)'},
      {opacity: 0, transform: 'scale(1)'},
    ], {duration: 480, easing: 'cubic-bezier(0.16, 1, 0.3, 1)'}).onfinish = () => ring.remove();
  }

  function moveCursor(x: number, y: number): void {
    ensureOverlay();
    if (!cursorBox) return;
    cursorBox.style.visibility = 'visible';
    cursorBox.style.opacity = '1';
    cursorBox.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (cursorBox) cursorBox.style.opacity = '0';
    }, 2500);
  }

  window.addEventListener('pointermove', e => moveCursor(e.clientX, e.clientY), {capture: true, passive: true});
  window.addEventListener('pointerdown', (e) => {
    moveCursor(e.clientX, e.clientY);
    if (cursorSvg) cursorSvg.style.scale = '0.82';
    spawnClickRing(e.clientX, e.clientY);
  }, {capture: true, passive: true});
  window.addEventListener('pointerup', () => {
    if (cursorSvg) cursorSvg.style.scale = '1';
  }, {capture: true, passive: true});
  window.addEventListener('pointercancel', () => {
    if (cursorSvg) cursorSvg.style.scale = '1';
  }, {capture: true, passive: true});
}

const DEMO_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: #0f172a; font: 600 17px/1.4 system-ui, sans-serif; color: #f8fafc; }
  .card { display: grid; gap: 22px; padding: 40px 44px; border-radius: 18px; background: #1e293b; box-shadow: 0 20px 50px rgba(0,0,0,0.45); width: 520px; }
  .label { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; }
  .row { display: flex; gap: 16px; align-items: center; justify-content: space-between; }
  button { padding: 14px 22px; border: 0; border-radius: 10px; background: #334155; color: #f8fafc; font: inherit; transition: transform 90ms, background 120ms, box-shadow 120ms; }
  button:hover { background: #475569; box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.35); }
  button:active { transform: scale(0.95); }
  button.primary { background: #0891b2; }
  button.primary:hover { background: #06b6d4; }
  button.on, button.on:hover { background: #10b981; }
  #status { color: #94a3b8; font-weight: 500; min-height: 24px; }
</style>
</head>
<body>
  <div class="card">
    <div class="label">Live Pointer Overlay · Hover, Press &amp; Rapid Clicks</div>
    <div id="status">Hover or click any control...</div>
    <div class="row">
      <button id="preview">Hover Only</button>
      <button id="toggle" class="primary">Live Cursor: OFF</button>
      <button id="boost" class="primary">Clicks: 0</button>
    </div>
  </div>
  <script>
    let enabled = false;
    let count = 0;
    const status = document.getElementById('status');
    document.getElementById('toggle').addEventListener('click', (e) => {
      enabled = !enabled;
      e.currentTarget.textContent = 'Live Cursor: ' + (enabled ? 'ON' : 'OFF');
      e.currentTarget.classList.toggle('on', enabled);
      status.textContent = enabled ? 'Custom overlay enabled' : 'Custom overlay paused';
    });
    document.getElementById('boost').addEventListener('click', (e) => {
      count += 1;
      e.currentTarget.textContent = 'Clicks: ' + count;
      status.textContent = 'Fired click #' + count;
    });
  </script>
</body>
</html>`;

interface PointerPos {
  x: number;
  y: number;
}

/** Move Playwright's mouse along an eased arc so live `pointermove` events stream smoothly. */
async function glideToSelector(page: Page, pos: PointerPos, selector: string): Promise<PointerPos> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`Missing bounding box for ${selector}`);
  const targetX = box.x + box.width / 2;
  const targetY = box.y + box.height / 2;

  const steps = 32;
  const bow = Math.hypot(targetX - pos.x, targetY - pos.y) * 0.08;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const arc = Math.sin(t * Math.PI) * bow;
    const x = pos.x + (targetX - pos.x) * ease;
    const y = pos.y + (targetY - pos.y) * ease - arc;
    await page.mouse.move(x, y);
    await page.waitForTimeout(8);
  }
  pos.x = targetX;
  pos.y = targetY;
  return pos;
}

/** Press and hold briefly so pointerdown squish, `:active`, and click ring read cleanly. */
async function clickCurrent(page: Page): Promise<void> {
  await page.mouse.down();
  await page.waitForTimeout(90);
  await page.mouse.up();
}

const outputPath = process.argv[2] ?? 'custom-cursor-demo.mp4';
const browser = await chromium.launch({
  executablePath: await findChromeBinary(),
  headless: false,
});

try {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}});
  await page.addInitScript(installCustomCursor, CURSOR_THEME);
  await page.goto(`data:text/html,${encodeURIComponent(DEMO_HTML)}`, {waitUntil: 'domcontentloaded'});

  const pos: PointerPos = {x: 240, y: 240};
  await page.mouse.move(pos.x, pos.y);

  console.log('[*] Recording live pointermove/pointerdown overlay...');
  {
    await using _recording = await startRecording(page, {
      frameRate: 120,
      maxWidth: 1280,
      maxHeight: 720,
      outputPath,
    });

    await glideToSelector(page, pos, '#preview');
    await page.waitForTimeout(350);

    await glideToSelector(page, pos, '#toggle');
    await clickCurrent(page);
    await page.waitForTimeout(350);

    await glideToSelector(page, pos, '#boost');
    await clickCurrent(page);
    await page.waitForTimeout(160);
    await clickCurrent(page);
    await page.waitForTimeout(550);
  }
  console.log(`[+] Saved ${outputPath}`);
} finally {
  await browser.close();
}
