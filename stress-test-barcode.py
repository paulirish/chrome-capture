#!/usr/bin/env python3
# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
"""macOS ProMotion (90Hz/120Hz) & Hardware-GPU Stress Test for CDP Page.startScreenRecording.

Zero external Python dependencies (requires only Python 3.10+, Chrome M153+, and ffmpeg).

Usage:
  python3 stress-test-barcode.py
  python3 stress-test-barcode.py --out-dir=./recordings
  python3 stress-test-barcode.py --headless
  python3 stress-test-barcode.py --chrome="/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
"""

import argparse
import base64
import json
import os
import platform
import re
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.request


MAC_CHROME_CANDIDATES = [
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-unstable",
]


def find_chrome(explicit_path: str | None) -> str:
  if explicit_path:
    if not os.path.exists(explicit_path):
      raise FileNotFoundError(f"Specified Chrome binary not found: {explicit_path}")
    return explicit_path
  for cand in MAC_CHROME_CANDIDATES:
    if os.path.exists(cand):
      return cand
  raise FileNotFoundError(
      "Could not find Google Chrome (M153+). Pass --chrome='/path/to/Google Chrome'"
  )


class MiniCdpClient:
  """Zero-dependency WebSocket CDP client."""

  def __init__(self, ws_url: str):
    u = ws_url.replace("ws://", "")
    host_port, path = u.split("/", 1)
    host, port = host_port.split(":")
    self.sock = socket.create_connection((host, int(port)), timeout=60)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        f"GET /{path} HTTP/1.1\r\n"
        f"Host: {host_port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    )
    self.sock.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
      buf += self.sock.recv(4096)
    self._leftover = buf.split(b"\r\n\r\n", 1)[1]
    self._msg_id = 0

  def _recv_exact(self, n: int) -> bytes:
    out = b""
    if self._leftover:
      take = min(n, len(self._leftover))
      out += self._leftover[:take]
      self._leftover = self._leftover[take:]
    while len(out) < n:
      chunk = self.sock.recv(min(65536, n - len(out)))
      if not chunk:
        raise EOFError("WebSocket closed")
      out += chunk
    return out

  def recv_frame(self) -> str:
    hdr = self._recv_exact(2)
    length = hdr[1] & 0x7F
    if length == 126:
      length = struct.unpack(">H", self._recv_exact(2))[0]
    elif length == 127:
      length = struct.unpack(">Q", self._recv_exact(8))[0]
    return self._recv_exact(length).decode("utf-8", errors="replace")

  def call(self, method: str, params: dict | None = None, session_id: str | None = None) -> dict:
    self._msg_id += 1
    mid = self._msg_id
    msg = {"id": mid, "method": method, "params": params or {}}
    if session_id:
      msg["sessionId"] = session_id
    data = json.dumps(msg).encode("utf-8")
    frame = bytearray([0x81])
    length = len(data)
    if length < 126:
      frame.append(0x80 | length)
    elif length < 65536:
      frame.append(0x80 | 126)
      frame.extend(struct.pack(">H", length))
    else:
      frame.append(0x80 | 127)
      frame.extend(struct.pack(">Q", length))
    mask = os.urandom(4)
    frame.extend(mask)
    frame.extend(bytes(data[i] ^ mask[i & 3] for i in range(length)))
    self.sock.sendall(frame)
    while True:
      resp = json.loads(self.recv_frame())
      if resp.get("id") == mid:
        if "error" in resp:
          raise RuntimeError(f"CDP {method} failed: {resp['error']}")
        return resp.get("result", {})

  def close(self):
    try:
      self.sock.close()
    except OSError:
      pass


BARCODE_CANVAS_HTML = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; overflow: hidden; background: #0b0f19; }
  canvas { display: block; width: 100vw; height: 100vh; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<script>
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { alpha: false });
const W = window.innerWidth;
const H = window.innerHeight;
canvas.width = W;
canvas.height = H;

window.__rafCount = 0;
window.__startTime = performance.now();
const BLOCK_W = 24;
const BLOCK_H = 32;

function drawBarcode(frameIdx) {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, BLOCK_W * 20, BLOCK_H + 8);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, BLOCK_W, BLOCK_H);
  ctx.fillStyle = '#000000';
  ctx.fillRect(BLOCK_W, 0, BLOCK_W, BLOCK_H);
  for (let b = 0; b < 16; b++) {
    const bit = (frameIdx >> (15 - b)) & 1;
    ctx.fillStyle = bit ? '#ffffff' : '#000000';
    ctx.fillRect((b + 2) * BLOCK_W, 0, BLOCK_W, BLOCK_H);
  }
}

