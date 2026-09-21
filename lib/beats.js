// Music beat detection in plain Node: spectral-flux onset envelope → tempo by autocorrelation →
// phase-aligned beat grid snapped to nearby onsets. No native deps; ffmpeg only decodes the audio.
import path from "node:path";
import { spawn } from "node:child_process";
import { FFMPEG, abortError, toolEnv } from "./tools.js";

const SAMPLE_RATE = 22050;
const WIN = 512; // FFT size (23 ms): short enough for tight onset timing
const HOP = 128; // 5.8 ms between onset frames
const FPS = SAMPLE_RATE / HOP;
const MIN_BPM = 70;
const MAX_BPM = 180;
const SNAP_SEC = 0.06; // beats snap to an onset peak within ±60 ms
const LOW_BAND_HZ = 250; // kick-drum band, used to find downbeats
// Spectral flux peaks slightly before the perceptual onset; measured on synthetic kick tracks.
const ONSET_LAG_SEC = 0;

/**
 * Detect tempo and beats in a music track (any ffmpeg-readable audio/video file).
 * @returns {Promise<{ duration: number, bpm: number, beats: number[], strengths: number[], downbeats: number[], confidence: number }>}
 *   beats/downbeats in seconds; strengths 0–1 per beat; confidence 0–1 = share of beats that landed on a clear onset.
 *   Silent or beatless audio returns bpm 0 and empty arrays.
 */
export async function detectBeats(audioPath, { signal } = {}) {
  const pcm = await decodePcm(audioPath, { signal });
  const duration = pcm.length / SAMPLE_RATE;
  const empty = { duration: round3(duration), bpm: 0, beats: [], strengths: [], downbeats: [], confidence: 0 };
  if (duration < 1.5 || peakAbs(pcm) < 1e-4) return empty;

  const { env, low, rms } = onsetEnvelope(pcm);
  if (signal?.aborted) throw abortError();
  const coarseBpm = estimateTempo(env);
  if (!coarseBpm) return empty;

  const smooth = gaussianSmooth(env, 2);
  const { period, phase } = refineGrid(smooth, coarseBpm);
  // The phase search can't see a beat right at t=0 (no flux history yet), so extend the grid back.
  const firstPhase = phase - period * Math.floor((phase + SNAP_SEC * FPS) / period);
  const placed = placeBeats(env, period, firstPhase);

  // Drop grid beats in leading/trailing silence.
  const { first, last } = activeRange(rms);
  const keep = placed.filter((b) => b.pos >= first - period / 2 && b.pos <= last + period / 2);
  if (keep.length < 2) return empty;

  const raw = keep.map((b) => localMax(env, b.pos, 2));
  const norm = percentile(raw, 0.95) || 1;
  const beats = keep.map((b) => round3(Math.max(0, b.pos / FPS + ONSET_LAG_SEC)));
  const strengths = raw.map((v) => round3(Math.min(1, v / norm)));

  // Downbeats: the every-4th-beat phase carrying the most low-frequency (kick) energy.
  const lowAt = keep.map((b) => localMax(low, b.pos, 2));
  let best = 0;
  let bestSum = -1;
  for (let o = 0; o < Math.min(4, beats.length); o++) {
    let sum = 0;
    for (let i = o; i < beats.length; i += 4) sum += lowAt[i] + 0.25 * raw[i];
    if (sum > bestSum + 1e-9) [best, bestSum] = [o, sum];
  }
  const downbeats = beats.filter((_, i) => i >= best && (i - best) % 4 === 0);

  return {
    duration: round3(duration),
    bpm: Math.round((60 * FPS) / period * 10) / 10,
    beats,
    strengths,
    downbeats,
    confidence: round3(keep.filter((b) => b.snapped).length / keep.length),
  };
}

