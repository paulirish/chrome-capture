/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Restyled animated DOM cursor + click ring over raw CDP (no Playwright/Puppeteer needed).
 * Adapts Playwright's 30-step bowed Bezier curve (`cursorPathKeyframes`) for scripted jumps,
 * separates hover moves from clicks, squishes on mousedown, and spawns an expanding click ring.
 *
 * Usage:
 *   node examples/raw-cdp-cursor.ts [output.mp4]
 */

import {
  connectCdpSession,
  launchChrome,
  startRecording,
  type CdpSessionLike,
} from '../src/index.ts';

/** Customize the SVG pointer and click ripple appearance here. */
const CURSOR_THEME = {
  width: 22,
  height: 33,
  fill: '#f43f5e',
  stroke: '#ffffff',
  ringColor: 'rgba(244, 63, 94, 0.95)',
  ringFill: 'rgba(244, 63, 94, 0.25)',
  ringSize: 64,
};

const CURSOR_INIT_SCRIPT = `((theme) => {
  let host, root, cursorEl, fadeTimer;

  function ensureOverlay() {
    if (host?.isConnected || !document.documentElement) return;
    host = document.createElement('x-cdp-cursor');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    root = host.attachShadow({mode: 'open'});

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 12 18');
    svg.style.cssText = [
      'position:fixed',
      'left:0',
      'top:0',
      'width:' + theme.width + 'px',
      'height:' + theme.height + 'px',
      'overflow:visible',
      'visibility:hidden',
      'pointer-events:none',
      'transform-origin:0 0',
      'transition:scale 90ms ease-out',
      'filter:drop-shadow(0 2px 4px rgba(0,0,0,0.45))',
    ].join(';');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M0 0 L0 15.8 L3.9 12.4 L6.6 18.6 L8.9 17.6 L6.2 11.4 L11.2 11.4 Z');
    path.setAttribute('fill', theme.fill);
    path.setAttribute('stroke', theme.stroke);
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('paint-order', 'stroke');
    svg.appendChild(path);
    root.appendChild(svg);
    cursorEl = svg;
    document.documentElement.appendChild(host);
  }

  function cursorPathKeyframes(dx, dy, seed) {
    const random = (salt) => {
      const v = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
      return v - Math.floor(v);
    };
    const distance = Math.hypot(dx, dy);
    const normalX = -dy / distance;
    const normalY = dx / distance;
    const side = random(1) < 0.5 ? -1 : 1;
    const startBow = side * distance * (0.03 + 0.03 * random(2));
    const endBow = side * distance * (0.01 + 0.02 * random(3));
    const c1x = (dx * 2) / 3 + normalX * startBow;
    const c1y = (dy * 2) / 3 + normalY * startBow;
    const c2x = dx / 3 + normalX * endBow;
    const c2y = dy / 3 + normalY * endBow;
    const steps = 30;
    const keyframes = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const px = u * u * u * dx + 3 * u * u * t * c1x + 3 * u * t * t * c2x;
      const py = u * u * u * dy + 3 * u * u * t * c1y + 3 * u * t * t * c2y;
      keyframes.push({transform: \`translate(\${px.toFixed(1)}px, \${py.toFixed(1)}px)\`});
    }
    return keyframes;
  }

  function spawnRing(x, y) {
    if (!root) return;
    const ring = document.createElement('div');
    const half = theme.ringSize / 2;
    ring.style.cssText = [
      'position:fixed',
      'left:' + x + 'px',
      'top:' + y + 'px',
      'width:' + theme.ringSize + 'px',
      'height:' + theme.ringSize + 'px',
      'margin:' + -half + 'px 0 0 ' + -half + 'px',
      'border-radius:50%',
      'border:3px solid #ffffff',
      'box-shadow:0 0 0 3px ' + theme.ringColor,
      'background:' + theme.ringFill,
      'pointer-events:none',
      'box-sizing:border-box',
    ].join(';');
    root.appendChild(ring);
    ring.animate([
      {opacity: 1, transform: 'scale(0.2)'},
      {opacity: 0, transform: 'scale(1)'},
    ], {duration: 480, easing: 'cubic-bezier(0.16, 1, 0.3, 1)'}).onfinish = () => ring.remove();
  }

  window.__cdpMoveCursor = async (x, y, fadeMs = 1500) => {
    ensureOverlay();
    if (!cursorEl) return;
    clearTimeout(fadeTimer);
    cursorEl.getAnimations().forEach(a => a.cancel());

    const from = cursorEl.getBoundingClientRect();
    const wasVisible = cursorEl.style.visibility === 'visible';
    cursorEl.style.left = x + 'px';
    cursorEl.style.top = y + 'px';
    cursorEl.style.opacity = '1';
    cursorEl.style.visibility = 'visible';

    const dx = from.left - x;
    const dy = from.top - y;
    const dist = Math.hypot(dx, dy);
    if (wasVisible && dist >= 1) {
      const duration = Math.min(Math.max(dist * 0.9, 220), 500);
      await cursorEl.animate(cursorPathKeyframes(dx, dy, x + y + dx + dy), {
        duration,
        easing: 'cubic-bezier(0.5, 0, 0.3, 1)',
      }).finished.catch(() => {});
    }

    fadeTimer = setTimeout(() => {
      cursorEl.animate([{opacity: 1}, {opacity: 0}], {duration: 300, fill: 'forwards'});
    }, fadeMs);
  };

  window.__cdpPressCursor = (down, x, y) => {
    ensureOverlay();
    if (!cursorEl) return;
    cursorEl.style.scale = down ? '0.82' : '1';
    if (down) spawnRing(x, y);
  };
})(${JSON.stringify(CURSOR_THEME)});`;

