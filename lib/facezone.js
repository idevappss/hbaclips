// Where faces sit, top to bottom, across a clip — so captions on full-screen styles never cover someone's face.
// Apple Vision (lib/vision/track.swift) reads a handful of frames; the typical face band (median top and bottom,
// as a share of the frame height) is cached per clip range. Idea after OpenChatCut's caption-avoidance check,
// reimplemented here.
import fs from "node:fs/promises";
import path from "node:path";
import { projectDir } from "./store.js";
import { run } from "./tools.js";
import { trackerBinary } from "./subject.js";
import { workingFile } from "./work.js";

const cacheFile = (project, start, end) => path.join(projectDir(project.id), "faces", `${Math.round(start * 10)}-${Math.round(end * 10)}.json`);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

/** { top, bottom } of the main faces as 0–1 of the frame height, or null when no face is seen. Cached. */
export async function faceBand(project, start, end, { signal, compute = true } = {}) {
  const file = cacheFile(project, start, end);
  try {
    return JSON.parse(await fs.readFile(file, "utf8")).band;
  } catch {
    // not measured yet
  }
  if (!compute) return null;
  const bin = await trackerBinary();
  if (!bin) return null;
  const step = Math.max(1, (end - start) / 10);
  const out = await run(bin, [workingFile(project), String(start + 0.5), String(end - 0.5), String(step)], { signal });
  const tops = [];
  const bottoms = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("{")) continue;
    const sample = JSON.parse(line);
    // The faces that matter: anyone at least a quarter the size of the biggest face in the frame.
    const faces = (sample.faces || []).filter((b) => b[4] >= 0.5);
    const biggest = Math.max(0, ...faces.map((b) => b[2] * b[3]));
    for (const b of faces.filter((f) => f[2] * f[3] >= biggest * 0.25)) {
      tops.push(b[1]);
      bottoms.push(b[1] + b[3]);
    }
  }
  const band = tops.length >= 3 ? { top: Math.round(median(tops) * 1000) / 1000, bottom: Math.round(median(bottoms) * 1000) / 1000 } : null;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ band }));
  return band;
}

/**
 * The caption height (percent from the top of the frame) that keeps a caption band clear of the faces, given where
 * it would sit now. Returns the same value when there's no overlap or nowhere better to go. Keeps the bottom 20%
 * clear for Instagram's buttons and caption text, and the top 12% clear for the account row.
 * @param bandPct  the caption band's height as a percent of the frame (two lines of text)
 */
export function captionClearOfFaces(captionY, band, bandPct = 14) {
  if (!band) return captionY;
  const pad = 4;
  const faceTop = band.top * 100 - pad;
  const faceBottom = band.bottom * 100 + pad;
  const half = bandPct / 2;
  const overlap = Math.max(0, Math.min(captionY + half, faceBottom) - Math.max(captionY - half, faceTop));
  if (overlap < bandPct * 0.2) return captionY;
  const below = faceBottom + half;
  if (below <= 80 - half) return Math.round(below);
  const above = faceTop - half;
  if (above >= 12 + half) return Math.round(above);
  return captionY;
}