/**
 * Timeline cut points for an edit: beats grouped so shots last ≥ minShot seconds, up to targetSec.
 * Times are relative to `startAt` (the music offset the edit starts from) and begin with 0; the last
 * value is where the edit should end (also on a beat), so shot i spans cuts[i]..cuts[i+1].
 * Beats within 30 ms of minShot count as long enough, so beat-snap jitter doesn't break the rhythm.
 * @param beatInfo from detectBeats
 * @returns {number[]}
 */
export function cutGrid(beatInfo, { targetSec = 20, minShot = 0.8, startAt = 0 } = {}) {
  let times = (beatInfo?.beats || []).map((b) => b - startAt).filter((t) => t > 0.03);
  if (!times.length) {
    // No usable beats (silent track, or startAt past the music): fall back to a steady pulse.
    const period = beatInfo?.bpm > 0 ? 60 / beatInfo.bpm : 0.5;
    times = [];
    for (let t = period; t <= targetSec + 1e-6; t += period) times.push(t);
  }
  const cuts = [0];
  for (const t of times) {
    if (t > targetSec + 0.05) break;
    if (t - cuts.at(-1) >= minShot - 0.03) cuts.push(round3(t));
  }
  return cuts;
}

/** Decode the first audio stream to mono Float32 PCM. Aborting `signal` kills ffmpeg. */
export function decodePcm(file, { sampleRate = SAMPLE_RATE, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const args = ["-v", "error", "-nostdin", "-i", file, "-map", "0:a:0", "-vn", "-sn", "-dn",
      "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "pipe:1"];
    const child = spawn(FFMPEG, args, { env: toolEnv, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-2000)));
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(abortError());
      if (code !== 0) {
        const why = /matches no streams/.test(stderr) ? "it has no audio stream" : stderr.trim();
        return reject(new Error(`Could not decode audio from ${path.basename(file)}: ${why}`));
      }
      const buf = Buffer.concat(chunks);
      const pcm = new Float32Array(Math.floor(buf.length / 4)); // copy into aligned memory
      new Uint8Array(pcm.buffer).set(buf.subarray(0, pcm.length * 4));
      resolve(pcm);
    });
  });
}

// ─── onset envelope ────────────────────────────────────────────────────────────

/**
 * SuperFlux-style onset strength: positive log-magnitude increase vs. two frames back
 * (max-filtered across neighbouring bins to ignore vibrato), minus a local mean.
 * Also returns a kick-band flux (`low`) and per-frame RMS.
 */
function onsetEnvelope(pcm) {
  const n = Math.ceil(pcm.length / HOP);
  const bins = WIN / 2;
  const lowBins = Math.max(2, Math.round((LOW_BAND_HZ * WIN) / SAMPLE_RATE));
  const fft = makeFft(WIN);
  const hann = Float64Array.from({ length: WIN }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN));
  const re = new Float64Array(WIN);
  const im = new Float64Array(WIN);
  const gamma = 100 / (WIN / 4);
  let prev2 = new Float32Array(bins);
  let prev1 = new Float32Array(bins);
  let cur = new Float32Array(bins);
  const flux = new Float32Array(n);
  const low = new Float32Array(n);
  const rms = new Float32Array(n);

  for (let f = 0; f < n; f++) {
    const start = f * HOP - WIN / 2; // frame f is centred on sample f*HOP
    let energy = 0;
    for (let i = 0; i < WIN; i++) {
      const j = start + i;
      const s = j >= 0 && j < pcm.length ? pcm[j] : 0;
      energy += s * s;
      re[i] = s * hann[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(energy / WIN);
    fft(re, im);
    let sum = 0;
    let lowSum = 0;
    for (let k = 0; k < bins; k++) {
      cur[k] = Math.log1p(gamma * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      if (k === 0) continue;
      const ref = Math.max(prev2[k - 1], prev2[k], prev2[k + 1] ?? 0);
      const d = cur[k] - ref;
      if (d > 0) {
        sum += d;
        if (k < lowBins) lowSum += d;
      }
    }
    flux[f] = f < 2 ? 0 : sum;
    low[f] = f < 2 ? 0 : lowSum;
    [prev2, prev1, cur] = [prev1, cur, prev2];
  }

  const env = subtractLocalMean(flux, Math.round(0.15 * FPS));
  const top = percentile(env, 0.99) || 1;
  for (let i = 0; i < n; i++) env[i] /= top;
  const lowTop = percentile(low, 0.99) || 1;
  for (let i = 0; i < n; i++) low[i] /= lowTop;
  return { env, low, rms };
}

/** Iterative radix-2 FFT (in place). Returns fft(re, im). */
function makeFft(n) {
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
    rev[i] = r;
  }
  const cos = Float64Array.from({ length: n / 2 }, (_, i) => Math.cos((2 * Math.PI * i) / n));
  const sin = Float64Array.from({ length: n / 2 }, (_, i) => Math.sin((2 * Math.PI * i) / n));
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tr = re[l] * cos[k] + im[l] * sin[k];
          const ti = im[l] * cos[k] - re[l] * sin[k];
          re[l] = re[j] - tr;
          im[l] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
        }
      }
    }
  };
}

