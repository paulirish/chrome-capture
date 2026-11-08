#!/usr/bin/env python3
# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
"""Static-idle -> 120Hz burst -> static-idle VFR & GOP inspector for CDP Page.startScreenRecording.

Zero external Python dependencies (requires Python 3.10+, Chrome M153+, ffprobe, and ffmpeg).

Usage:
  python3 benchmarks/vfr_burst_test.py
  python3 benchmarks/vfr_burst_test.py --out-dir=./recordings/vfr_burst
  python3 benchmarks/vfr_burst_test.py --headless --chrome="/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
"""

import argparse
import base64
import json
import os
import platform
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.request

CHROME_CANDIDATES = [
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome-unstable",
    "/usr/bin/google-chrome",
]


def find_chrome(explicit_path: str | None) -> str:
  if explicit_path:
    if not os.path.exists(explicit_path):
      raise FileNotFoundError(f"Specified Chrome binary not found: {explicit_path}")
    return explicit_path
  if env_path := os.environ.get("CHROME_PATH"):
    return env_path
  for cand in CHROME_CANDIDATES:
    if os.path.exists(cand):
      return cand
  raise FileNotFoundError("Could not find Chrome (M153+). Pass --chrome='/path/to/chrome'")


BURST_HTML = """<!DOCTYPE html>
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

const BLOCK_W = 24;
const BLOCK_H = 32;
let frameIdx = 0;
let running = false;

function drawBarcode(idx) {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, BLOCK_W * 20, BLOCK_H + 8);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, BLOCK_W, BLOCK_H);
  ctx.fillStyle = '#000000';
  ctx.fillRect(BLOCK_W, 0, BLOCK_W, BLOCK_H);
  for (let b = 0; b < 16; b++) {
    const bit = (idx >> (15 - b)) & 1;
    ctx.fillStyle = bit ? '#ffffff' : '#000000';
    ctx.fillRect((b + 2) * BLOCK_W, 0, BLOCK_W, BLOCK_H);
  }
}

function drawStatic(label) {
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#e5e7eb';
  ctx.font = 'bold 36px monospace';
  ctx.fillText(label + ' | frame #' + frameIdx, 40, 120);
  drawBarcode(frameIdx);
}

function tick() {
  if (!running) return;
  frameIdx++;
  const hue1 = (frameIdx * 3) % 360;
  const grad = ctx.createLinearGradient(0, BLOCK_H + 8, W, H);
  grad.addColorStop(0, `hsl(${hue1}, 75%, 22%)`);
  grad.addColorStop(1, `hsl(${(hue1 + 140) % 360}, 80%, 24%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, BLOCK_H + 8, W, H - (BLOCK_H + 8));

  for (let i = 0; i < 16; i++) {
    const bx = ((frameIdx * (8 + i * 2) + i * 173) % (W + 200)) - 100;
    const by = BLOCK_H + 40 + ((i * 61) % Math.max(100, H - 180));
    ctx.fillStyle = `hsla(${(hue1 + i * 22) % 360}, 90%, 60%, 0.85)`;
    ctx.fillRect(bx, by, 120, 36);
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 32px monospace';
  ctx.fillText('BURST #' + frameIdx, 40, 120);
  drawBarcode(frameIdx);
  requestAnimationFrame(tick);
}

window.__startBurst = () => {
  running = true;
  requestAnimationFrame(tick);
  return frameIdx;
};
window.__stopBurst = () => {
  running = false;
  drawStatic('IDLE AFTER');
  return frameIdx;
};

drawStatic('IDLE BEFORE');
</script>
</body>
</html>
"""


class MiniCdpClient:
  """Minimal zero-dependency WebSocket CDP client."""

  def __init__(self, ws_url: str):
    u = ws_url.replace("ws://", "")
    host_port, path = u.split("/", 1)
    host, port = host_port.split(":")
    self.sock = socket.create_connection((host, int(port)), timeout=60)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        f"GET /{path} HTTP/1.1\r\nHost: {host_port}\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
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


