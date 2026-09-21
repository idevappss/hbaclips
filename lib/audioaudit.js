// Checks a music track before it goes under someone's voice: a bed that was once a low-bitrate MP3 sounds dull
// and swirly, one that was clipped and then turned down keeps its distortion at any volume, and one with its
// channels out of phase partly cancels itself on a phone speaker. Methods after AudioAuditor (Apache-2.0),
// rebuilt here from its published thresholds rather than its code.
import { spawn } from "node:child_process";
import { FFMPEG } from "./tools.js";

const RATE = 44100;
const N = 4096;
const WINDOWS = 60;
const EXCERPT = 30; // seconds from the middle of the track

/** Stereo float samples from the middle of a file (mono files come back with identical channels). */
function decodeExcerpt(file, duration) {
  const start = Math.max(0, (Number(duration) || 0) / 2 - EXCERPT / 2);
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-v", "error", "-ss", String(start), "-t", String(EXCERPT), "-i", file, "-vn", "-ac", "2", "-ar", String(RATE), "-f", "f32le", "-"]);
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg couldn't decode the track (exit ${code})`));
      const buf = Buffer.concat(chunks);
      const frames = Math.floor(buf.length / 8);
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        left[i] = buf.readFloatLE(i * 8);
        right[i] = buf.readFloatLE(i * 8 + 4);
      }
      resolve({ left, right });
    });
  });
}

/** In-place radix-2 FFT; returns magnitudes of the first N/2 bins. */
function magnitudes(re) {
  const n = re.length;
  const im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]];
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
  const out = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i], im[i]);
  return out;
}

/** Average spectrum in dB (louder channel per bin, so a stereo trick can't hide a missing band). */
function spectrum(left, right) {
  const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const sum = new Float64Array(N / 2);
  const usable = left.length - N;
  if (usable <= 0) return null;
  for (let w = 0; w < WINDOWS; w++) {
    const at = Math.floor((usable * w) / (WINDOWS - 1));
    const l = Float64Array.from({ length: N }, (_, i) => left[at + i] * hann[i]);
    const r = Float64Array.from({ length: N }, (_, i) => right[at + i] * hann[i]);
    const ml = magnitudes(l);
    const mr = magnitudes(r);
    for (let i = 0; i < N / 2; i++) sum[i] += Math.max(ml[i], mr[i]);
  }
  const peak = Math.max(...sum) || 1;
  return Array.from(sum, (v) => 20 * Math.log10(v / peak + 1e-12));
}

/**
 * The frequency where the sound hits an encoder's brick wall: the steepest drop of 25 dB or more above 10 kHz,
 * comparing 1.3 kHz bands either side of a small gap. Null when the top end rolls off naturally.
 */
function spectralWall(db) {
  const hz = RATE / N;
  const bin = (f) => Math.round(f / hz);
  const mean = (a, b) => {
    let s = 0;
    for (let i = bin(a); i < bin(b); i++) s += db[i];
    return s / Math.max(1, bin(b) - bin(a));
  };
  let best = { drop: 0, at: null };
  for (let f = 10000; f < RATE / 2 - 1600; f += 100) {
    const drop = mean(f - 1500, f - 200) - mean(f + 200, f + 1500);
    if (drop > best.drop) best = { drop, at: f };
  }
  return best.drop >= 25 ? { hz: best.at, drop: Math.round(best.drop) } : null;
}

/**
 * @returns {{ grade: "good"|"fair"|"poor", cutoffHz, clipped, correlation, notes: string[] }}
 *   poor: too dull or broken to sit under a premium voice; fair: fine at bed level, not a first choice.
 */
export async function auditTrack(file, { duration } = {}) {
  const { left, right } = await decodeExcerpt(file, duration);
  const notes = [];
  if (left.length < N * 4) return { grade: "fair", cutoffHz: null, clipped: false, correlation: null, notes: ["too short to check"] };

  const db = spectrum(left, right);
  const wall = db && spectralWall(db);
  const cutoffHz = wall?.hz ?? null;

  // Clipped then turned down: an unusual number of samples pressed flat against the track's own peak.
  let peak = 0;
  for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  let atPeak = 0;
  const ceiling = peak * 0.9999;
  for (let i = 0; i < left.length; i++) if (Math.abs(left[i]) >= ceiling || Math.abs(right[i]) >= ceiling) atPeak++;
  const clipped = peak > 0.2 && atPeak / left.length > 0.0001;

  // Left against right: 1 is mono, around 0 is wide, below 0 cancels when a phone sums it to mono.
  let sl = 0, sr = 0, sll = 0, srr = 0, slr = 0;
  for (let i = 0; i < left.length; i++) {
    sl += left[i];
    sr += right[i];
    sll += left[i] * left[i];
    srr += right[i] * right[i];
    slr += left[i] * right[i];
  }
  const n = left.length;
  const cov = slr / n - (sl / n) * (sr / n);
  const spread = Math.sqrt((sll / n - (sl / n) ** 2) * (srr / n - (sr / n) ** 2));
  const correlation = spread > 1e-9 ? Math.round((cov / spread) * 1000) / 1000 : 1;

  let grade = "good";
  if (cutoffHz && cutoffHz < 12000) {
    grade = "poor";
    notes.push(`dull: cut off at ${(cutoffHz / 1000).toFixed(1)} kHz, a very low-bitrate source`);
  } else if (cutoffHz && cutoffHz < 16000) {
    grade = "fair";
    notes.push(`cut off at ${(cutoffHz / 1000).toFixed(1)} kHz (a ~128 kbps source)`);
  }
  if (correlation < -0.2) {
    grade = "poor";
    notes.push("channels out of phase: it thins out or vanishes on a phone speaker");
  }
  if (clipped) {
    if (grade === "good") grade = "fair";
    notes.push("clipped: the distortion stays even when it's turned down");
  }
  if (correlation >= 0.995) notes.push("mono");
  return { grade, cutoffHz, clipped, correlation, notes };
}
