#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Batch mpv telemetry runner using benchmarks/mpv_telemetry.lua.
 *
 * Measures real display playback (VO drops, delayed frames, vsync jitter with
 * default audio sync vs --video-sync=display-resample) and untimed decode throughput
 * (hardware decode vs software libdav1d).
 *
 * Usage:
 *   node benchmarks/run-mpv-bench.ts recordings/*.mp4
 *   node benchmarks/run-mpv-bench.ts --dir=./recordings --json-out=./recordings/mpv_bench.json
 */

import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LUA = join(SCRIPT_DIR, 'mpv_telemetry.lua');

export interface MpvMode {
  name: string;
  args: string[];
}

export const MODES: MpvMode[] = [
  {name: 'gpu-next+hwdec+def', args: ['--vo=gpu-next', '--hwdec=auto-safe', '--autofit=960x540', '--ontop=no']},
  {name: 'gpu-next+hwdec+dr', args: ['--vo=gpu-next', '--hwdec=auto-safe', '--video-sync=display-resample', '--autofit=960x540', '--ontop=no']},
  {name: 'gpu-next+sw+dr', args: ['--vo=gpu-next', '--hwdec=no', '--video-sync=display-resample', '--autofit=960x540', '--ontop=no']},
  {name: 'null-untimed+hw', args: ['--vo=null', '--hwdec=auto-safe', '--untimed']},
  {name: 'null-untimed+sw', args: ['--vo=null', '--hwdec=no', '--untimed']},
];

export interface MpvTelemetryData {
  path?: string;
  reason?: string;
  wall_elapsed_s?: number;
  video_codec?: string;
  hwdec_current?: string;
  width?: number;
  height?: number;
  pixelformat?: string;
  hw_pixelformat?: string;
  colormatrix?: string;
  colorlevels?: string;
  container_fps?: number;
  display_fps?: number;
  estimated_vf_fps?: number;
  last_vf_fps?: number;
  estimated_display_fps?: number;
  frame_drop_count?: number;
  decoder_frame_drop_count?: number;
  mistimed_frame_count?: number;
  vo_delayed_frame_count?: number;
  avg_vsync_jitter?: number;
  max_vsync_jitter?: number;
  avg_bitrate_kbps?: number;
  sample_count?: number;
}

export interface MpvBenchmarkResult extends MpvTelemetryData {
  file: string;
  mode: string;
  returncode: number | null;
  proc_wall_s: number;
}

export function findMpv(explicitPath?: string): string {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(`Specified mpv binary not found: ${explicitPath}`);
    }
    return explicitPath;
  }

  const whichProc = spawnSync('which', ['mpv'], {encoding: 'utf8'});
  if (whichProc.status === 0 && whichProc.stdout.trim()) {
    return whichProc.stdout.trim();
  }

  const macApp = '/Applications/mpv.app/Contents/MacOS/mpv';
  if (existsSync(macApp)) {
    return macApp;
  }

  throw new Error('Could not find mpv. Install mpv or pass --mpv=/path/to/mpv');
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      dir: {type: 'string'},
      mpv: {type: 'string'},
      'json-out': {type: 'string'},
      help: {type: 'boolean', short: 'h'},
    },
    allowPositionals: true,
  });

  if (parsed.values.help) {
    console.log(`Usage: node benchmarks/run-mpv-bench.ts [files...] [options]

Run mpv playback and decode telemetry across recordings.

Options:
  --dir=<path>         Directory of .mp4/.webm recordings
  --mpv=<path>         Path to mpv binary
  --json-out=<path>    Optional path to write full JSON results
  -h, --help           Show this help message
`);
    return;
  }

  const targets = [...parsed.positionals];
  if (parsed.values.dir) {
    const dir = parsed.values.dir;
    targets.push(
      ...readdirSync(dir)
        .filter(f => f.endsWith('.mp4') || f.endsWith('.webm'))
        .map(f => join(dir, f)),
    );
  }

  if (targets.length === 0) {
    console.error('Error: Provide recording paths or --dir=<path>');
    process.exit(1);
  }

  const mpvBin = findMpv(parsed.values.mpv);
  const tempDir = await mkdtemp(join(tmpdir(), 'mpv_bench_'));
  const outJson = join(tempDir, 'telemetry.json');

  const results: MpvBenchmarkResult[] = [];

  try {
    for (const fpath of targets) {
      const fname = basename(fpath);
      for (const mode of MODES) {
        if (existsSync(outJson)) {
          rmSync(outJson, {force: true});
        }

        const env = {
          ...process.env,
          MPV_TELEMETRY_OUT: outJson,
        };

        const cmdArgs = [
          '--no-config',
          '--no-audio',
          '--keep-open=no',
          `--script=${DEFAULT_LUA}`,
          '--msg-level=all=warn,cplayer=status',
          ...mode.args,
          fpath,
        ];

        const t0 = performance.now();
        const proc = spawnSync(mpvBin, cmdArgs, {
          env,
          encoding: 'utf8',
          timeout: 60000,
        });
        const wallS = (performance.now() - t0) / 1000.0;

        let data: MpvTelemetryData = {};
        if (existsSync(outJson)) {
          try {
            data = JSON.parse(readFileSync(outJson, 'utf8')) as MpvTelemetryData;
          } catch {
            // Ignore corrupted json
          }
        }

        const entry: MpvBenchmarkResult = {
          file: fname,
          mode: mode.name,
          returncode: proc.status,
          proc_wall_s: Math.round(wallS * 1000) / 1000,
          ...data,
        };
        results.push(entry);

        const modeCol = mode.name.padEnd(18);
        const fileCol = fname.padEnd(42);
        const hwCol = String(data.hwdec_current ?? 'none').padEnd(17);
        console.log(
          `[${modeCol}] ${fileCol} | hw=${hwCol} | vf_fps=${data.estimated_vf_fps ?? 'n/a'} | drops=${data.frame_drop_count ?? 0}/${data.decoder_frame_drop_count ?? 0} | delayed=${data.vo_delayed_frame_count ?? 0} | jitter=${data.avg_vsync_jitter ?? 'n/a'} | dec_wall=${data.wall_elapsed_s ?? 'n/a'}s`,
        );
      }
    }
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
  }

  if (parsed.values['json-out']) {
    await writeFile(parsed.values['json-out'], JSON.stringify(results, null, 2));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: Error) => {
    console.error(err);
    process.exit(1);
  });
}