def record_burst(
    chrome_bin: str,
    headless: bool,
    label: str,
    w: int,
    h: int,
    fps: int,
    idle_s: float,
    burst_s: float,
    out_dir: str | None,
) -> dict:
  s = socket.socket()
  s.bind(("127.0.0.1", 0))
  port = s.getsockname()[1]
  s.close()

  tmpdir = tempfile.mkdtemp(prefix="vfr_burst_")
  out_mp4 = os.path.join(out_dir, f"{label}.mp4") if out_dir else os.path.join(tmpdir, f"{label}.mp4")
  args = [
      chrome_bin,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      f"--user-data-dir={tmpdir}",
      f"--window-size={w},{h}",
      f"--remote-debugging-port={port}",
      "about:blank",
  ]
  if headless:
    args.insert(1, "--headless=new")
  if platform.system() == "Linux":
    args.extend(["--no-sandbox", "--disable-dev-shm-usage"])

  proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
  try:
    ws_url = None
    for _ in range(100):
      try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1) as r:
          ws_url = json.loads(r.read().decode())["webSocketDebuggerUrl"]
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
    cdp.call("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False}, sid)
    fid = cdp.call("Page.getFrameTree", {}, sid)["frameTree"]["frame"]["id"]
    cdp.call("Page.setDocumentContent", {"frameId": fid, "html": BURST_HTML}, sid)
    time.sleep(0.5)

    t0 = time.monotonic()
    handle = cdp.call("Page.startScreenRecording", {"frameRate": fps, "maxWidth": w, "maxHeight": h, "audio": False}, sid)["stream"]
    time.sleep(idle_s)
    t_burst_start = time.monotonic() - t0
    cdp.call("Runtime.evaluate", {"expression": "window.__startBurst()", "returnByValue": True}, sid)
    time.sleep(burst_s)
    t_burst_stop = time.monotonic() - t0
    end_idx = cdp.call("Runtime.evaluate", {"expression": "window.__stopBurst()", "returnByValue": True}, sid)["result"]["value"]
    time.sleep(idle_s)
    t_end = time.monotonic() - t0
    cdp.call("Page.stopScreenRecording", {}, sid)

    with open(out_mp4, "wb") as f:
      while True:
        chunk = cdp.call("IO.read", {"handle": handle}, sid)
        if chunk.get("data"):
          f.write(base64.b64decode(chunk["data"]) if chunk.get("base64Encoded") else chunk["data"].encode("utf-8"))
        if chunk.get("eof"):
          break
    cdp.call("IO.close", {"handle": handle}, sid)
    cdp.close()

    probe = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_packets", "-show_entries", "packet=pts_time,size,flags", "-of", "json", out_mp4,
    ], text=True))
    packets = probe["packets"]
    raw = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", out_mp4, "-vsync", "0",
        "-vf", f"crop={18*24}:8:0:12,format=gray", "-f", "rawvideo", "pipe:1",
    ])
    stride = 18 * 24 * 8
    rows = []
    for i, p in enumerate(packets):
      fbuf = raw[i * stride : (i + 1) * stride] if i * stride < len(raw) else b""
      bval = None
      if len(fbuf) == stride:
        r = 4 * 18 * 24
        if fbuf[r + 12] >= 160 and fbuf[r + 36] <= 96:
          v = 0
          for b in range(16):
            v = (v << 1) | (1 if fbuf[r + (b + 2) * 24 + 12] >= 128 else 0)
          bval = v
      prev_pts = float(packets[i - 1]["pts_time"]) * 1000 if i > 0 else 0.0
      pts_ms = float(p["pts_time"]) * 1000
      rows.append({
          "idx": i,
          "pts_ms": round(pts_ms, 2),
          "dpts_ms": round(pts_ms - prev_pts, 2) if i > 0 else 0.0,
          "size_kb": round(int(p["size"]) / 1024, 2),
          "key": "K" in p.get("flags", ""),
          "barcode": bval,
      })

    summary = {
        "label": label,
        "burst_start_s": round(t_burst_start, 3),
        "burst_stop_s": round(t_burst_stop, 3),
        "total_wall_s": round(t_end, 3),
        "end_raf_idx": end_idx,
        "total_packets": len(rows),
        "size_kb": round(os.path.getsize(out_mp4) / 1024, 1),
        "keyframes": [r["idx"] for r in rows if r["key"]],
        "gaps_gt_25ms": [r for r in rows if r["dpts_ms"] > 25.0],
        "rows": rows,
    }
    if out_dir:
      with open(os.path.join(out_dir, f"{label}.json"), "w") as f:
        json.dump(summary, f, indent=2)

    print(f"=== {label}: {len(rows)} packets, end_raf={end_idx}, size={summary['size_kb']} KB ===")
    print(f"  Keyframes: {summary['keyframes']}")
    for g in summary["gaps_gt_25ms"]:
      print(f"  Gap >25ms: pkt #{g['idx']} pts={g['pts_ms']}ms (+{g['dpts_ms']}ms) size={g['size_kb']}KB key={g['key']} barcode={g['barcode']}")
    return summary
  finally:
    proc.terminate()
    try:
      proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
      proc.kill()
      proc.wait(timeout=5)
    shutil.rmtree(tmpdir, ignore_errors=True)


def main():
  parser = argparse.ArgumentParser(description="Static-idle -> 120Hz burst -> static-idle VFR & GOP inspector.")
  parser.add_argument("--chrome", default=None, help="Path to Google Chrome (M153+)")
  parser.add_argument("--headless", action="store_true", help="Run in --headless=new mode")
  parser.add_argument("--idle-sec", type=float, default=1.5, help="Idle duration before and after burst (default: 1.5)")
  parser.add_argument("--burst-sec", type=float, default=2.0, help="Active 120Hz motion burst duration (default: 2.0)")
  parser.add_argument("--out-dir", default=None, help="Optional directory to save MP4s and packet JSON")
  args = parser.parse_args()

  chrome_bin = find_chrome(args.chrome)
  if args.out_dir:
    os.makedirs(args.out_dir, exist_ok=True)

  record_burst(chrome_bin, args.headless, "1080p_120fps_burst", 1920, 1080, 120, args.idle_sec, args.burst_sec, args.out_dir)
  record_burst(chrome_bin, args.headless, "4k_60fps_burst", 3840, 2160, 60, args.idle_sec, args.burst_sec, args.out_dir)


if __name__ == "__main__":
  main()
