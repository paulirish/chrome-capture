/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live `pointermove` / `pointerdown` custom cursor + click burst for Loom / Screen Studio demos.
 * Hides the system cursor (`cursor: none !important`), tracks native pointer events 1:1, and exposes
 * `window.setCursorPreset(...)` to hot-swap cursor shapes, badges, and click shockwaves on the fly.
 *
 * Works identically for manual human browsing (via CDP `Page.addScriptToEvaluateOnNewDocument`) or
 * Playwright scripts using `page.addInitScript(...)` and smooth `page.mouse.move()` sweeps.
 *
 * The Shadow DOM "glass pane" overlay and `12×18` pointer SVG geometry are adapted from Playwright's
 * `highlight.ts` (thanks, Playwright team!):
 *   https://github.com/microsoft/playwright/blob/df1ca47b1eb95a907c559f54675e680a2b7ea901/packages/injected/src/highlight.ts
 *
 * Usage:
 *   node examples/custom-cursor/index.ts [output.mp4]
 */

import {chromium, type Page} from 'playwright-core';
import {findChromeBinary, startRecording} from '../../src/playwright.ts';

export interface CursorPreset {
  kind: 'arrow' | 'puck';
  size: number;
  fill: string;
  stroke: string;
  badge?: string;
  ringColor: string;
  ringFill: string;
  ringSize: number;
}

declare global {
  interface Window {
    setCursorPreset?: (preset: CursorPreset) => void;
  }
}

const INITIAL_PRESET: CursorPreset = {
  kind: 'arrow',
  size: 32,
  fill: '#f43f5e',
  stroke: '#ffffff',
  ringColor: 'rgba(244, 63, 94, 0.95)',
  ringFill: 'rgba(244, 63, 94, 0.22)',
  ringSize: 78,
};

/**
 * Browser-side init script (runs in page context via `page.addInitScript` or CDP
 * `Page.addScriptToEvaluateOnNewDocument`). Tracks every live pointer event with zero tween lag.
 */
