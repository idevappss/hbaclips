// Visual excitement analysis for "dope edits": per-0.5 s motion (frame difference of tiny grayscale
// frames), loudness and hard cuts, grouped into short highlight moments and picked into shot lists.
import { spawn } from "node:child_process";
import { FFMPEG, FFPROBE, abortError, run, toolEnv } from "./tools.js";
import { probe } from "./media.js";

const STEP = 0.5; // seconds per sample
const THUMB_PIXELS = 64 * 36; // analysis frames are ~64×36 (aspect preserved)
const FULL_FPS = 8; // frames per second sampled when decoding every frame
const AUDIO_RATE = 8000;
const AUDIO_BLOCK = 0.1; // loudness sub-window, seconds

// Software H.264 decode runs ≈25× realtime at 1080p30 on an M1 Pro. Videos cheaper than
// FULL_BUDGET are fully decoded (exact motion + cuts). Longer ones decode only keyframes
// (~10× faster) and fill in 0.5 s detail from the size of the compressed frames between them.
const FULL_DECODE_SPEED = 25;
const FULL_BUDGET_SEC = 20;
const SPARSE_GOP_FULL_BUDGET_SEC = 90; // sparse keyframes make keyframe mode coarse; decode fully if affordable
const MAX_DENSE_GOP = 1.25;

const MOMENT_MIN = 1.0;
const MOMENT_MAX = 3.5;
const MOMENT_TARGET = 2.0;

/**
 * Scan a video for visually exciting moments.
 *
 * `samples[i]` covers [t, t + step): `motion` and `loudness` are 0–1, percentile-normalised over the
 * whole video with absolute floors (a static or silent video stays near 0); `cut` marks the first
 * sample that starts cleanly after a hard scene change. `moments` tile the video (split at cuts),
 * sorted by score desc; `motion` is the moment's mean motion, `loudness` its peak loudness.
 * Extra fields: `cuts` (exact cut times, seconds) and `mode` ("full" | "keyframes", the decode strategy).
 *
 * @param {string} videoPath
 * @param {{ signal?: AbortSignal, onProgress?: (fraction: number) => void, mode?: "auto" | "full" | "keyframes" }} [opts]
 * @returns {Promise<{ duration: number, step: number, samples: Array<{ t: number, motion: number, loudness: number, cut: boolean }>, moments: Array<{ start: number, end: number, peak: number, score: number, motion: number, loudness: number }>, cuts: number[], mode: string }>}
 */
export async function scanMoments(videoPath, { signal, onProgress, mode = "auto" } = {}) {
  if (signal?.aborted) throw abortError();
  // One failing pass stops its siblings; an outside abort stops everything.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const inner = controller.signal;
  const failFast = (p) => p.catch((err) => {
    controller.abort();
    throw err;
  });

  try {
    const info = await probe(videoPath);
    const duration = Number.isFinite(info.duration) && info.duration > 0 ? info.duration : 0;
    const chosen = mode === "auto" ? await chooseMode(videoPath, info, inner) : mode;
    if (signal?.aborted) throw abortError();

    const progress = progressTracker(onProgress, { video: 0.8, audio: info.hasAudio ? 0.15 : 0, packets: chosen === "keyframes" ? 0.05 : 0 });
    const [frames, levels, packets] = await Promise.all([
      failFast(readFrames(videoPath, info, chosen, { signal: inner, onProgress: (f) => progress("video", f) })),
      info.hasAudio
        ? failFast(audioLevels(videoPath, duration, { signal: inner, onProgress: (f) => progress("audio", f) })
          .catch((err) => (err.name === "AbortError" ? Promise.reject(err) : null))) // unreadable audio → treat as silent
        : null,
      chosen === "keyframes" ? failFast(scanPackets(videoPath, inner)).then((p) => (progress("packets", 1), p)) : null,
    ]);

    const nSteps = Math.max(1, Math.ceil(duration / STEP - 1e-6));
    const video = chosen === "keyframes" ? keyframeMotion(frames, packets, nSteps) : fullMotion(frames, nSteps);
    const loudness = loudnessSteps(levels, nSteps);
    const cuts = video.cuts.filter((c) => c > 0.05 && c < duration - 0.05);
    const cutSamples = new Set(cuts.map((c) => Math.min(nSteps - 1, Math.ceil((c - 0.05) / STEP))));

    const samples = Array.from({ length: nSteps }, (_, i) => ({
      t: round3(i * STEP),
      motion: round3(video.motion[i]),
      loudness: round3(loudness[i]),
      cut: cutSamples.has(i),
    }));
    const dark = video.luma.map((l) => clamp((0.14 - l) / 0.05, 0, 1));
    const moments = buildMoments(samples, dark, cuts, duration, Boolean(levels));
    onProgress?.(1);
    return { duration: round3(duration), step: STEP, samples, moments, cuts: cuts.map(round3), mode: chosen };
  } finally {
    signal?.removeEventListener("abort", forwardAbort);
  }
}

