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

import {chromium} from 'playwright-core';
import {findChromeBinary, startRecording} from '../../src/playwright.ts';

export interface CursorPreset {
  kind?: 'arrow' | 'puck';
  color?: string;
  size?: number;
  badge?: string;
}

declare global {
  interface Window {
    setCursorPreset?: (preset: CursorPreset) => void;
  }
}

/**
 * Browser-side init script (runs in page context via `page.addInitScript` or CDP
 * `Page.addScriptToEvaluateOnNewDocument`). Tracks every live pointer event with zero tween lag.
 */
function installCustomCursor(initialPreset: CursorPreset = {}): void {
  let preset: CursorPreset = {kind: 'arrow', color: '#f43f5e', size: 32, ...initialPreset};
  const allowMotion = window.matchMedia('(prefers-reduced-motion: no-preference)').matches;

  let host: HTMLElement | undefined;
  let root: ShadowRoot | undefined;
  let cursorEl: HTMLDivElement | undefined;
  let stageEl: HTMLDivElement | undefined;
  let badgeEl: HTMLSpanElement | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let tiltTimer: ReturnType<typeof setTimeout> | undefined;
  let lastX = 0;
  let lastT = 0;

  function applyPreset(next: CursorPreset): void {
    preset = {...preset, ...next, badge: next.badge};
    if (!host || !cursorEl || !stageEl || !badgeEl) return;
    host.dataset.kind = preset.kind ?? 'arrow';
    cursorEl.style.setProperty('--color', preset.color ?? '#f43f5e');
    cursorEl.style.setProperty('--size', `${preset.size ?? 32}px`);
    badgeEl.textContent = preset.badge ?? '';
    badgeEl.hidden = !preset.badge;
    stageEl.style.rotate = '0deg';
  }

  function ensureOverlay(): ShadowRoot | undefined {
    if (!document.documentElement) return undefined;
    if (!document.getElementById('custom-cursor-hide-style')) {
      const pageStyle = document.createElement('style');
      pageStyle.id = 'custom-cursor-hide-style';
      pageStyle.textContent = '*, *::before, *::after { cursor: none !important; }';
      (document.head ?? document.documentElement).appendChild(pageStyle);
    }
    if (host?.isConnected && root) return root;

    host = document.createElement('x-custom-cursor');
    root = host.attachShadow({mode: 'open'});
    // Keep viewport translation on `.cursor` so `scale` / `rotate` on `.stage`
    // anchor strictly at `(0, 0)` instead of scaling the `(x, y)` viewport offset.
    root.innerHTML = `
      <style>
        :host { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
        [hidden] { display: none !important; }
        .cursor {
          position: fixed; left: 0; top: 0; visibility: hidden; opacity: 0;
          transition: opacity 250ms ease;
        }
        .stage { position: relative; transform-origin: 0 0; }
        @media (prefers-reduced-motion: no-preference) {
          .stage {
            transition: scale 240ms ease-out, rotate 130ms ease-out;
            transition-timing-function: linear(0, 0.45 12%, 0.88 26%, 1.08 42%, 1.02 58%, 0.99 76%, 1), ease-out;
          }
        }
        .arrow {
          display: block; width: var(--size); height: calc(var(--size) * 1.5);
          overflow: visible; filter: drop-shadow(0 3px 6px rgba(0, 0, 0, 0.5));
        }
        .arrow path {
          fill: var(--color); stroke: #fff; stroke-width: 1.7;
          stroke-linejoin: round; paint-order: stroke;
        }
        .puck {
          display: none; position: absolute;
          left: calc(var(--size) / -2); top: calc(var(--size) / -2);
          width: var(--size); height: var(--size); border-radius: 50%;
          background: color-mix(in srgb, var(--color) 32%, transparent);
          border: 2.5px solid var(--color);
          box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.65), 0 6px 18px rgba(0, 0, 0, 0.45);
          backdrop-filter: blur(3px);
        }
        .badge {
          position: absolute; left: calc(var(--size) * 0.68); top: calc(var(--size) * 0.72);
          padding: 3px 10px; border-radius: 999px;
          background: var(--color); color: #fff; border: 1.5px solid rgba(255, 255, 255, 0.9);
          font: 700 13px/1.2 system-ui, -apple-system, sans-serif;
          white-space: nowrap; box-shadow: 0 6px 16px rgba(0, 0, 0, 0.45);
        }
        :host([data-kind="puck"]) .arrow, :host([data-kind="puck"]) .badge { display: none; }
        :host([data-kind="puck"]) .puck { display: block; }
        .burst {
          position: fixed; width: 80px; height: 80px; translate: -50% -50%;
          border-radius: 50%; box-sizing: border-box;
          background: color-mix(in srgb, var(--burst) 22%, transparent);
          border: 3.5px solid #fff; box-shadow: 0 0 0 3.5px var(--burst);
          animation: ring-out 500ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        .burst::before {
          content: ''; position: absolute; inset: 0; margin: auto;
          width: 18px; height: 18px; border-radius: 50%; background: #fff;
          animation: core-pop 180ms ease-out forwards;
        }
        @keyframes ring-out { from { opacity: 1; scale: 0.18; } to { opacity: 0; scale: 1; } }
        @keyframes core-pop { from { opacity: 0.95; scale: 2.2; } to { opacity: 0; scale: 1; } }
      </style>
      <div class="cursor">
        <div class="stage">
          <svg class="arrow" viewBox="0 0 12 18">
            <path d="M0 0 L0 15.8 L3.9 12.4 L6.6 18.6 L8.9 17.6 L6.2 11.4 L11.2 11.4 Z" />
          </svg>
          <div class="puck"></div>
          <span class="badge" hidden></span>
        </div>
      </div>
    `;

    cursorEl = root.querySelector<HTMLDivElement>('.cursor') ?? undefined;
    stageEl = root.querySelector<HTMLDivElement>('.stage') ?? undefined;
    badgeEl = root.querySelector<HTMLSpanElement>('.badge') ?? undefined;
    document.documentElement.appendChild(host);
    applyPreset(preset);
    return root;
  }

  function moveCursor(x: number, y: number): void {
    ensureOverlay();
    if (!cursorEl || !stageEl) return;

    const now = performance.now();
    if (allowMotion && lastT > 0 && preset.kind !== 'puck') {
      const vx = (x - lastX) / Math.max(8, now - lastT);
      stageEl.style.rotate = `${Math.max(-9, Math.min(9, vx * 4.5)).toFixed(1)}deg`;
      clearTimeout(tiltTimer);
      tiltTimer = setTimeout(() => {
        if (stageEl) stageEl.style.rotate = '0deg';
      }, 70);
    }
    lastX = x;
    lastT = now;

    cursorEl.style.visibility = 'visible';
    cursorEl.style.opacity = '1';
    cursorEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;

    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (cursorEl) cursorEl.style.opacity = '0';
    }, 2500);
  }

  window.setCursorPreset = applyPreset;
  window.addEventListener('pointermove', e => moveCursor(e.clientX, e.clientY), {capture: true, passive: true});
  window.addEventListener('pointerdown', (e) => {
    const r = ensureOverlay();
    moveCursor(e.clientX, e.clientY);
    if (stageEl) stageEl.style.scale = '0.78';
    if (!r) return;
    const burst = document.createElement('div');
    burst.className = 'burst';
    burst.style.cssText = `left:${e.clientX}px;top:${e.clientY}px;--burst:${preset.color ?? '#f43f5e'}`;
    burst.addEventListener('animationend', ev => ev.animationName === 'ring-out' && burst.remove());
    r.appendChild(burst);
  }, {capture: true, passive: true});
  window.addEventListener('pointerup', () => {
    if (stageEl) stageEl.style.scale = '1';
  }, {capture: true, passive: true});
  window.addEventListener('pointercancel', () => {
    if (stageEl) stageEl.style.scale = '1';
  }, {capture: true, passive: true});
}

