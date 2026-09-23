// Candidate stills for a thumbnail: frames spread across the video, scored on faces, sharpness and light.
// Owned by the THUMBNAILS session. Nothing here writes into projects/ — stills land in data/thumbnails/.
import fs from "node:fs/promises";
import path from "node:path";
import { FFMPEG, run } from "../lib/tools.js";
import { trackerBinary } from "../lib/subject.js";

const r3 = (n) => Math.round(n * 1000) / 1000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Times to sample: spread across the body of the video, skipping the cold open and the outro. */
export function sampleTimes(duration, count) {
  const from = Math.min(duration * 0.06, 20);
  const to = duration - Math.min(duration * 0.06, 20);
  const span = Math.max(to - from, 0.1);
  return Array.from({ length: count }, (_, i) => r3(from + (span * (i + 0.5)) / count));
}

/** One still at `at` seconds, 1280 wide, as a JPEG in outDir. */
async function grab(videoPath, at, file, { signal, width = 1280 } = {}) {
  await run(
    FFMPEG,
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(at), "-i", videoPath, "-frames:v", "1",
     "-vf", `scale=${width}:-2:flags=lanczos`, "-q:v", "2", "-y", file],
    { signal },
  );
  return file;
}

/** Faces in one still, via the Apple Vision tracker the crop uses. [] when it isn't available. */
async function facesAt(videoPath, at, signal) {
  const bin = await trackerBinary();
  if (!bin) return [];
  try {
    const out = await run(bin, [videoPath, String(r3(at)), String(r3(at + 0.04)), "1"], { signal });
    const sample = out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).find((s) => !s.error);
    return sample?.faces || [];
  } catch {
    return []; // a frame the tracker can't read shouldn't sink the whole batch
  }
}

/** Sharpness (0–1), mid-tone brightness and contrast, from sharp's stats when it's installed. */
async function look(file) {
  try {
    const { default: sharp } = await import("sharp");
    const stats = await sharp(file).stats();
    const lum = stats.channels.slice(0, 3);
    const mean = lum.reduce((s, c) => s + c.mean, 0) / (lum.length * 255);
    const spread = lum.reduce((s, c) => s + c.stdev, 0) / (lum.length * 255);
    return { sharpness: clamp((stats.sharpness ?? 0) / 12, 0, 1), brightness: r3(mean), contrast: r3(clamp(spread * 2.4, 0, 1)) };
  } catch {
    return { sharpness: 0.5, brightness: 0.5, contrast: 0.5 };
  }
}

const area = (b) => b[2] * b[3];

/**
 * Score a still the way a thumbnail wants it: a clear face big in frame, sharp, well lit and punchy.
 * 0–1, and the face position the composition uses to keep the headline off the speaker.
 */
function score({ faces, sharpness, brightness, contrast }) {
  const face = faces.filter((b) => b[4] >= 0.5).sort((a, b) => area(b) - area(a))[0] || null;
  const faceScore = face ? clamp(0.55 + area(face) * 6, 0, 1) : 0;
  const lightScore = 1 - Math.abs(brightness - 0.52) * 2.2;
  const value = 0.42 * faceScore + 0.24 * sharpness + 0.2 * contrast + 0.14 * clamp(lightScore, 0, 1);
  return {
    score: r3(clamp(value, 0, 1)),
    face: face ? { x: r3(face[0] + face[2] / 2), y: r3(face[1] + face[3] / 2), size: r3(Math.sqrt(area(face))) } : null,
  };
}

/**
 * Candidate stills for one video, best first.
 * → [{ at, file, url, score, face, sharpness, brightness, contrast }]
 */
export async function candidates(videoPath, { duration, count = 12, outDir, signal, onProgress } = {}) {
  await fs.mkdir(outDir, { recursive: true });
  const times = sampleTimes(duration, count);
  const out = [];
  for (const [i, at] of times.entries()) {
    const file = path.join(outDir, `frame-${String(i).padStart(2, "0")}.jpg`);
    try {
      await grab(videoPath, at, file, { signal });
    } catch {
      continue; // a seek past a damaged part of the file: take what the rest gives us
    }
    const [faces, shape] = await Promise.all([facesAt(videoPath, at, signal), look(file)]);
    out.push({ at, file, index: i, ...shape, ...score({ faces, ...shape }) });
    onProgress?.(Math.round((100 * (i + 1)) / times.length));
  }
  if (!out.length) throw new Error("Couldn't read a single frame out of this video.");
  return out.sort((a, b) => b.score - a.score);
}