// ─── tempo & grid ──────────────────────────────────────────────────────────────

/**
 * Coarse tempo in BPM from the envelope autocorrelation. Each candidate is scored on its lag
 * and its multiples (a true beat period repeats at 2, 3, 4 beats; a half-beat period doesn't),
 * with a gentle preference for ~120 BPM to settle remaining octave ambiguity.
 */
function estimateTempo(env) {
  const maxLag = Math.min(env.length - 1, Math.ceil((4 * 60 * FPS) / MIN_BPM) + 2);
  if (maxLag < (60 * FPS) / MAX_BPM) return 0;
  let mean = 0;
  for (const v of env) mean += v;
  mean /= env.length;
  const x = Float32Array.from(env, (v) => v - mean);
  const acf = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0, m = x.length - lag; i < m; i++) s += x[i] * x[i + lag];
    acf[lag] = s / (x.length - lag);
  }
  // Tolerate ±1 frame of lag jitter.
  const at = (lag) => (lag + 1 > maxLag ? 0 : Math.max(interp(acf, lag - 1), interp(acf, lag), interp(acf, lag + 1)));

  let bestBpm = 0;
  let bestScore = 0;
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.25) {
    const lag = (60 * FPS) / bpm;
    let score = 0;
    for (let m = 1; m <= 4; m++) score += at(m * lag) / m;
    score *= Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.2) ** 2);
    if (score > bestScore) [bestBpm, bestScore] = [bpm, score];
  }
  return bestScore > 0 ? bestBpm : 0;
}

/** Fine-tune period and phase so a rigid beat grid lands on the most onset energy across the track. */
function refineGrid(smooth, coarseBpm) {
  const scoreGrid = (period, phase) => {
    let s = 0;
    let c = 0;
    for (let t = phase; t < smooth.length - 1; t += period, c++) s += interp(smooth, t);
    return c ? s / c : 0;
  };
  let best = { period: (60 * FPS) / coarseBpm, phase: 0, score: -1 };
  const search = (bpms, phasesFor) => {
    for (const bpm of bpms) {
      const period = (60 * FPS) / bpm;
      for (const phase of phasesFor(period)) {
        const score = scoreGrid(period, phase);
        if (score > best.score) best = { period, phase, score };
      }
    }
  };
  // Stage 1: ±3% tempo, every phase frame. Stage 2: ±0.3 BPM, sub-frame phase around the winner.
  search(range(coarseBpm * 0.97, coarseBpm * 1.03, 0.2), (p) => range(0, p, 1));
  const bpm1 = (60 * FPS) / best.period;
  const phase1 = best.phase;
  search(range(bpm1 - 0.3, bpm1 + 0.3, 0.01), (p) =>
    range(phase1 - 2, phase1 + 2, 0.1).map((ph) => ((ph % p) + p) % p));
  return best;
}