const outputPath = process.argv[2] ?? 'custom-cursor-demo.mp4';
const browser = await chromium.launch({
  executablePath: await findChromeBinary(),
  headless: false,
});

try {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}});
  await page.addInitScript(installCustomCursor);
  await page.goto(new URL('./index.html', import.meta.url).href, {waitUntil: 'domcontentloaded'});

  let x = 240;
  let y = 260;
  await page.mouse.move(x, y);
  await page.waitForTimeout(180);

  /** Sweep Playwright's mouse along an eased arc so live `pointermove` events stream smoothly. */
  const hover = async (selector: string, settleMs = 340) => {
    const box = await page.locator(selector).boundingBox();
    if (!box) throw new Error(`Missing bounding box for ${selector}`);
    const tx = box.x + box.width / 2;
    const ty = box.y + box.height / 2;
    const dist = Math.hypot(tx - x, ty - y);
    if (dist >= 2) {
      const steps = 30;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        await page.mouse.move(
          x + (tx - x) * ease,
          y + (ty - y) * ease - Math.sin(t * Math.PI) * dist * 0.08,
        );
        await page.waitForTimeout(8);
      }
      x = tx;
      y = ty;
    }
    if (settleMs > 0) await page.waitForTimeout(settleMs);
  };

  const click = async (selector: string, settleMs = 400) => {
    await hover(selector, 0);
    await page.mouse.down();
    await page.waitForTimeout(95);
    await page.mouse.up();
    await page.waitForTimeout(settleMs);
  };

  console.log('[*] Recording live cursor restyling showcase...');
  {
    await using _recording = await startRecording(page, {
      frameRate: 120,
      maxWidth: 1280,
      maxHeight: 720,
      outputPath,
    });

    await hover('#hover-target');
    await click('#pulse-btn');
    await click('#preset-agent');
    await click('#rec-toggle');
    await click('#preset-touch');
    await click('#pulse-btn', 170);
    await click('#pulse-btn', 600);
  }
  console.log(`[+] Saved ${outputPath}`);
} finally {
  await browser.close();
}
