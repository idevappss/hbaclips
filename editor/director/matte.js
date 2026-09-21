// Person cutouts for emphasis captions: the few seconds of the talking video under a big caption are run through
// HyperFrames' remove-background (a local human-segmentation model) into a transparent WebM. The composer lays
// that cutout over the caption, so the words sit behind the speaker. Only those seconds are ever matted.
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { FFMPEG, HYPERFRAMES, run } from "../../lib/tools.js";
import { workingFile } from "../../lib/work.js";
import { DATA_DIR } from "../media.js";

const LEAD = 0.5; // seconds of cutout before the words land and after they leave
const r3 = (n) => Math.round(n * 1000) / 1000;

export const mattesDir = (projectId) => path.join(DATA_DIR, projectId, "mattes");
export const matteUrl = (projectId, file) => `/api/editor/projects/${projectId}/mattes/${encodeURIComponent(file)}`;

/** The source window a timeline range plays from, when it sits inside one video piece. */
export function sourceWindow(doc, start, end) {
  const videos = doc.tracks.filter((t) => t.kind === "video" && !t.hidden).flatMap((t) => t.clips);
  const piece = videos.find((c) => start >= c.start - 1e-3 && start < c.start + c.duration);
  if (!piece) return null;
  const speed = piece.speed || 1;
  const a = Math.max(piece.start, start - LEAD);
  const b = Math.min(piece.start + piece.duration, end + LEAD);
  return { at: r3(a), until: r3(b), from: r3(piece.sourceStart + (a - piece.start) * speed), to: r3(piece.sourceStart + (b - piece.start) * speed) };
}

const keyFor = (file, w) => crypto.createHash("sha1").update(`${file}|${w.from}|${w.to}|v1`).digest("hex").slice(0, 16);

const jobs = new Map(); // file → { state: "queued"|"running"|"done"|"error", error }
let chain = Promise.resolve();

/**
 * Make sure every emphasis clip in the document has a cutout (queued one at a time). Returns the current state
 * per clip id. Clips get `matte = { file, at, mediaStart }` filled in by `attachMattes` once their file exists.
 */
export function ensureMattes(project, doc) {
  const src = workingFile(project);
  const status = {};
  for (const clip of emphasisClips(doc)) {
    const w = sourceWindow(doc, clip.start, clip.start + clip.duration);
    if (!w) {
      status[clip.id] = { state: "none" };
      continue;
    }
    const file = `${keyFor(src, w)}.webm`;
    const out = path.join(mattesDir(project.id), file);
    if (existsSync(out)) {
      status[clip.id] = { state: "done", file };
      continue;
    }
    if (!jobs.has(out)) {
      jobs.set(out, { state: "queued" });
      chain = chain.then(() => cut(src, out, w)).catch(() => {});
    }
    status[clip.id] = { ...jobs.get(out), file };
  }
  return status;
}

async function cut(src, out, w) {
  const job = jobs.get(out);
  job.state = "running";
  const tmp = `${out}.${crypto.randomBytes(3).toString("hex")}`;
  try {
    await fs.mkdir(path.dirname(out), { recursive: true });
    await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(w.from), "-i", src, "-t", String(r3(w.to - w.from)), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", `${tmp}.mp4`]);
    await run(HYPERFRAMES, ["remove-background", `${tmp}.mp4`, "-o", `${tmp}.webm`, "--quality", "balanced"]);
    await fs.rename(`${tmp}.webm`, out);
    job.state = "done";
  } catch (err) {
    console.error("Editor matte:", err.message);
    Object.assign(job, { state: "error", error: String(err.message).split("\n")[0] });
  } finally {
    await fs.rm(`${tmp}.mp4`, { force: true });
    await fs.rm(`${tmp}.webm`, { force: true });
  }
}

const emphasisClips = (doc) => doc.tracks.filter((t) => t.kind === "emphasis" && !t.hidden).flatMap((t) => t.clips);

/** A copy of the document's emphasis clips with the cutout each one can use right now (or none yet). */
export function attachMattes(project, doc) {
  const src = workingFile(project);
  const out = new Map();
  for (const clip of emphasisClips(doc)) {
    const w = sourceWindow(doc, clip.start, clip.start + clip.duration);
    if (!w) continue;
    const file = `${keyFor(src, w)}.webm`;
    if (existsSync(path.join(mattesDir(project.id), file))) out.set(clip.id, { file, at: w.at, until: w.until });
  }
  return out;
}
