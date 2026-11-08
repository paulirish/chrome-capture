#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Correlate ffprobe packet PTS/DTS against decoded 16-bit rAF pixel barcodes.
 *
 * Zero external npm dependencies (requires Node 24+, ffprobe, and ffmpeg).
 *
 * Usage:
 *   node benchmarks/analyze-mp4.ts recordings/*.mp4
 *   node benchmarks/analyze-mp4.ts --dir=./recordings
 *   node benchmarks/analyze-mp4.ts --timeline recordings/1080p_90fps_native_promotion_vsync.mp4
 */

import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {basename, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {decodeBarcodeScanline} from './stress-test-barcode.ts';

export interface PacketInfo {
  pts_time?: string;
  dts_time?: string;
  size?: string;
  flags?: string;
}

export interface StreamInfo {
  codec_name?: string;
  profile?: string;
  level?: string | number;
  pix_fmt?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  time_base?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
}

export interface FormatInfo {
  duration?: string;
  size?: string;
}

export interface FfprobePacketOutput {
  streams?: StreamInfo[];
  format?: FormatInfo;
  packets?: PacketInfo[];
}

export interface TimelineEntry {
  idx: number;
  pts_ms: number;
  dpts_ms: number;
  size_b: number;
  key: boolean;
  barcode: number | null;
  draf: number | null;
}

export interface InspectionResult {
  file: string;
  codec: string;
  pix_fmt?: string;
  color: string;
  time_base?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration_s: number;
  bitrate_kbps: number;
  packets: number;
  decoded: number;
  unique_barcodes: number;
  keyframes: number;
  kf_indices: number[];
  kf_avg_kb: number;
  inter_avg_kb: number;
  pts_delta_ms: {
    min: number;
    p05: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    mean: number;
    stdev: number;
  };
  zero_or_neg_pts_deltas: Array<[number, number, number]>;
  non_mono_dts: Array<[number, number, number]>;
  raf_delta_hist: Record<number, number>;
  dup_barcode_events: Array<[number, number, number]>;
  first_5_pts_ms: number[];
  last_5_pts_ms: number[];
  timeline?: TimelineEntry[];
}

function percentile(sortedVals: number[], p: number): number {
  if (sortedVals.length === 0) return 0.0;
  const k = (sortedVals.length - 1) * (p / 100.0);
  const f = Math.floor(k);
  const c = Math.ceil(k);
  if (f === c) return sortedVals[Math.floor(k)];
  return sortedVals[f] + (sortedVals[c] - sortedVals[f]) * (k - f);
}

function mean(vals: number[]): number {
  if (vals.length === 0) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function pstdev(vals: number[]): number {
  if (vals.length === 0) return 0;
  const avg = mean(vals);
  const variance = vals.reduce((sum, v) => sum + (v - avg) ** 2, 0) / vals.length;
  return Math.sqrt(variance);
}

export function inspectFile(path: string, includeTimeline = false): InspectionResult {
  const probeProc = spawnSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_streams',
    '-show_format',
    '-show_packets',
    '-show_entries', 'packet=pts,pts_time,dts,dts_time,duration,duration_time,size,flags,pos',
    '-of', 'json',
    path,
  ], {encoding: 'utf8', maxBuffer: 100 * 1024 * 1024});

  if (probeProc.error) {
    throw new Error(`ffprobe failed: ${probeProc.error.message}`);
  }
  if (probeProc.status !== 0) {
    throw new Error(`ffprobe exited with status ${probeProc.status}: ${probeProc.stderr}`);
  }

  const probe: FfprobePacketOutput = JSON.parse(probeProc.stdout || '{}');
  const stream: StreamInfo = probe.streams?.[0] ?? {};
  const fmt: FormatInfo = probe.format ?? {};
  const packets: PacketInfo[] = probe.packets ?? [];

  const cropW = 18 * 24;
  const cropH = 8;
  const rawProc = spawnSync('ffmpeg', [
    '-v', 'error',
    '-i', path,
    '-vsync', '0',
    '-vf', `crop=${cropW}:${cropH}:0:12,format=gray`,
    '-f', 'rawvideo',
    'pipe:1',
  ], {maxBuffer: 500 * 1024 * 1024});

  if (rawProc.error) {
    throw new Error(`ffmpeg crop failed: ${rawProc.error.message}`);
  }
  if (rawProc.status !== 0) {
    throw new Error(`ffmpeg exited with status ${rawProc.status}: ${rawProc.stderr?.toString()}`);
  }

  const raw = rawProc.stdout;
  const stride = cropW * cropH;
  const nDecoded = Math.floor(raw.length / stride);
  const barcodes: Array<number | null> = [];

  for (let i = 0; i < nDecoded; i++) {
    const fbuf = raw.subarray(i * stride, (i + 1) * stride);
    const rowOffset = 4 * cropW;
    const row = fbuf.subarray(rowOffset, rowOffset + cropW);
    barcodes.push(decodeBarcodeScanline(row, 24));
  }

  const ptsTimes = packets
    .filter(p => typeof p.pts_time === 'string')
    .map(p => parseFloat(p.pts_time as string));
  const dtsTimes = packets
    .filter(p => typeof p.dts_time === 'string')
    .map(p => parseFloat(p.dts_time as string));
  const sizes = packets.map(p => parseInt(p.size ?? '0', 10));
  const keyframes: number[] = [];
  packets.forEach((p, idx) => {
    if (p.flags?.includes('K')) {
      keyframes.push(idx);
    }
  });

  const deltasMs: number[] = [];
  const zeroOrNegPts: Array<[number, number, number]> = [];
  for (let i = 1; i < ptsTimes.length; i++) {
    deltasMs.push((ptsTimes[i] - ptsTimes[i - 1]) * 1000.0);
    if (ptsTimes[i] <= ptsTimes[i - 1]) {
      zeroOrNegPts.push([
        i,
        Math.round(ptsTimes[i - 1] * 1000000) / 1000,
        Math.round(ptsTimes[i] * 1000000) / 1000,
      ]);
    }
  }

  const nonMonoDts: Array<[number, number, number]> = [];
  for (let i = 1; i < dtsTimes.length; i++) {
    if (dtsTimes[i] <= dtsTimes[i - 1]) {
      nonMonoDts.push([
        i,
        Math.round(dtsTimes[i - 1] * 1000000) / 1000,
        Math.round(dtsTimes[i] * 1000000) / 1000,
      ]);
    }
  }

  const rafDeltas: number[] = [];
  const dupPairs: Array<[number, number, number]> = [];
  const minLen = Math.min(barcodes.length, ptsTimes.length);
  for (let i = 1; i < minLen; i++) {
    const b0 = barcodes[i - 1];
    const b1 = barcodes[i];
    if (b0 !== null && b1 !== null) {
      const dr = b1 - b0;
      rafDeltas.push(dr);
      if (dr === 0) {
        dupPairs.push([
          i,
          b1,
          Math.round((ptsTimes[i] - ptsTimes[i - 1]) * 1000000) / 1000,
        ]);
      }
    }
  }

  const rafDeltaHist: Record<number, number> = {};
  for (const dr of rafDeltas) {
    rafDeltaHist[dr] = (rafDeltaHist[dr] ?? 0) + 1;
  }

  const sDeltas = [...deltasMs].sort((a, b) => a - b);
  const dur = parseFloat(stream.duration || fmt.duration || '0');
  const kfSizes = keyframes.map(i => sizes[i]);
  const kfSet = new Set(keyframes);
  const nonKfSizes = sizes.filter((_, idx) => !kfSet.has(idx));

  const totalBytes = parseInt(fmt.size ?? '0', 10);
  const bitrateKbps = dur > 0 ? Math.round((totalBytes * 8) / dur / 1000 * 10) / 10 : 0;

  const validBarcodes = new Set(barcodes.filter((b): b is number => b !== null));

  const out: InspectionResult = {
    file: basename(path),
    codec: `${stream.codec_name ?? 'unknown'} (profile=${stream.profile ?? 'unknown'}, level=${stream.level ?? 'unknown'})`,
    pix_fmt: stream.pix_fmt,
    color: `${stream.color_range ?? 'unknown'}/${stream.color_space ?? 'unknown'}/${stream.color_transfer ?? 'unknown'}/${stream.color_primaries ?? 'unknown'}`,
    time_base: stream.time_base,
    r_frame_rate: stream.r_frame_rate,
    avg_frame_rate: stream.avg_frame_rate,
    duration_s: Math.round(dur * 10000) / 10000,
    bitrate_kbps: bitrateKbps,
    packets: packets.length,
    decoded: nDecoded,
    unique_barcodes: validBarcodes.size,
    keyframes: keyframes.length,
    kf_indices: keyframes.slice(0, 12),
    kf_avg_kb: kfSizes.length > 0 ? Math.round((mean(kfSizes) / 1024) * 10) / 10 : 0,
    inter_avg_kb: nonKfSizes.length > 0 ? Math.round((mean(nonKfSizes) / 1024) * 10) / 10 : 0,
    pts_delta_ms: {
      min: sDeltas.length > 0 ? Math.round((sDeltas.at(0) ?? 0) * 1000) / 1000 : 0,
      p05: Math.round(percentile(sDeltas, 5) * 1000) / 1000,
      p50: Math.round(percentile(sDeltas, 50) * 1000) / 1000,
      p95: Math.round(percentile(sDeltas, 95) * 1000) / 1000,
      p99: Math.round(percentile(sDeltas, 99) * 1000) / 1000,
      max: sDeltas.length > 0 ? Math.round((sDeltas.at(-1) ?? 0) * 1000) / 1000 : 0,
      mean: Math.round(mean(deltasMs) * 1000) / 1000,
      stdev: Math.round(pstdev(deltasMs) * 1000) / 1000,
    },
    zero_or_neg_pts_deltas: zeroOrNegPts,
    non_mono_dts: nonMonoDts,
    raf_delta_hist: rafDeltaHist,
    dup_barcode_events: dupPairs.slice(0, 10),
    first_5_pts_ms: ptsTimes.slice(0, 5).map(x => Math.round(x * 1000000) / 1000),
    last_5_pts_ms: ptsTimes.slice(-5).map(x => Math.round(x * 1000000) / 1000),
  };

  if (includeTimeline) {
    const timeline: TimelineEntry[] = [];
    for (let i = 0; i < ptsTimes.length; i++) {
      const dpts = i > 0 ? Math.round((ptsTimes[i] - ptsTimes[i - 1]) * 1000000) / 1000 : 0.0;
      const bCur = i < barcodes.length ? barcodes[i] : null;
      const bPrev = i > 0 && i - 1 < barcodes.length ? barcodes[i - 1] : null;
      const draf = bCur !== null && bPrev !== null ? bCur - bPrev : null;
      timeline.push({
        idx: i,
        pts_ms: Math.round(ptsTimes[i] * 1000000) / 1000,
        dpts_ms: dpts,
        size_b: sizes[i] ?? 0,
        key: packets[i]?.flags?.includes('K') ?? false,
        barcode: bCur,
        draf,
      });
    }
    out.timeline = timeline;
  }

  return out;
}

export function resolveVideoTargets(positionals: string[], dir?: string): string[] {
  const targets = [...positionals];
  if (dir) {
    targets.push(
      ...readdirSync(dir)
        .filter(f => f.endsWith('.mp4') || f.endsWith('.webm'))
        .map(f => join(dir, f)),
    );
  }
  return targets;
}

export function main(): void {
  const rawArgs = process.argv.slice(2);
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      dir: {type: 'string'},
      timeline: {type: 'boolean'},
      help: {type: 'boolean', short: 'h'},
    },
    allowPositionals: true,
  });

  if (parsed.values.help) {
    console.log(`Usage: node benchmarks/analyze-mp4.ts [files...] [options]

Options:
  --dir=<path>        Directory of .mp4/.webm recordings to inspect
  --timeline          Include per-packet (dPTS, dRAF) timeline
  -h, --help          Show this help message
`);
    return;
  }

  const targets = resolveVideoTargets(parsed.positionals, parsed.values.dir);

  if (targets.length === 0) {
    console.error('Error: Provide recording paths or --dir=<path>');
    process.exit(1);
  }

  const results = targets.map(p => inspectFile(p, parsed.values.timeline));
  console.log(JSON.stringify(results, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
