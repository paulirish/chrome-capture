#!/usr/bin/env python3
# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
"""Correlate ffprobe packet PTS/DTS against decoded 16-bit rAF pixel barcodes.

Zero external Python dependencies (requires Python 3.10+, ffprobe, and ffmpeg).

Usage:
  python3 benchmarks/analyze_mp4.py recordings/*.mp4
  python3 benchmarks/analyze_mp4.py --dir=./recordings
  python3 benchmarks/analyze_mp4.py --timeline recordings/1080p_90fps_native_promotion_vsync.mp4
"""

import argparse
import glob
import json
import math
import os
import statistics
import subprocess


def percentile(sorted_vals: list[float], p: float) -> float:
  if not sorted_vals:
    return 0.0
  k = (len(sorted_vals) - 1) * (p / 100.0)
  f = math.floor(k)
  c = math.ceil(k)
  if f == c:
    return sorted_vals[int(k)]
  return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


def inspect_file(path: str, include_timeline: bool = False) -> dict:
  probe = json.loads(subprocess.check_output([
      "ffprobe", "-v", "error", "-select_streams", "v:0",
      "-show_streams", "-show_format",
      "-show_packets", "-show_entries",
      "packet=pts,pts_time,dts,dts_time,duration,duration_time,size,flags,pos",
      "-of", "json", path,
  ], text=True))

  stream = probe["streams"][0]
  fmt = probe["format"]
  packets = probe.get("packets", [])

  # Decode 16-bit barcodes with -vsync 0 so packet index == decoded frame index
  crop_w = 18 * 24
  crop_h = 8
  raw = subprocess.check_output([
      "ffmpeg", "-v", "error", "-i", path,
      "-vsync", "0",
      "-vf", f"crop={crop_w}:{crop_h}:0:12,format=gray",
      "-f", "rawvideo", "pipe:1",
  ])
  stride = crop_w * crop_h
  n_decoded = len(raw) // stride
  barcodes = []
  for i in range(n_decoded):
    fbuf = raw[i * stride : (i + 1) * stride]
    row = 4 * crop_w
    if fbuf[row + 12] < 160 or fbuf[row + 36] > 96:
      barcodes.append(None)
      continue
    val = 0
    for b in range(16):
      val = (val << 1) | (1 if fbuf[row + (b + 2) * 24 + 12] >= 128 else 0)
    barcodes.append(val)

  pts_times = [float(p["pts_time"]) for p in packets if "pts_time" in p]
  dts_times = [float(p["dts_time"]) for p in packets if "dts_time" in p]
  sizes = [int(p["size"]) for p in packets]
  keyframes = [i for i, p in enumerate(packets) if "K" in p.get("flags", "")]

  deltas_ms = [(pts_times[i] - pts_times[i - 1]) * 1000.0 for i in range(1, len(pts_times))]
  zero_or_neg_pts = [
      (i, round(pts_times[i - 1] * 1000, 3), round(pts_times[i] * 1000, 3))
      for i in range(1, len(pts_times))
      if pts_times[i] <= pts_times[i - 1]
  ]
  non_mono_dts = [
      (i, round(dts_times[i - 1] * 1000, 3), round(dts_times[i] * 1000, 3))
      for i in range(1, len(dts_times))
      if dts_times[i] <= dts_times[i - 1]
  ]

  raf_deltas = []
  dup_pairs = []
  for i in range(1, min(len(barcodes), len(pts_times))):
    b0, b1 = barcodes[i - 1], barcodes[i]
    if b0 is not None and b1 is not None:
      dr = b1 - b0
      raf_deltas.append(dr)
      if dr == 0:
        dup_pairs.append((i, b1, round((pts_times[i] - pts_times[i - 1]) * 1000.0, 3)))

  raf_delta_hist = {}
  for dr in raf_deltas:
    raf_delta_hist[dr] = raf_delta_hist.get(dr, 0) + 1

  s_deltas = sorted(deltas_ms)
  dur = float(stream.get("duration") or fmt.get("duration") or 0)
  kf_sizes = [sizes[i] for i in keyframes]
  non_kf_sizes = [sizes[i] for i in range(len(sizes)) if i not in set(keyframes)]

  out = {
      "file": os.path.basename(path),
      "codec": f"{stream.get('codec_name')} (profile={stream.get('profile')}, level={stream.get('level')})",
      "pix_fmt": stream.get("pix_fmt"),
      "color": f"{stream.get('color_range')}/{stream.get('color_space')}/{stream.get('color_transfer')}/{stream.get('color_primaries')}",
      "time_base": stream.get("time_base"),
      "r_frame_rate": stream.get("r_frame_rate"),
      "avg_frame_rate": stream.get("avg_frame_rate"),
      "duration_s": round(dur, 4),
      "bitrate_kbps": round((int(fmt.get("size", 0)) * 8) / dur / 1000.0, 1) if dur > 0 else 0,
      "packets": len(packets),
      "decoded": n_decoded,
      "unique_barcodes": len({b for b in barcodes if b is not None}),
      "keyframes": len(keyframes),
      "kf_indices": keyframes[:12],
      "kf_avg_kb": round(statistics.mean(kf_sizes) / 1024, 1) if kf_sizes else 0,
      "inter_avg_kb": round(statistics.mean(non_kf_sizes) / 1024, 1) if non_kf_sizes else 0,
      "pts_delta_ms": {
          "min": round(s_deltas[0], 3) if s_deltas else 0,
          "p05": round(percentile(s_deltas, 5), 3),
          "p50": round(percentile(s_deltas, 50), 3),
          "p95": round(percentile(s_deltas, 95), 3),
          "p99": round(percentile(s_deltas, 99), 3),
          "max": round(s_deltas[-1], 3) if s_deltas else 0,
          "mean": round(statistics.mean(deltas_ms), 3) if deltas_ms else 0,
          "stdev": round(statistics.pstdev(deltas_ms), 3) if deltas_ms else 0,
      },
      "zero_or_neg_pts_deltas": zero_or_neg_pts,
      "non_mono_dts": non_mono_dts,
      "raf_delta_hist": dict(sorted(raf_delta_hist.items())),
      "dup_barcode_events": dup_pairs[:10],
      "first_5_pts_ms": [round(x * 1000, 3) for x in pts_times[:5]],
      "last_5_pts_ms": [round(x * 1000, 3) for x in pts_times[-5:]],
  }

  if include_timeline:
    timeline = []
    for i in range(len(pts_times)):
      dpts = round((pts_times[i] - pts_times[i - 1]) * 1000.0, 3) if i > 0 else 0.0
      b_cur = barcodes[i] if i < len(barcodes) else None
      b_prev = barcodes[i - 1] if i > 0 and (i - 1) < len(barcodes) else None
      draf = (b_cur - b_prev) if (b_cur is not None and b_prev is not None) else None
      timeline.append({
          "idx": i,
          "pts_ms": round(pts_times[i] * 1000.0, 3),
          "dpts_ms": dpts,
          "size_b": sizes[i],
          "key": "K" in packets[i].get("flags", ""),
          "barcode": b_cur,
          "draf": draf,
      })
    out["timeline"] = timeline

  return out


def main():
  parser = argparse.ArgumentParser(description="Correlate ffprobe PTS/DTS with 16-bit rAF barcodes.")
  parser.add_argument("files", nargs="*", help="MP4/WebM recording paths to inspect")
  parser.add_argument("--dir", default=None, help="Directory of .mp4/.webm recordings to inspect")
  parser.add_argument("--timeline", action="store_true", help="Include per-packet (dPTS, dRAF) timeline")
  args = parser.parse_args()

  targets = list(args.files)
  if args.dir:
    targets.extend(sorted(glob.glob(os.path.join(args.dir, "*.mp4"))))
    targets.extend(sorted(glob.glob(os.path.join(args.dir, "*.webm"))))
  if not targets:
    parser.error("Provide recording paths or --dir=<path>")

  results = [inspect_file(p, include_timeline=args.timeline) for p in targets]
  print(json.dumps(results, indent=2))


if __name__ == "__main__":
  main()