/**
 * Choose shots for an edit of roughly `targetSec` seconds.
 * Highest-scoring moments first, at least `minGapSec` apart (relaxed to ½ then 0 if the video runs
 * out of candidates), each trimmed to shotMin–shotMax around its peak without leaving its moment
 * (so never across a cut) or entering an `avoid` range.
 * @param moments from scanMoments
 * @param {{ targetSec?: number, shotMin?: number, shotMax?: number, minGapSec?: number, avoid?: Array<{ start: number, end: number }> }} [opts]
 * @returns {Array<{ start: number, end: number, score: number }>} chronological; total ≈ targetSec, never more than targetSec + shotMax
 */
export function pickShots(moments, { targetSec = 20, shotMin = 0.8, shotMax = 3, minGapSec = 4, avoid = [] } = {}) {
  shotMax = Math.max(shotMin, shotMax);
  const candidates = [];
  for (const m of [...(moments || [])].sort((a, b) => b.score - a.score || a.start - b.start)) {
    const piece = freePiece(m, avoid);
    if (piece && piece.end - piece.start >= shotMin - 1e-6) candidates.push({ ...piece, peak: clamp(m.peak ?? (m.start + m.end) / 2, piece.start, piece.end), score: m.score });
  }

  const picked = [];
  let total = 0;
  const used = new Set();
  for (const gap of [minGapSec, minGapSec / 2, 0]) {
    for (const [i, c] of candidates.entries()) {
      const remaining = targetSec - total;
      if (remaining < 0.25) break;
      if (used.has(i)) continue;
      let len = Math.min(shotMax, c.end - c.start);
      if (remaining >= shotMin) len = Math.min(len, remaining);
      else len = Math.min(len, shotMin); // a last short top-up; overshoots by < shotMin
      const start = clamp(c.peak - len / 2, c.start, c.end - len);
      const shot = { start, end: start + len, score: c.score };
      if (picked.some((p) => Math.max(shot.start - p.end, p.start - shot.end) < gap - 1e-6)) continue;
      used.add(i);
      picked.push(shot);
      total += len;
    }
    if (targetSec - total < 0.25) break;
  }
  return picked
    .sort((a, b) => a.start - b.start)
    .map((s) => ({ start: round3(s.start), end: round3(s.end), score: s.score }));
}

// ─── decode strategy ───────────────────────────────────────────────────────────

async function chooseMode(file, info, signal) {
  const pixels = (info.width || 1920) * (info.height || 1080);
  const fps = Math.min(info.fps || 30, 120);
  const estFullSec = (info.duration * (fps / 30) * (pixels / (1920 * 1080))) / FULL_DECODE_SPEED;
  if (!(estFullSec > FULL_BUDGET_SEC)) return "full";
  const gop = await keyframeInterval(file, signal);
  if (gop >= 0.2 && gop <= MAX_DENSE_GOP) return "keyframes";
  return estFullSec <= SPARSE_GOP_FULL_BUDGET_SEC ? "full" : "keyframes";
}

/** Median keyframe spacing over the first minute (cheap: reads packet headers only). */
async function keyframeInterval(file, signal) {
  const out = await run(FFPROBE, ["-v", "error", "-read_intervals", "%+60", "-select_streams", "v:0",
    "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", file], { signal });
  const keys = [];
  for (const line of out.split("\n")) {
    const [t, flags] = line.split(",");
    if (flags?.includes("K") && Number.isFinite(parseFloat(t))) keys.push(parseFloat(t));
  }
  keys.sort((a, b) => a - b);
  if (keys.length < 2) return 60;
  return median(keys.slice(1).map((t, i) => t - keys[i]));
}