/**
 * Walk the grid, snapping each beat to the strongest onset peak within ±SNAP_SEC. A running
 * median of recent snap offsets lets the grid follow slight tempo drift in live recordings.
 */
function placeBeats(env, period, phase) {
  const win = SNAP_SEC * FPS;
  const threshold = 0.12;
  const out = [];
  const offsets = [];
  let drift = 0;
  for (let g = phase; g < env.length; g += period) {
    const center = g + drift;
    const peak = strongestPeak(env, center, win, threshold);
    if (peak == null) {
      out.push({ pos: center, snapped: false });
      continue;
    }
    out.push({ pos: peak, snapped: true });
    offsets.push(peak - g);
    if (offsets.length > 8) offsets.shift();
    drift = clamp(median(offsets), -win / 2, win / 2);
  }
  return out;
}

/** Sub-frame position of the best local maximum near `center` (closer peaks preferred), or null. */
function strongestPeak(env, center, win, threshold) {
  const lo = Math.max(1, Math.ceil(center - win));
  const hi = Math.min(env.length - 2, Math.floor(center + win));
  let bestI = -1;
  let bestW = 0;
  for (let i = lo; i <= hi; i++) {
    const v = env[i];
    if (v < threshold || v < env[i - 1] || v <= env[i + 1]) continue;
    const w = v * (1 - 0.5 * ((i - center) / win) ** 2);
    if (w > bestW) [bestI, bestW] = [i, w];
  }
  if (bestI < 0) return null;
  const [a, b, c] = [env[bestI - 1], env[bestI], env[bestI + 1]];
  const denom = a - 2 * b + c;
  return bestI + (denom < 0 ? clamp((0.5 * (a - c)) / denom, -0.5, 0.5) : 0);
}

/** First/last envelope frame where the track is audibly playing. */
function activeRange(rms) {
  const floor = Math.max(1e-4, 0.05 * percentile(rms, 0.95));
  let first = 0;
  while (first < rms.length - 1 && rms[first] < floor) first++;
  let last = rms.length - 1;
  while (last > first && rms[last] < floor) last--;
  return { first, last };
}

// ─── small numeric helpers ─────────────────────────────────────────────────────

function subtractLocalMean(x, radius) {
  const prefix = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) prefix[i + 1] = prefix[i] + x[i];
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - radius);
    const b = Math.min(x.length, i + radius + 1);
    out[i] = Math.max(0, x[i] - (prefix[b] - prefix[a]) / (b - a));
  }
  return out;
}

function gaussianSmooth(x, sigma) {
  const r = Math.ceil(sigma * 3);
  const kernel = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-0.5 * ((i - r) / sigma) ** 2));
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    let w = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j < 0 || j >= x.length) continue;
      s += x[j] * kernel[k + r];
      w += kernel[k + r];
    }
    out[i] = s / w;
  }
  return out;
}

function localMax(x, pos, radius) {
  let m = 0;
  for (let i = Math.max(0, Math.round(pos - radius)); i <= Math.min(x.length - 1, Math.round(pos + radius)); i++) {
    if (x[i] > m) m = x[i];
  }
  return m;
}

function interp(x, t) {
  if (t <= 0) return x[0] ?? 0;
  const i = Math.floor(t);
  if (i >= x.length - 1) return x[x.length - 1] ?? 0;
  return x[i] + (x[i + 1] - x[i]) * (t - i);
}

function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
}

function median(values) {
  return percentile(values, 0.5);
}

function peakAbs(pcm) {
  let m = 0;
  for (let i = 0; i < pcm.length; i++) m = Math.max(m, Math.abs(pcm[i]));
  return m;
}

function range(from, to, step) {
  const out = [];
  for (let v = from; v < to - 1e-9; v += step) out.push(v);
  return out;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round3 = (v) => Math.round(v * 1000) / 1000;