function render(now) {
  window.__rafCount++;
  const f = window.__rafCount;
  const hue1 = (f * 3) % 360;
  const grad = ctx.createLinearGradient(0, BLOCK_H + 8, W, H);
  grad.addColorStop(0, `hsl(${hue1}, 75%, 22%)`);
  grad.addColorStop(1, `hsl(${(hue1 + 140) % 360}, 80%, 24%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, BLOCK_H + 8, W, H - (BLOCK_H + 8));

  for (let i = 0; i < 16; i++) {
    const bx = ((f * (8 + i * 2) + i * 173) % (W + 200)) - 100;
    const by = BLOCK_H + 40 + ((i * 61) % Math.max(100, H - 180));
    ctx.fillStyle = `hsla(${(hue1 + i * 22) % 360}, 90%, 60%, 0.85)`;
    ctx.fillRect(bx, by, 120, 36);
  }

  const elapsed = (now - window.__startTime) / 1000;
  const fps = elapsed > 0 ? (f / elapsed).toFixed(1) : '0.0';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.fillRect(24, BLOCK_H + 24, 540, 110);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 28px monospace';
  ctx.fillText(`RES: ${W}x${H} | rAF FRAME: #${f}`, 40, BLOCK_H + 68);
  ctx.fillStyle = '#38bdf8';
  ctx.fillText(`IN-PAGE rAF: ${fps} FPS | t=${elapsed.toFixed(2)}s`, 40, BLOCK_H + 110);

  drawBarcode(f);
  requestAnimationFrame(render);
}
requestAnimationFrame(render);
</script>
</body>
</html>
"""


def decode_barcodes(video_path: str) -> dict:
  crop_w = 18 * 24
  crop_h = 8
  raw = subprocess.check_output([
      "ffmpeg", "-v", "error", "-i", video_path,
      "-vsync", "0",
      "-vf", f"crop={crop_w}:{crop_h}:0:12,format=gray",
      "-f", "rawvideo", "pipe:1",
  ])
  stride = crop_w * crop_h
  n_frames = len(raw) // stride
  probe = json.loads(subprocess.check_output([
      "ffprobe", "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,duration",
      "-show_entries", "format=duration,size", "-of", "json", video_path,
  ], text=True))
  stream = (probe.get("streams") or [{}])[0]
  fmt = probe.get("format") or {}
  dur = float(stream.get("duration") or fmt.get("duration") or 0.0)
  size_kb = int(fmt.get("size") or os.path.getsize(video_path)) / 1024.0

  barcodes = []
  for i in range(n_frames):
    fbuf = raw[i * stride : (i + 1) * stride]
    row = 4 * crop_w
    if fbuf[row + 12] < 160 or fbuf[row + 36] > 96:
      continue
    val = 0
    for b in range(16):
      val = (val << 1) | (1 if fbuf[row + (b + 2) * 24 + 12] >= 128 else 0)
    barcodes.append(val)

  unique = len(set(barcodes))
  dups = sum(1 for i in range(1, len(barcodes)) if barcodes[i] == barcodes[i - 1])
  return {
      "duration_sec": round(dur, 2),
      "container_frames": n_frames,
      "container_fps": round(n_frames / dur, 1) if dur > 0 else 0.0,
      "unique_frames": unique,
      "unique_visual_fps": round(unique / dur, 1) if dur > 0 else 0.0,
      "duplicate_pct": round(100.0 * dups / max(1, len(barcodes)), 1),
      "size_kb": round(size_kb, 1),
  }


def run_case(
    chrome_bin: str,
    headless: bool,
    width: int,
    height: int,
    fps: int,
    uncap: bool,
    duration: float,
    save_path: str | None = None,
) -> dict:
  s = socket.socket()
  s.bind(("127.0.0.1", 0))
  port = s.getsockname()[1]
  s.close()

  tmpdir = tempfile.mkdtemp(prefix="mac_cdp_rec_")
  args = [
      chrome_bin,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      f"--user-data-dir={tmpdir}",
      f"--window-size={width},{height}",
      f"--remote-debugging-port={port}",
      "about:blank",
  ]
  if headless:
    args.insert(1, "--headless=new")
  if platform.system() == "Linux":
    args.extend(["--no-sandbox", "--disable-dev-shm-usage"])
  if uncap:
    args.extend(["--disable-frame-rate-limit", "--disable-gpu-vsync"])

  proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
  out_mp4 = save_path or os.path.join(tmpdir, "out.mp4")
  try:
    ws_url = None
    for _ in range(100):
      try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1) as r:
          info = json.loads(r.read().decode())
          ws_url = info["webSocketDebuggerUrl"]
          browser_ver = info.get("Browser", "unknown")
          break
      except Exception:
        time.sleep(0.05)
    if not ws_url:
      raise RuntimeError("Failed to connect to Chrome debugging port")

    cdp = MiniCdpClient(ws_url)
    targets = cdp.call("Target.getTargets")["targetInfos"]
    page_target = next(t for t in targets if t["type"] == "page")
    sid = cdp.call("Target.attachToTarget", {"targetId": page_target["targetId"], "flatten": True})["sessionId"]
    cdp.call("Page.enable", {}, sid)
    cdp.call("Runtime.enable", {}, sid)
    cdp.call("Emulation.setDeviceMetricsOverride", {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": False}, sid)
    fid = cdp.call("Page.getFrameTree", {}, sid)["frameTree"]["frame"]["id"]
    cdp.call("Page.setDocumentContent", {"frameId": fid, "html": BARCODE_CANVAS_HTML}, sid)
    time.sleep(0.6)

    raf0 = cdp.call("Runtime.evaluate", {"expression": "window.__rafCount", "returnByValue": True}, sid)["result"]["value"]
    t0 = time.time()
    handle = cdp.call("Page.startScreenRecording", {"frameRate": fps, "maxWidth": width, "maxHeight": height, "audio": False}, sid)["stream"]
    time.sleep(duration)
    t1 = time.time()
    raf1 = cdp.call("Runtime.evaluate", {"expression": "window.__rafCount", "returnByValue": True}, sid)["result"]["value"]
    cdp.call("Page.stopScreenRecording", {}, sid)
    with open(out_mp4, "wb") as f:
      while True:
        chunk = cdp.call("IO.read", {"handle": handle}, sid)
        if chunk.get("data"):
          f.write(base64.b64decode(chunk["data"]) if chunk.get("base64Encoded") else chunk["data"].encode("utf-8"))
        if chunk.get("eof"):
          break
    cdp.call("IO.close", {"handle": handle}, sid)
    t2 = time.time()
    cdp.close()

    m = decode_barcodes(out_mp4)
    m["browser"] = browser_ver
    m["in_page_raf_fps"] = round((raf1 - raf0) / (t1 - t0), 1)
    m["finalize_ms"] = round((t2 - t1) * 1000.0, 1)
    if save_path:
      m["video_path"] = save_path
    return m
  finally:
    proc.terminate()
    try:
      proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
      proc.kill()
      proc.wait(timeout=5)
    shutil.rmtree(tmpdir, ignore_errors=True)


def main():
  parser = argparse.ArgumentParser(description="Mac ProMotion & 4K Stress Test for CDP Page.startScreenRecording")
  parser.add_argument("--chrome", default=None, help="Path to Google Chrome (M153+)")
  parser.add_argument("--headless", action="store_true", help="Run in --headless=new mode (default on Mac is headed to use ProMotion CVDisplayLink)")
  parser.add_argument("--duration", type=float, default=4.0, help="Recording duration per test case in seconds (default: 4.0)")
  parser.add_argument("--out-dir", default=None, help="Optional directory to persist recorded .mp4 files for mpv/ffprobe inspection")
  args = parser.parse_args()

  chrome_bin = find_chrome(args.chrome)
  if args.out_dir:
    os.makedirs(args.out_dir, exist_ok=True)
  print(f"[*] Chrome binary: {chrome_bin}")
  print(f"[*] Host OS: {platform.platform()} ({platform.machine()}) | Mode: {'Headless' if args.headless else 'Headed (ProMotion CVDisplayLink + Hardware GPU)'}\n")

  cases = [
      ("1080p @ 60fps (Native VSync)", 1920, 1080, 60, False),
      ("1080p @ 90fps (Native ProMotion VSync)", 1920, 1080, 90, False),
      ("1080p @ 90fps (Uncapped VSync)", 1920, 1080, 90, True),
      ("1080p @ 120fps (Native ProMotion VSync)", 1920, 1080, 120, False),
      ("1080p @ 120fps (Uncapped VSync)", 1920, 1080, 120, True),
      ("1440p @ 60fps (Native VSync)", 2560, 1440, 60, False),
      ("4K (3840x2160) @ 30fps (Native VSync)", 3840, 2160, 30, False),
      ("4K (3840x2160) @ 60fps (Native VSync)", 3840, 2160, 60, False),
      ("4K (3840x2160) @ 60fps (Uncapped VSync)", 3840, 2160, 60, True),
  ]

  rows = []
  for label, w, h, fps, uncap in cases:
    print(f"Running {label}...")
    save_path = None
    if args.out_dir:
      slug = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
      save_path = os.path.join(args.out_dir, f"{slug}.mp4")
    m = run_case(chrome_bin, args.headless, w, h, fps, uncap, args.duration, save_path=save_path)
    rows.append((label, fps, m))
    print(f"  -> rAF: {m['in_page_raf_fps']} fps | Container: {m['container_fps']} fps | True Unique Visual: {m['unique_visual_fps']} fps | Finalize: {m['finalize_ms']} ms\n")

  print("\n### Markdown Results Table\n")
  print("| Test Case | Target FPS | In-Page `rAF` FPS | Container FPS | **True Unique Visual FPS** | Duplicate Frames | Finalize Latency | Size (4s MP4) |")
  print("| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |")
  for label, fps, m in rows:
    print(
        f"| {label} | {fps} | {m['in_page_raf_fps']} | {m['container_fps']} |"
        f" **{m['unique_visual_fps']}** ({m['unique_frames']}/{m['container_frames']}) |"
        f" {m['duplicate_pct']}% | {m['finalize_ms']} ms | {m['size_kb']} KB |"
    )


if __name__ == "__main__":
  main()