/** Compressed size, time and keyframe flag of every video packet (for 0.5 s detail between keyframes). */
async function scanPackets(file, signal) {
  const out = await run(FFPROBE, ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "packet=pts_time,dts_time,size,flags:format=start_time", "-of", "csv=p=0", file], { signal });
  let startTime = 0;
  const packets = [];
  for (const line of out.split("\n")) {
    const f = line.split(",");
    if (f.length === 1) {
      if (Number.isFinite(parseFloat(f[0]))) startTime = parseFloat(f[0]);
      continue;
    }
    if (f.length < 4 || !/^[KDC_]+$/.test(f[3])) continue;
    const t = Number.isFinite(parseFloat(f[0])) ? parseFloat(f[0]) : parseFloat(f[1]);
    const size = Number(f[2]);
    if (Number.isFinite(t) && size > 0) packets.push({ t, size, key: f[3].includes("K") });
  }
  for (const p of packets) p.t -= startTime; // ffmpeg's decoded timestamps are start-time relative
  return packets.sort((a, b) => a.t - b.t);
}

// ─── video frames ──────────────────────────────────────────────────────────────

/**
 * Decode tiny grayscale frames and reduce each to { t, luma, diff } where diff is the mean absolute
 * difference from the previous frame after removing each frame's mean brightness (so exposure
 * pumping and fades don't read as motion). Area-averaging to ~64×36 wipes out grain and blocking.
 */
function readFrames(file, info, mode, { signal, onProgress }) {
  const [w, h] = thumbSize(info.width, info.height);
  const size = w * h;
  const input = mode === "keyframes"
    ? ["-discard", "nokey", "-skip_frame", "nokey"] // demuxer skips non-key packets entirely
    : ["-skip_loop_filter", "all"]; // deblocking is invisible at 64 px; ~10% faster
  const filters = [mode === "full" ? `fps=${FULL_FPS}` : null, `scale=${w}:${h}:flags=area`, "format=gray", "showinfo"];
  const args = ["-hide_banner", "-nostats", "-nostdin", "-v", "info", ...input, "-i", file,
    "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", filters.filter(Boolean).join(","),
    "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"];

  const times = [];
  const luma = [];
  const diff = [];
  let cur = new Uint8Array(size);
  let prev = new Uint8Array(size);
  let prevMean = 0;
  let filled = 0;

  const finishFrame = () => {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += cur[i];
    const mean = sum / size;
    let d = NaN;
    if (luma.length) {
      const shift = mean - prevMean;
      d = 0;
      for (let i = 0; i < size; i++) d += Math.abs(cur[i] - prev[i] - shift);
      d /= size * 255;
    }
    luma.push(mean / 255);
    diff.push(d);
    [prev, cur] = [cur, prev];
    prevMean = mean;
  };

  const onData = (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      const n = Math.min(size - filled, chunk.length - offset);
      cur.set(chunk.subarray(offset, offset + n), filled);
      filled += n;
      offset += n;
      if (filled === size) {
        finishFrame();
        filled = 0;
      }
    }
  };
  const onStderrLine = (line) => {
    const m = /\bn:\s*(\d+)\s.*?\bpts_time:\s*(-?[\d.e+-]+)/.exec(line);
    if (!m) return false;
    const t = parseFloat(m[2]);
    times[Number(m[1])] = t;
    if (info.duration > 0) onProgress?.(clamp(t / info.duration, 0, 1));
    return true;
  };

  return streamFfmpeg(args, { signal, onData, onStderrLine }).then(() => {
    if (!luma.length) throw new Error("Could not decode any video frames.");
    const t = luma.map((_, i) => (Number.isFinite(times[i]) ? times[i] : mode === "full" ? i / FULL_FPS : NaN));
    return { t, luma, diff };
  });
}

/** Full decode: frame pairs 1/8 s apart give exact motion; a lone difference spike is a hard cut. */
function fullMotion(frames, nSteps) {
  const pairT = frames.t.slice(1);
  const pairD = frames.diff.slice(1);
  const spikes = findSpikes(pairD, { radius: 6, ratio: 3, neighborRatio: 1.8, abs: 0.07 });
  const clean = withoutSpikes(pairD, spikes, 6);
  const raw = fillGaps(binMean(pairT, clean, nSteps));
  return {
    motion: normalize(raw, { lo: 0.1, hi: 0.99, minRange: 0.02 }),
    luma: fillGaps(binMean(frames.t, frames.luma, nSteps), 0.5),
    cuts: spikes.map((i) => pairT[i]), // first frame of the new shot
  };
}