const DEMO_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: #0f172a; font: 600 18px/1.4 system-ui, sans-serif; color: #f8fafc; }
  .card { display: grid; gap: 22px; padding: 40px 44px; border-radius: 18px; background: #1e293b; box-shadow: 0 20px 50px rgba(0,0,0,0.4); text-align: center; min-width: 520px; }
  .label { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; }
  .row { display: flex; gap: 24px; justify-content: center; }
  button { padding: 14px 26px; border: 0; border-radius: 10px; background: #3b82f6; color: #fff; font: inherit; cursor: pointer; transition: transform 100ms, background 120ms, box-shadow 120ms; }
  button:hover { background: #2563eb; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.35); }
  button:active { transform: scale(0.95); }
  button.active { background: #10b981; }
  #status { color: #cbd5e1; font-weight: 500; }
</style>
</head>
<body>
  <div class="card">
    <div class="label">Raw CDP · Scripted Bezier + Click Ring</div>
    <div id="status">Waiting for input...</div>
    <div class="row">
      <button id="alpha">Alpha</button>
      <button id="beta">Beta</button>
      <button id="gamma">Gamma</button>
    </div>
  </div>
  <script>
    for (const btn of document.querySelectorAll('button')) {
      btn.addEventListener('click', () => {
        document.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('status').textContent = 'Clicked ' + btn.textContent;
      });
    }
  </script>
</body>
</html>`;

/** Wait until a selector resolves in the current document, then return its viewport center. */
async function waitForCenter(session: CdpSessionLike, selector: string): Promise<{x: number; y: number}> {
  for (let i = 0; i < 40; i++) {
    const {result} = await session.send('Runtime.evaluate', {
      expression: `(() => {
        const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
        return r ? {x: r.left + r.width / 2, y: r.top + r.height / 2} : null;
      })()`,
      returnByValue: true,
    });
    const val = result.value;
    if (val && typeof val === 'object' && typeof val.x === 'number' && typeof val.y === 'number') {
      return {x: val.x, y: val.y};
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Selector not found: ${selector}`);
}

/** Glide the custom SVG cursor to `selector` and trigger real hover state without clicking. */
async function hoverWithCursor(session: CdpSessionLike, selector: string): Promise<{x: number; y: number}> {
  const {x, y} = await waitForCenter(session, selector);
  await session.send('Runtime.evaluate', {
    expression: `window.__cdpMoveCursor?.(${x}, ${y})`,
    awaitPromise: true,
  });
  await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
  return {x, y};
}

/** Glide to `selector`, squish cursor + spawn click ring on mousePressed, then release. */
async function clickWithCursor(session: CdpSessionLike, selector: string): Promise<void> {
  const {x, y} = await hoverWithCursor(session, selector);
  await new Promise(r => setTimeout(r, 60));
  await session.send('Runtime.evaluate', {expression: `window.__cdpPressCursor?.(true, ${x}, ${y})`});
  await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1});
  await new Promise(r => setTimeout(r, 90));
  await session.send('Runtime.evaluate', {expression: `window.__cdpPressCursor?.(false, ${x}, ${y})`});
  await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1});
}

const outputPath = process.argv[2] ?? 'raw-cdp-cursor-demo.mp4';
const chrome = await launchChrome({width: 1280, height: 720, headless: false});

try {
  const session = await connectCdpSession(chrome.pageTargetWs);
  try {
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    // Register before navigating so the cursor helper is installed on every new document
    // before page scripts run and persists across navigations and reloads.
    await session.send('Page.addScriptToEvaluateOnNewDocument', {source: CURSOR_INIT_SCRIPT});
    await session.send('Page.navigate', {url: `data:text/html,${encodeURIComponent(DEMO_HTML)}`});
    await waitForCenter(session, '#alpha');

    console.log('[*] Recording raw CDP cursor choreography...');
    {
      await using _recording = await startRecording(session, {
        frameRate: 120,
        maxWidth: 1280,
        maxHeight: 720,
        outputPath,
      });

      await hoverWithCursor(session, '#beta');
      await new Promise(r => setTimeout(r, 350));
      await clickWithCursor(session, '#alpha');
      await new Promise(r => setTimeout(r, 400));
      await clickWithCursor(session, '#gamma');
      await new Promise(r => setTimeout(r, 400));
      await clickWithCursor(session, '#beta');
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`[+] Saved ${outputPath}`);
  } finally {
    session.close();
  }
} finally {
  await chrome.close();
}
