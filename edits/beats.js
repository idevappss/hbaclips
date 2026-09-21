// Music analysis in plain JS (no Python): onset envelope → tempo → beat grid → bars, energy and the drop.
import { spawn } from "node:child_process";
import { FFMPEG } from "../lib/tools.js";

const SR = 22050;
const N = 1024;
const HOP = 256;
const FPS = SR / HOP; // onset frames per second (~86)

const r3 = (n) => Math.round(n * 1000) / 1000;

/** Decode any audio or video file to mono float32 PCM. */
export function decodeAudio(file, { rate = SR, start = 0, duration, signal } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-loglevel", "error"];
    if (start > 0) args.push("-ss", String(start));
    args.push("-i", file);
    if (duration) args.push("-t", String(duration));
    args.push("-vn", "-ac", "1", "-ar", String(rate), "-f", "f32le", "-");
    const child = spawn(FFMPEG, args, { signal });
    const chunks = [];
    let err = "";
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Couldn't read the audio: ${err.trim().split("\n").slice(-2).join(" ") || `ffmpeg exited with ${code}`}`));
      const buf = Buffer.concat(chunks);
      // slice() copies into a fresh, 4-byte-aligned ArrayBuffer.
      resolve(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length - (buf.length % 4)))));
    });
  });
}

function makeFft(n) {
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (levels - 1));
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j;
          const b = a + half;
          const tre = re[b] * cos[k] + im[b] * sin[k];
          const tim = im[b] * cos[k] - re[b] * sin[k];
          re[b] = re[a] - tre;
          im[b] = im[a] - tim;
          re[a] += tre;
          im[a] += tim;
        }
      }
    }
  };
}

/** Remove the slow-moving part (subtract a ~1 s moving average), keep what pokes above it. */
function highpass(x, win = Math.round(FPS)) {
  const prefix = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) prefix[i + 1] = prefix[i] + x[i];
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - win);
    const b = Math.min(x.length, i + win + 1);
    out[i] = Math.max(0, x[i] - (prefix[b] - prefix[a]) / (b - a));
  }
  return out;
}

function normalize(x) {
  let sum = 0;
  let sq = 0;
  for (const v of x) {
    sum += v;
    sq += v * v;
  }
  const mean = sum / (x.length || 1);
  const std = Math.sqrt(Math.max(1e-12, sq / (x.length || 1) - mean * mean));
  return x.map((v) => v / std);
}

function smooth(x, sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, i) => Math.exp(-0.5 * ((i - radius) / sigma) ** 2));
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    let w = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= x.length) continue;
      s += x[j] * kernel[k + radius];
      w += kernel[k + radius];
    }
    out[i] = s / w;
  }
  return out;
}

/** Spectral-flux onset strength (full band and kick band) plus loudness per frame. */
function onsetEnvelope(pcm) {
  const fft = makeFft(N);
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const frames = Math.max(0, Math.floor((pcm.length - N) / HOP) + 1);
  const bins = Math.floor((8000 / SR) * N);
  const lowBins = Math.max(2, Math.ceil((160 / SR) * N));
  const onset = new Float64Array(frames);
  const low = new Float64Array(frames);
  const rms = new Float64Array(frames);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    let energy = 0;
    for (let i = 0; i < N; i++) {
      const s = pcm[off + i];
      energy += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(energy / N);
    fft(re, im);
    let flux = 0;
    let lowFlux = 0;
    for (let b = 1; b < bins; b++) {
      cur[b] = Math.log1p(100 * Math.hypot(re[b], im[b]));
      const d = cur[b] - prev[b];
      if (d > 0) {
        flux += d;
        if (b <= lowBins) lowFlux += d;
      }
    }
    if (f > 0) {
      onset[f] = flux;
      low[f] = lowFlux;
    }
    [prev, cur] = [cur, prev];
  }
  return { onset: normalize(highpass(onset)), low: normalize(highpass(low)), rms };
}

/** Tempo from the onset autocorrelation, weighted toward 120 BPM so we don't lock onto half or double time. */
function estimateTempo(onset) {
  const minLag = Math.floor((60 * FPS) / 200);
  const maxLag = Math.ceil((60 * FPS) / 60);
  const ac = new Float64Array(maxLag * 2 + 2);
  for (let lag = minLag; lag < ac.length; lag++) {
    let s = 0;
    for (let i = lag; i < onset.length; i++) s += onset[i] * onset[i - lag];
    ac[lag] = s / Math.max(1, onset.length - lag);
  }
  let bestLag = Math.round((60 * FPS) / 120);
  let best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * FPS) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const score = prior * (ac[lag] + 0.5 * ac[lag * 2]);
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  // Parabolic refinement for a fractional period.
  const [a, b, c] = [ac[bestLag - 1], ac[bestLag], ac[bestLag + 1]];
  const denom = a - 2 * b + c;
  const period = denom < 0 ? bestLag + (0.5 * (a - c)) / denom : bestLag;
  return { bpm: (60 * FPS) / period, period };
}