/**
 * Keyframe decode: pixel change between consecutive keyframes (≈1 s apart), blended with the mean
 * compressed size of the in-between frames in each 0.5 s window — encoders spend bits on motion.
 * Cuts are keyframe-difference spikes, placed on the encoder-inserted keyframe or the oversized
 * inter frame where the new shot actually starts.
 */
function keyframeMotion(frames, packets, nSteps) {
  packets ||= [];
  // With non-key packets discarded, the h264 decoder mislabels keyframe timestamps by 1–3 frames;
  // the packet index has the exact times.
  const snapped = snapToNearest(frames.t, packets.filter((p) => p.key).map((p) => p.t), 0.25);
  const keep = snapped.map((_, i) => i).filter((i) => Number.isFinite(snapped[i]));
  const t = keep.map((i) => snapped[i]);
  const d = keep.map((i, j) => (j === 0 ? NaN : frames.diff[i]));
  const luma = keep.map((i) => frames.luma[i]);

  const pairD = d.slice(1); // pairD[j]: change from keyframe j to j+1
  const gaps = pairD.map((_, j) => t[j + 1] - t[j]);
  const gop = median(gaps);
  const regular = (j) => j < 0 || j >= gaps.length || gaps[j] >= 0.8 * gop;
  const inter = packets.filter((p) => !p.key);
  const keySize = median(packets.filter((p) => p.key).map((p) => p.size));
  const cutPackets = new Set();
  const cutAt = new Map(); // pair index → time the new shot starts

  // Keyframes are ~1 s apart, so fast motion also makes big jumps: a pixel spike only counts as a cut
  // when the bitstream agrees — one encoder-inserted keyframe, or one oversized (intra-like) inter frame.
  for (const j of findSpikes(pairD, { radius: 4, ratio: 2.5, neighborRatio: 2, abs: 0.07 })) {
    const [a, b] = [t[j], t[j + 1]];
    if (!regular(j)) {
      // An early keyframe marks the new shot, unless keyframes keep arriving early (encoders do that in fast motion).
      if (regular(j - 1) && regular(j + 1)) cutAt.set(j, b);
      continue;
    }
    const between = inter.filter((p) => p.t > a + 1e-3 && p.t < b - 1e-3);
    const big = between.length >= 3 ? between.reduce((m, p) => (p.size > m.size ? p : m)) : null;
    if (big && big.size >= 4 * median(between.map((p) => p.size)) && big.size >= 0.6 * keySize) {
      cutPackets.add(big);
      cutAt.set(j, big.t);
    } else if (pairD[j] >= 3 * Math.max(pairD[j - 1] || 0, pairD[j + 1] || 0)) {
      cutAt.set(j, b); // unmistakable jump that happens to land on a regular keyframe
    }
  }
  const cleanD = withoutSpikes(pairD, [...cutAt.keys()], 4);
  const cuts = [...cutAt.values()];

  // Pixel term: each step takes the keyframe pair spanning its centre.
  const pix = new Array(nSteps).fill(NaN);
  for (let s = 0, j = 0; s < nSteps; s++) {
    const c = (s + 0.5) * STEP;
    while (j < cleanD.length - 1 && t[j + 1] < c) j++;
    if (cleanD.length && t[j] < c && c <= t[j + 1] + STEP / 2) pix[s] = cleanD[j];
  }
  const pixN = normalize(fillGaps(pix), { lo: 0.1, hi: 0.99, minRange: 0.03 });

  const bits = binMean(inter.filter((p) => !cutPackets.has(p)).map((p) => p.t),
    inter.filter((p) => !cutPackets.has(p)).map((p) => Math.log(p.size)), nSteps);
  const hasBits = bits.some(Number.isFinite);
  const bitsN = hasBits ? normalize(fillGaps(bits), { lo: 0.1, hi: 0.99, minRange: Math.log(4) }) : null;

  return {
    motion: pixN.map((v, s) => (bitsN ? 0.5 * v + 0.5 * bitsN[s] : v)),
    luma: fillGaps(binMean(t, luma, nSteps), 0.5),
    cuts,
  };
}

