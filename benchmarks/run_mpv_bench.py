#!/usr/bin/env python3
# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
"""Batch mpv telemetry runner using benchmarks/mpv_telemetry.lua.

Measures real display playback (VO drops, delayed frames, vsync jitter with
default audio sync vs --video-sync=display-resample) and untimed decode throughput
(hardware decode vs software libdav1d).

Usage:
  python3 benchmarks/run_mpv_bench.py recordings/*.mp4
  python3 benchmarks/run_mpv_bench.py --dir=./recordings --json-out=./recordings/mpv_bench.json
"""

import argparse
import glob
import json
import os
import shutil
import subprocess
import tempfile
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_LUA = os.path.join(SCRIPT_DIR, "mpv_telemetry.lua")

MODES = [
    ("gpu-next+hwdec+def", ["--vo=gpu-next", "--hwdec=auto-safe", "--autofit=960x540", "--ontop=no"]),
    ("gpu-next+hwdec+dr", ["--vo=gpu-next", "--hwdec=auto-safe", "--video-sync=display-resample", "--autofit=960x540", "--ontop=no"]),
    ("gpu-next+sw+dr", ["--vo=gpu-next", "--hwdec=no", "--video-sync=display-resample", "--autofit=960x540", "--ontop=no"]),
    ("null-untimed+hw", ["--vo=null", "--hwdec=auto-safe", "--untimed"]),
    ("null-untimed+sw", ["--vo=null", "--hwdec=no", "--untimed"]),
]


def find_mpv(explicit_path: str | None) -> str:
  if explicit_path:
    if not os.path.exists(explicit_path):
      raise FileNotFoundError(f"Specified mpv binary not found: {explicit_path}")
    return explicit_path
  if which_mpv := shutil.which("mpv"):
    return which_mpv
  mac_app = "/Applications/mpv.app/Contents/MacOS/mpv"
  if os.path.exists(mac_app):
    return mac_app
  raise FileNotFoundError("Could not find mpv. Install mpv or pass --mpv=/path/to/mpv")


def main():
  parser = argparse.ArgumentParser(description="Run mpv playback and decode telemetry across recordings.")
  parser.add_argument("files", nargs="*", help="Recording paths (.mp4/.webm)")
  parser.add_argument("--dir", default=None, help="Directory of .mp4/.webm recordings")
  parser.add_argument("--mpv", default=None, help="Path to mpv binary")
  parser.add_argument("--json-out", default=None, help="Optional path to write full JSON results")
  args = parser.parse_args()

  targets = list(args.files)
  if args.dir:
    targets.extend(sorted(glob.glob(os.path.join(args.dir, "*.mp4"))))
    targets.extend(sorted(glob.glob(os.path.join(args.dir, "*.webm"))))
  if not targets:
    parser.error("Provide recording paths or --dir=<path>")

  mpv_bin = find_mpv(args.mpv)
  tmpdir = tempfile.mkdtemp(prefix="mpv_bench_")
  out_json = os.path.join(tmpdir, "telemetry.json")

  results = []
  try:
    for fpath in targets:
      fname = os.path.basename(fpath)
      for mode_name, extra_args in MODES:
        if os.path.exists(out_json):
          os.remove(out_json)
        env = os.environ.copy()
        env["MPV_TELEMETRY_OUT"] = out_json
        cmd = [
            mpv_bin, "--no-config", "--no-audio", "--keep-open=no",
            f"--script={DEFAULT_LUA}",
            "--msg-level=all=warn,cplayer=status",
            *extra_args,
            fpath,
        ]
        t0 = time.perf_counter()
        proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=60)
        wall_s = time.perf_counter() - t0
        data = {}
        if os.path.exists(out_json):
          with open(out_json) as f:
            data = json.load(f)
        results.append({
            "file": fname,
            "mode": mode_name,
            "returncode": proc.returncode,
            "proc_wall_s": round(wall_s, 3),
            **data,
        })
        print(
            f"[{mode_name:18s}] {fname:42s} | hw={str(data.get('hwdec_current')):17s}"
            f" | vf_fps={data.get('estimated_vf_fps')}"
            f" | drops={data.get('frame_drop_count')}/{data.get('decoder_frame_drop_count')}"
            f" | delayed={data.get('vo_delayed_frame_count')}"
            f" | jitter={data.get('avg_vsync_jitter')}"
            f" | dec_wall={data.get('wall_elapsed_s')}s",
            flush=True,
        )
  finally:
    shutil.rmtree(tmpdir, ignore_errors=True)

  if args.json_out:
    with open(args.json_out, "w") as f:
      json.dump(results, f, indent=2)


if __name__ == "__main__":
  main()
