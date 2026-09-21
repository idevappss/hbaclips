// Timeline media: waveform peaks and filmstrip frames, cut once with ffmpeg and cached under data/editor/.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { FFMPEG, ROOT, toolEnv } from "../lib/tools.js";

export const DATA_DIR = path.join(ROOT, "data", "editor");
export const PEAK_RATE = 50; // peaks per second of audio
const SAMPLE_RATE = 2000;

const pending = new Map();
/** One job per key at a time; everyone asking for it shares the result. */
function once(key, job) {
  if (!pending.has(key)) pending.set(key, job().finally(() => pending.delete(key)));
  return pending.get(key);
}

/** A few ffmpeg jobs at a time, so a filmstrip scrolling past doesn't fork a hundred processes. */
const slots = { free: 3, queue: [] };
async function limited(job) {
  if (slots.free <= 0) await new Promise((resolve) => slots.queue.push(resolve));
  slots.free -= 1;
  try {
    return await job();
  } finally {
    slots.free += 1;
    slots.queue.shift()?.();
  }
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", ...args], { env: toolEnv });
    const out = [];
    let err = "";
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(err.trim().split("\n").slice(-3).join(" ") || `ffmpeg exited with ${code}`))));
  });
}

async function writeAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

/** Loudness peaks for a whole media file: one byte (0–255) per 1/PEAK_RATE second. */
export function peaksFor(mediaFile, cacheFile) {
  return once(cacheFile, async () => {
    if (existsSync(cacheFile)) return fs.readFile(cacheFile);
    const pcm = await limited(() => ffmpeg(["-i", mediaFile, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"]));
    const per = SAMPLE_RATE / PEAK_RATE;
    const count = Math.ceil(pcm.length / 2 / per);
    const peaks = Buffer.alloc(count);
    for (let i = 0; i < count; i++) {
      let max = 0;
      const end = Math.min(pcm.length / 2, (i + 1) * per);
      for (let j = i * per; j < end; j++) max = Math.max(max, Math.abs(pcm.readInt16LE(j * 2)));
      // A gentle curve so quiet speech still reads on the track.
      peaks[i] = Math.round(255 * Math.sqrt(max / 32768));
    }
    await writeAtomic(cacheFile, peaks);
    return peaks;
  });
}

export const THUMB_HEIGHT = 96;

/** One filmstrip frame (JPEG) at a whole second of the source. */
export function thumbFor(mediaFile, cacheDir, sec) {
  const file = path.join(cacheDir, `${sec}.jpg`);
  return once(file, async () => {
    if (existsSync(file)) return file;
    const jpg = await limited(() => ffmpeg(["-ss", String(sec), "-i", mediaFile, "-frames:v", "1", "-vf", `scale=-2:${THUMB_HEIGHT}`, "-q:v", "7", "-f", "image2", "-c:v", "mjpeg", "-"]));
    if (!jpg.length) throw new Error("No frame there");
    await writeAtomic(file, jpg);
    return file;
  });
}