/** Indices where a value towers over its neighbourhood (hard cuts); steady high values (fast motion) don't count. */
function findSpikes(values, { radius, ratio, neighborRatio, abs }) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!(v >= abs)) continue;
    const around = [];
    for (let k = Math.max(0, i - radius); k <= Math.min(values.length - 1, i + radius); k++) {
      if (k !== i && Number.isFinite(values[k])) around.push(values[k]);
    }
    const adjacent = Math.max(values[i - 1] || 0, values[i + 1] || 0);
    if (v >= ratio * median(around) + 0.02 && v >= neighborRatio * adjacent) out.push(i);
  }
  return out;
}

function withoutSpikes(values, spikes, radius) {
  const out = values.slice();
  for (const i of spikes) {
    const around = values.slice(Math.max(0, i - radius), i + radius + 1).filter((v, k) => Number.isFinite(v) && v !== values[i]);
    out[i] = around.length ? median(around) : 0;
  }
  return out;
}

function thumbSize(width, height) {
  const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
  const even = (v) => Math.max(8, 2 * Math.round(v / 2));
  const w = even(Math.sqrt(THUMB_PIXELS * aspect));
  return [w, even(THUMB_PIXELS / w)];
}

// ─── audio ─────────────────────────────────────────────────────────────────────

/** Mean-square energy of 8 kHz mono audio in 100 ms blocks, streamed (a 45-min file never sits in memory). */
function audioLevels(file, duration, { signal, onProgress }) {
  const perBlock = Math.round(AUDIO_RATE * AUDIO_BLOCK);
  const energies = [];
  let acc = 0;
  let count = 0;
  let total = 0;
  let carry = null;
  const onData = (chunk) => {
    if (carry) {
      chunk = Buffer.concat([carry, chunk]);
      carry = null;
    }
    const whole = chunk.length - (chunk.length % 2);
    if (whole < chunk.length) carry = chunk.subarray(whole);
    for (let i = 0; i < whole; i += 2) {
      const s = chunk.readInt16LE(i) / 32768;
      acc += s * s;
      if (++count === perBlock) {
        energies.push(acc / perBlock);
        acc = 0;
        count = 0;
      }
    }
    total += whole / 2;
    if (duration > 0) onProgress?.(clamp(total / (duration * AUDIO_RATE), 0, 1));
  };
  const args = ["-hide_banner", "-nostats", "-nostdin", "-v", "error", "-i", file, "-map", "0:a:0",
    "-vn", "-sn", "-dn", "-ac", "1", "-ar", String(AUDIO_RATE), "-f", "s16le", "pipe:1"];
  return streamFfmpeg(args, { signal, onData }).then(() => {
    if (count > perBlock / 4) energies.push(acc / count);
    return energies;
  });
}

/** Per-step loudness in dB (blend of window RMS and loudest 100 ms, so hits register), normalised 0–1. */
function loudnessSteps(energies, nSteps) {
  if (!energies?.length) return new Array(nSteps).fill(0);
  const per = Math.round(STEP / AUDIO_BLOCK);
  const raw = Array.from({ length: nSteps }, (_, s) => {
    const block = energies.slice(s * per, (s + 1) * per);
    if (!block.length) return NaN;
    const mean = block.reduce((a, b) => a + b, 0) / block.length;
    return 5 * Math.log10(mean + 1e-10) + 5 * Math.log10(Math.max(...block) + 1e-10);
  });
  return normalize(fillGaps(raw, -100), { lo: 0.1, hi: 0.98, minRange: 15, floor: -65 });
}

// ─── moments ───────────────────────────────────────────────────────────────────

/** Tile the video into 1–3.5 s windows: split at cuts, then place boundaries in quiet valleys. */
function buildMoments(samples, dark, cuts, duration, hasAudio) {
  const excitement = samples.map((s, i) => (hasAudio ? 0.7 * s.motion + 0.3 * s.loudness : s.motion) * (1 - 0.8 * dark[i]));
  const edges = [0, ...cuts, duration].filter((v, i, a) => i === 0 || v > a[i - 1] + 1e-3);
  const moments = [];
  for (let k = 0; k < edges.length - 1; k++) {
    for (const [a, b] of partitionShot(edges[k], edges[k + 1], excitement)) {
      moments.push(describeMoment(a, b, samples, excitement, dark, hasAudio));
    }
  }
  return moments.sort((x, y) => y.score - x.score || x.start - y.start);
}