function installCustomCursor(initialPreset: CursorPreset): void {
  let preset = initialPreset;
  let host: HTMLElement | undefined;
  let root: ShadowRoot | undefined;
  let cursorBox: HTMLDivElement | undefined;
  let cursorStage: HTMLDivElement | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let tiltTimer: ReturnType<typeof setTimeout> | undefined;
  let lastX = 0;
  let lastT = 0;

  const SPRING_EASING = 'linear(0, 0.45 12%, 0.88 26%, 1.08 42%, 1.02 58%, 0.99 76%, 1)';
  const allowMotion = window.matchMedia('(prefers-reduced-motion: no-preference)').matches;

  function renderCursorGraphic(): void {
    if (!cursorStage) return;
    cursorStage.replaceChildren();

    if (preset.kind === 'puck') {
      const puck = document.createElement('div');
      const half = preset.size / 2;
      puck.style.cssText = [
        'position:absolute',
        `left:${-half}px`,
        `top:${-half}px`,
        `width:${preset.size}px`,
        `height:${preset.size}px`,
        'border-radius:50%',
        `background:${preset.fill}`,
        `border:2.5px solid ${preset.stroke}`,
        'box-shadow:0 0 0 2px rgba(255,255,255,0.65), 0 6px 18px rgba(0,0,0,0.45)',
        'backdrop-filter:blur(3px)',
      ].join(';');
      cursorStage.appendChild(puck);
      return;
    }

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 12 18');
    const height = Math.round(preset.size * 1.5);
    svg.style.cssText = [
      'display:block',
      `width:${preset.size}px`,
      `height:${height}px`,
      'overflow:visible',
      'filter:drop-shadow(0 3px 6px rgba(0,0,0,0.5))',
    ].join(';');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M0 0 L0 15.8 L3.9 12.4 L6.6 18.6 L8.9 17.6 L6.2 11.4 L11.2 11.4 Z');
    path.setAttribute('fill', preset.fill);
    path.setAttribute('stroke', preset.stroke);
    path.setAttribute('stroke-width', '1.7');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('paint-order', 'stroke');
    svg.appendChild(path);
    cursorStage.appendChild(svg);

    if (preset.badge) {
      const pill = document.createElement('span');
      pill.textContent = preset.badge;
      pill.style.cssText = [
        'position:absolute',
        `left:${Math.round(preset.size * 0.68)}px`,
        `top:${Math.round(preset.size * 0.72)}px`,
        'padding:3px 10px',
        'border-radius:999px',
        `background:${preset.fill}`,
        'color:#ffffff',
        'border:1.5px solid rgba(255,255,255,0.9)',
        'font:700 13px/1.2 system-ui, -apple-system, sans-serif',
        'letter-spacing:0.01em',
        'white-space:nowrap',
        'box-shadow:0 6px 16px rgba(0,0,0,0.45)',
      ].join(';');
      cursorStage.appendChild(pill);
    }
  }

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

    // Keep viewport translation on `cursorBox` so `scale` / `rotate` on `cursorStage`
    // anchor strictly at `(0, 0)` instead of scaling the `(x, y)` viewport offset.
    cursorBox = document.createElement('div');
    cursorBox.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;';

    cursorStage = document.createElement('div');
    cursorStage.style.cssText = allowMotion
      ? [
          'position:relative',
          'transform-origin:0 0',
          'transition:scale 240ms ease-out, rotate 130ms ease-out',
          `transition-timing-function:${SPRING_EASING}, ease-out`,
        ].join(';')
      : 'position:relative;transform-origin:0 0;';

    renderCursorGraphic();
    cursorBox.appendChild(cursorStage);
    root.appendChild(cursorBox);
    document.documentElement.appendChild(host);
  }

  function spawnClickBurst(x: number, y: number): void {
    if (!root) return;

    const flash = document.createElement('div');
    flash.style.cssText = [
      'position:fixed',
      `left:${x}px`,
      `top:${y}px`,
      'width:18px',
      'height:18px',
      'margin:-9px 0 0 -9px',
      'border-radius:50%',
      'background:#ffffff',
      'pointer-events:none',
    ].join(';');
    root.appendChild(flash);
    flash.animate(
      [
        {opacity: 0.95, transform: 'scale(0.4)'},
        {opacity: 0, transform: 'scale(1.8)'},
      ],
      {duration: 180, easing: 'ease-out'},
    ).onfinish = () => flash.remove();

    const half = preset.ringSize / 2;
    const ring = document.createElement('div');
    ring.style.cssText = [
      'position:fixed',
      `left:${x}px`,
      `top:${y}px`,
      `width:${preset.ringSize}px`,
      `height:${preset.ringSize}px`,
      `margin:${-half}px 0 0 ${-half}px`,
      'border-radius:50%',
      'border:3.5px solid #ffffff',
      `box-shadow:0 0 0 3.5px ${preset.ringColor}`,
      `background:${preset.ringFill}`,
      'pointer-events:none',
      'box-sizing:border-box',
    ].join(';');
    root.appendChild(ring);
    ring.animate(
      [
        {opacity: 1, transform: 'scale(0.18)'},
        {opacity: 0, transform: 'scale(1)'},
      ],
      {duration: 500, easing: 'cubic-bezier(0.16, 1, 0.3, 1)'},
    ).onfinish = () => ring.remove();
  }

  function moveCursor(x: number, y: number): void {
    ensureOverlay();
    if (!cursorBox || !cursorStage) return;

    const now = performance.now();
    if (allowMotion && lastT > 0 && preset.kind === 'arrow') {
      const vx = (x - lastX) / Math.max(8, now - lastT);
      const tilt = Math.max(-9, Math.min(9, vx * 4.5));
      cursorStage.style.rotate = `${tilt.toFixed(1)}deg`;
      clearTimeout(tiltTimer);
      tiltTimer = setTimeout(() => {
        if (cursorStage) cursorStage.style.rotate = '0deg';
      }, 70);
    }
    lastX = x;
    lastT = now;

    cursorBox.style.visibility = 'visible';
    cursorBox.style.opacity = '1';
    cursorBox.style.transform = `translate3d(${x}px, ${y}px, 0)`;

    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (cursorBox) cursorBox.style.opacity = '0';
    }, 2500);
  }

  window.setCursorPreset = (next: CursorPreset) => {
    preset = next;
    ensureOverlay();
    if (cursorStage) cursorStage.style.rotate = '0deg';
    renderCursorGraphic();
  };

  window.addEventListener('pointermove', e => moveCursor(e.clientX, e.clientY), {capture: true, passive: true});
  window.addEventListener('pointerdown', (e) => {
    moveCursor(e.clientX, e.clientY);
    if (cursorStage) cursorStage.style.scale = '0.78';
    spawnClickBurst(e.clientX, e.clientY);
  }, {capture: true, passive: true});
  window.addEventListener('pointerup', () => {
    if (cursorStage) cursorStage.style.scale = '1';
  }, {capture: true, passive: true});
  window.addEventListener('pointercancel', () => {
    if (cursorStage) cursorStage.style.scale = '1';
  }, {capture: true, passive: true});
}

