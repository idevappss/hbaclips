// Keeps the subject in frame when a wide shot is cropped to a taller canvas (16:9 footage → 9:16 reels).
// Apple's on-device Vision framework (lib/vision/track.swift, compiled on first use) finds faces, people and
// salient objects; the crop follows the main face, else the main person, else the main object.
import fs from "node:fs/promises";
import path from "node:path";
import { ROOT, run } from "./tools.js";

const SWIFT_SRC = path.join(ROOT, "lib", "vision", "track.swift");
const BIN = path.join(ROOT, "data", "bin", "vision-track");
const r3 = (n) => Math.round(n * 1000) / 1000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

let binary = null;

/** Path to the compiled tracker, building it when missing or older than its source; null when unavailable. */
export function trackerBinary() {
  if (process.platform !== "darwin") return Promise.resolve(null);
  binary ??= (async () => {
    const [src, bin] = await Promise.all([fs.stat(SWIFT_SRC), fs.stat(BIN).catch(() => null)]);
    if (!bin || bin.mtimeMs < src.mtimeMs) {
      await fs.mkdir(path.dirname(BIN), { recursive: true });
      await run("swiftc", ["-O", "-swift-version", "5", SWIFT_SRC, "-o", BIN]);
    }
    return BIN;
  })().catch((err) => {
    console.error("Subject tracking unavailable (crops stay centered):", err.message.split("\n")[0]);
    return null;
  });
  return binary;
}

const area = (b) => b[2] * b[3];
const centerX = (b) => b[0] + b[2] / 2;

/**
 * Where the subject is in one sampled frame (0–1 across the source width), or null if nothing was found.
 * Faces win (biggest × most confident); in a crowd, a face near the previous focus wins over a similar-sized
 * one across the frame, so the crop doesn't ping-pong. Then people, then the most salient object.
 */
function subjectX(sample, previous) {
  const pick = (boxes, minArea) => {
    const usable = (boxes || []).filter((b) => area(b) >= minArea && b[4] >= 0.5);
    if (!usable.length) return null;
    const weight = (b) => area(b) * b[4] * (previous == null ? 1 : 1 + 0.6 * (1 - Math.min(1, Math.abs(centerX(b) - previous) * 3)));
    return centerX(usable.reduce((best, b) => (weight(b) > weight(best) ? b : best)));
  };
  return pick(sample.faces, 0.0025) ?? pick(sample.humans, 0.02) ?? pick(sample.objects, 0.03);
}

/**
 * Sample a time range and return the smoothed subject path: [{ t, x }] with x in 0–1 (null entries filled from
 * neighbours). Returns [] when tracking isn't available or nothing was found.
 */
export async function trackSubject(videoPath, start, end, { step = 0.5, signal } = {}) {
  const bin = await trackerBinary();
  if (!bin || end <= start) return [];
  const out = await run(bin, [videoPath, String(r3(start)), String(r3(end)), String(step)], { signal });
  const samples = out
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .filter((s) => !s.error);

  let previous = null;
  const raw = samples.map((s) => {
    const x = subjectX(s, previous);
    if (x != null) previous = x;
    return { t: s.t, x };
  });
  if (!raw.some((p) => p.x != null)) return [];

  // Fill gaps from the nearest found sample, then median-of-3 and a gentle ease so the crop glides.
  const filled = raw.map((p, i) => {
    if (p.x != null) return p.x;
    for (let d = 1; d < raw.length; d++) {
      const x = raw[i - d]?.x ?? raw[i + d]?.x;
      if (x != null) return x;
    }
    return 0.5;
  });
  const median = filled.map((_, i) => [filled[i - 1] ?? filled[i], filled[i], filled[i + 1] ?? filled[i]].sort((a, b) => a - b)[1]);
  let eased = median[0];
  return median.map((x, i) => {
    eased = i ? eased + (x - eased) * 0.45 : x;
    return { t: raw[i].t, x: r3(eased) };
  });
}

/** The subject's typical position over a stretch (median), or null. */
export function typicalX(track, from = -Infinity, to = Infinity) {
  const xs = track.filter((p) => p.t >= from - 0.01 && p.t <= to + 0.01).map((p) => p.x).sort((a, b) => a - b);
  return xs.length ? xs[Math.floor(xs.length / 2)] : null;
}

/**
 * CSS object-position (percent) that centers subject x (0–1 of the source width) inside a cover crop, without
 * showing past the frame edge. Sources no wider than the canvas aren't cropped sideways, so they stay at 50.
 */
export function objectPositionFor(x, source, canvas) {
  if (x == null || !source?.width || !source?.height) return 50;
  const visible = canvas.width / canvas.height / (source.width / source.height); // share of the source width in view
  if (visible >= 0.999) return 50;
  const left = clamp(x - visible / 2, 0, 1 - visible);
  return Math.round((left / (1 - visible)) * 1000) / 10;
}