/** Dynamic programming over 0.5 s boundaries: avoid cutting through excitement, prefer ~2 s windows. */
function partitionShot(a, b, excitement) {
  if (b - a <= MOMENT_MAX + 1e-6) return [[a, b]];
  const pts = [a];
  for (let t = Math.ceil((a + 1e-6) / STEP) * STEP; t < b - 1e-6; t += STEP) if (t > a + 1e-6) pts.push(t);
  pts.push(b);
  const boundaryCost = (t) => {
    const s = Math.round(t / STEP);
    return ((excitement[s - 1] ?? 0) + (excitement[s] ?? 0)) / 2;
  };
  for (const minLen of [MOMENT_MIN, STEP]) {
    const cost = new Array(pts.length).fill(Infinity);
    const from = new Array(pts.length).fill(-1);
    cost[0] = 0;
    for (let j = 1; j < pts.length; j++) {
      const edge = j === pts.length - 1 ? 0 : boundaryCost(pts[j]);
      for (let i = j - 1; i >= 0 && pts[j] - pts[i] <= MOMENT_MAX + 1e-6; i--) {
        const len = pts[j] - pts[i];
        if (len < minLen - 1e-6 || cost[i] === Infinity) continue;
        const c = cost[i] + edge + 0.08 * Math.abs(len - MOMENT_TARGET);
        if (c < cost[j]) [cost[j], from[j]] = [c, i];
      }
    }
    if (from[pts.length - 1] < 0) continue;
    const out = [];
    for (let j = pts.length - 1; j > 0; j = from[j]) out.push([pts[from[j]], pts[j]]);
    return out.reverse();
  }
  return [[a, b]];
}

function describeMoment(a, b, samples, excitement, dark, hasAudio) {
  let idx = [];
  for (let s = Math.max(0, Math.floor(a / STEP)); s < samples.length && s * STEP < b; s++) {
    const mid = (s + 0.5) * STEP;
    if (mid >= a && mid < b) idx.push(s);
  }
  if (!idx.length) idx = [clamp(Math.floor(a / STEP), 0, samples.length - 1)];

  const motion = idx.map((s) => samples[s].motion);
  const loud = idx.map((s) => samples[s].loudness);
  const mean = (v) => v.reduce((x, y) => x + y, 0) / v.length;
  const motionMean = mean(motion);
  const motionTop = mean([...motion].sort((x, y) => y - x).slice(0, Math.ceil(motion.length / 2)));
  const loudPeak = Math.max(...loud);
  const darkShare = mean(idx.map((s) => dark[s]));

  let score = hasAudio
    ? 0.5 * motionMean + 0.2 * motionTop + 0.2 * loudPeak + 0.1 * mean(loud)
    : 0.7 * motionMean + 0.3 * motionTop;
  score *= 0.4 + 0.6 * Math.min(1, motionMean / 0.15); // near-static footage isn't exciting, however loud
  score *= 1 - 0.85 * darkShare; // black / very dark frames
  score *= Math.sqrt(Math.min(1, (b - a) / MOMENT_MIN)); // slivers between close cuts

  const best = idx.reduce((m, s) => (excitement[s] > excitement[m] ? s : m), idx[0]);
  return {
    start: round3(a),
    end: round3(b),
    peak: round3(clamp((best + 0.5) * STEP, a, b)),
    score: round3(clamp(score, 0, 1)),
    motion: round3(motionMean),
    loudness: round3(loudPeak),
  };
}

/** Longest part of a moment outside every avoid range (preferring the part holding the peak). */
function freePiece(m, avoid) {
  let pieces = [{ start: m.start, end: m.end }];
  for (const r of avoid || []) {
    pieces = pieces.flatMap((p) => {
      if (r.end <= p.start || r.start >= p.end) return [p];
      return [{ start: p.start, end: r.start }, { start: r.end, end: p.end }].filter((q) => q.end - q.start > 1e-3);
    });
  }
  if (!pieces.length) return null;
  const holding = pieces.find((p) => m.peak >= p.start && m.peak <= p.end);
  const longest = pieces.reduce((x, y) => (y.end - y.start > x.end - x.start ? y : x));
  return holding && holding.end - holding.start >= (longest.end - longest.start) / 2 ? holding : longest;
}