const DEMO_URL = new URL('./index.html', import.meta.url).href;

interface PointerPos {
  x: number;
  y: number;
}

/** Move Playwright's mouse along an eased arc so live `pointermove` events stream smoothly. */
async function glideToSelector(page: Page, pos: PointerPos, selector: string, steps = 34): Promise<PointerPos> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`Missing bounding box for ${selector}`);
  const targetX = box.x + box.width / 2;
  const targetY = box.y + box.height / 2;

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

/** Press and hold briefly so pointerdown squish, `:active`, and click burst read cleanly. */
async function clickCurrent(page: Page): Promise<void> {
  await page.mouse.down();
  await page.waitForTimeout(95);
  await page.mouse.up();
}

const outputPath = process.argv[2] ?? 'custom-cursor-demo.mp4';
const browser = await chromium.launch({
  executablePath: await findChromeBinary(),
  headless: false,
});

try {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}});
  await page.addInitScript(installCustomCursor, INITIAL_PRESET);
  await page.goto(DEMO_URL, {waitUntil: 'domcontentloaded'});

  const pos: PointerPos = {x: 240, y: 260};
  await page.mouse.move(pos.x, pos.y);
  await page.waitForTimeout(180);

  console.log('[*] Recording live cursor restyling showcase...');
  {
    await using _recording = await startRecording(page, {
      frameRate: 120,
      maxWidth: 1280,
      maxHeight: 720,
      outputPath,
    });

    // 1. Studio Arrow: hover without clicking, click counter once, then switch to Agent Badge
    await glideToSelector(page, pos, '#hover-target', 28);
    await page.waitForTimeout(320);

    await glideToSelector(page, pos, '#pulse-btn', 32);
    await clickCurrent(page);
    await page.waitForTimeout(380);

    await glideToSelector(page, pos, '#preset-agent', 30);
    await clickCurrent(page);
    await page.waitForTimeout(400);

    // 2. Agent Badge (@agent pill): toggle 120fps lock, then restyle to Touch Puck
    await glideToSelector(page, pos, '#rec-toggle', 28);
    await clickCurrent(page);
    await page.waitForTimeout(380);

    await glideToSelector(page, pos, '#preset-touch', 30);
    await clickCurrent(page);
    await page.waitForTimeout(400);

    // 3. Touch Puck: glide to counter and double-click for overlapping ripples
    await glideToSelector(page, pos, '#pulse-btn', 28);
    await clickCurrent(page);
    await page.waitForTimeout(170);
    await clickCurrent(page);
    await page.waitForTimeout(600);
  }
  console.log(`[+] Saved ${outputPath}`);
} finally {
  await browser.close();
}