/** Dynamic-programming beat tracker (Ellis 2007): beats land on strong onsets, spaced close to the period. */
function trackBeats(onset, period, tightness = 100) {
  const n = onset.length;
  if (n < period * 4) return [];
  const local = smooth(onset, period / 16);
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let arg = -1;
    for (let p = Math.max(0, i - hi); p <= i - lo; p++) {
      const pen = Math.log((i - p) / period);
      const score = cum[p] - tightness * pen * pen;
      if (score > best) {
        best = score;
        arg = p;
      }
    }
    if (arg >= 0 && best > 0) {
      cum[i] = local[i] + best;
      back[i] = arg;
    } else {
      cum[i] = local[i];
    }
  }
  let last = n - 1;
  for (let i = Math.max(0, n - Math.round(period * 2)); i < n; i++) if (cum[i] > cum[last]) last = i;
  const frames = [];
  for (let i = last; i >= 0; i = back[i]) frames.push(i);
  frames.reverse();

  // Trim beats in silence at the very start and end.
  const sorted = frames.map((f) => local[f]).sort((x, y) => x - y);
  const floor = (sorted[Math.floor(sorted.length / 2)] || 0) * 0.15;
  while (frames.length && local[frames[0]] < floor) frames.shift();
  while (frames.length && local[frames.at(-1)] < floor) frames.pop();
  return frames;
}

/**
 * Analyze a music track for cutting.
 * @returns {{ duration, bpm, period, beats: number[], downbeats: number[], bars: {start,end,energy}[], drop: number|null }}
 */
export async function analyzeMusic(file, { signal } = {}) {
  const pcm = await decodeAudio(file, { signal });
  const duration = pcm.length / SR;
  if (duration < 3) throw new Error("The music track is too short (needs at least 3 seconds).");

  const { onset, low, rms } = onsetEnvelope(pcm);
  const { bpm, period } = estimateTempo(onset);
  const beatFrames = trackBeats(onset, period);
  const beats = beatFrames.map((f) => (f * HOP + N / 2) / SR);

  // Downbeat phase: the one of four positions where kicks hit hardest.
  let phase = 0;
  let bestPhase = -Infinity;
  for (let ph = 0; ph < 4; ph++) {
    let s = 0;
    beatFrames.forEach((f, j) => {
      if (j % 4 === ph) s += low[f] + 0.5 * onset[f];
    });
    if (s > bestPhase) {
      bestPhase = s;
      phase = ph;
    }
  }
  const downbeats = beats.filter((_, j) => j % 4 === phase);

  // Loudness per bar, 0–1.
  const beatSec = period / FPS;
  const bars = downbeats.map((start, k) => {
    const end = downbeats[k + 1] ?? Math.min(duration, start + beatSec * 4);
    const a = Math.floor((start * SR) / HOP);
    const b = Math.max(a + 1, Math.floor((end * SR) / HOP));
    let s = 0;
    for (let i = a; i < Math.min(b, rms.length); i++) s += rms[i];
    return { start, end, energy: s / (b - a) };
  });
  const maxEnergy = Math.max(1e-9, ...bars.map((b) => b.energy));
  for (const bar of bars) bar.energy = bar.energy / maxEnergy;

  // The drop: the biggest jump in loudness from the two bars before to the two bars after.
  let drop = null;
  let bestRise = 0.12;
  for (let k = 2; k < bars.length - 1; k++) {
    const after = (bars[k].energy + bars[k + 1].energy) / 2;
    const before = (bars[k - 2].energy + bars[k - 1].energy) / 2;
    if (after > 0.6 && after - before > bestRise) {
      bestRise = after - before;
      drop = bars[k].start;
    }
  }

  return {
    duration: r3(duration),
    bpm: Math.round(bpm * 10) / 10,
    period: r3(beatSec),
    beats: beats.map(r3),
    downbeats: downbeats.map(r3),
    bars: bars.map((b) => ({ start: r3(b.start), end: r3(b.end), energy: Math.round(b.energy * 100) / 100 })),
    drop: drop === null ? null : r3(drop),
  };
}

/**
 * Downbeats to start the music from so a `length`-second edit gets the strongest stretch,
 * ideally with the drop landing 15–45% of the way in. Best first.
 */
export function musicStarts(music, length, count = 3) {
  const options = [];
  const starts = music.downbeats.length ? music.downbeats : [0];
  for (const start of starts) {
    if (start + length > music.duration + 0.5 && options.length) continue;
    const inside = music.bars.filter((b) => b.start >= start && b.start < start + length);
    if (!inside.length) continue;
    const energy = inside.reduce((s, b) => s + b.energy, 0) / inside.length;
    const dropPos = music.drop !== null ? (music.drop - start) / length : -1;
    const dropBonus = dropPos >= 0.15 && dropPos <= 0.45 ? 0.35 : dropPos > 0 && dropPos < 0.8 ? 0.15 : 0;
    options.push({ time: start, score: Math.round((energy + dropBonus) * 100) / 100, dropAt: dropPos >= 0 && dropPos < 1 ? r3(music.drop - start) : null });
  }
  return options.sort((a, b) => b.score - a.score).slice(0, count);
}

/**
 * Beat times on the edit timeline (0 = music start), extended with the tempo past the
 * end of the track so a grid always exists.
 */
export function beatGrid(music, start, length) {
  const grid = (music?.beats || []).filter((t) => t >= start - 0.02).map((t) => t - start);
  const period = music?.period || 0.5;
  if (!grid.length || grid[0] > 0.05) grid.unshift(0);
  while (grid.at(-1) < length + period * 8) grid.push(grid.at(-1) + period);
  return grid.map(r3);
}