// ─── helpers ───────────────────────────────────────────────────────────────────

/** Spawn ffmpeg, stream stdout to onData and stderr lines to onStderrLine (return true = consumed). */
function streamFfmpeg(args, { signal, onData, onStderrLine }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const child = spawn(FFMPEG, args, { env: toolEnv, stdio: ["ignore", "pipe", "pipe"] });
    const tail = [];
    let partial = "";
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      const lines = (partial + chunk).split(/\r?\n|\r/);
      partial = lines.pop();
      for (const line of lines) {
        if (onStderrLine?.(line) || !line.trim()) continue;
        tail.push(line.trim());
        if (tail.length > 12) tail.shift();
      }
    });
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (partial) onStderrLine?.(partial);
      if (signal?.aborted) return reject(abortError());
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}\n${tail.join("\n")}`));
    });
  });
}

function progressTracker(onProgress, weights) {
  const done = {};
  let last = -1;
  const sum = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  return (key, fraction) => {
    done[key] = fraction;
    const total = Object.entries(weights).reduce((acc, [k, w]) => acc + w * (done[k] || 0), 0) / sum;
    if (total - last >= 0.01 && total < 1) {
      last = total;
      onProgress?.(round3(total));
    }
  };
}

/** Replace each time with the nearest reference time within `tolerance` (references sorted); keeps order strictly increasing. */
function snapToNearest(times, refs, tolerance) {
  const out = [];
  for (const time of times) {
    let v = time;
    if (Number.isFinite(time) && refs.length) {
      let lo = 0;
      let hi = refs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (refs[mid] < time) lo = mid + 1;
        else hi = mid;
      }
      const near = [refs[lo], refs[lo - 1]].filter((r) => r !== undefined && Math.abs(r - time) <= tolerance);
      if (near.length) v = near.reduce((x, y) => (Math.abs(y - time) < Math.abs(x - time) ? y : x));
    }
    const prev = out.findLast(Number.isFinite);
    out.push(Number.isFinite(v) && prev !== undefined && v <= prev ? Math.max(time, prev + 1e-3) : v);
  }
  return out;
}

/** Mean of values per STEP bin (NaN where a bin has none). */
function binMean(times, values, nSteps) {
  const sum = new Float64Array(nSteps);
  const count = new Uint32Array(nSteps);
  for (let i = 0; i < times.length; i++) {
    if (!Number.isFinite(times[i]) || !Number.isFinite(values[i])) continue;
    const s = clamp(Math.floor(times[i] / STEP), 0, nSteps - 1);
    sum[s] += values[i];
    count[s]++;
  }
  return Array.from(sum, (v, s) => (count[s] ? v / count[s] : NaN));
}

/** Linearly interpolate NaN gaps (edges copy the nearest value; all-NaN becomes `fallback`). */
function fillGaps(values, fallback = 0) {
  const out = values.slice();
  const known = [];
  out.forEach((v, i) => Number.isFinite(v) && known.push(i));
  if (!known.length) return out.fill(fallback);
  for (let i = 0; i < out.length; i++) {
    if (Number.isFinite(out[i])) continue;
    const next = known.find((k) => k > i);
    const prev = known.findLast((k) => k < i);
    if (prev == null) out[i] = out[next];
    else if (next == null) out[i] = out[prev];
    else out[i] = out[prev] + ((out[next] - out[prev]) * (i - prev)) / (next - prev);
  }
  return out;
}

/**
 * Map values to 0–1 between the `lo` and `hi` percentiles. `minRange` keeps a near-constant signal
 * (static shot, silence) near 0 instead of stretching its noise to full scale; `floor` is an absolute lower anchor.
 */
function normalize(values, { lo, hi, minRange, floor = -Infinity }) {
  const a = Math.max(floor, percentile(values, lo));
  const b = Math.max(percentile(values, hi), a + minRange);
  return values.map((v) => clamp((v - a) / (b - a), 0, 1));
}

function percentile(values, q) {
  const sorted = Float64Array.from(values.filter(Number.isFinite)).sort();
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
}

function median(values) {
  return percentile(values, 0.5);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round3 = (v) => Math.round(v * 1000) / 1000;
