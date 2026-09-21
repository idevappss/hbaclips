// How loud the cleaned dialogue is every 10 ms, so every cut can land in the quietest instant between words instead
// of on the tail of one (which plays as a click or a clipped syllable). Measured once per project from the working
// copy's sound — the audio renders actually use — and cached as one byte per 10 ms (dB, rounded).
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { projectDir } from "./store.js";
import { FFMPEG } from "./tools.js";
import { AUDIO_CLEANUP_VERSION } from "./media.js";
import { cleanAudioFile } from "./work.js";

export const LEVEL_STEP = 0.01;
const RATE = 16000;
const WINDOW = RATE * LEVEL_STEP;
const file = (project) => path.join(projectDir(project.id), `levels-v${AUDIO_CLEANUP_VERSION}.bin`);
const jobs = new Map();

/** The level map as an Int8Array of dB (−127…0) per 10 ms, or null if it hasn't been measured. Never blocks. */
export async function readLevels(project) {
  try {
    const buf = await fs.readFile(file(project));
    return new Int8Array(buf.buffer, buf.byteOffset, buf.length);
  } catch {
    return null;
  }
}

/** Measure (once) and return the level map; null when the project has no cleaned sound yet. */
export async function measureLevels(project, { signal } = {}) {
  const cached = await readLevels(project);
  if (cached) return cached;
  const audio = cleanAudioFile(project);
  if (!audio) return null;
  if (!jobs.has(project.id)) {
    const job = new Promise((resolve, reject) => {
      const child = spawn(FFMPEG, ["-v", "error", "-i", audio, "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"]);
      const levels = [];
      let sum = 0;
      let count = 0;
      let carry = Buffer.alloc(0);
      const onAbort = () => child.kill("SIGKILL");
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk) => {
        const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        const whole = buf.length - (buf.length % 2);
        for (let i = 0; i < whole; i += 2) {
          const v = buf.readInt16LE(i) / 32768;
          sum += v * v;
          if (++count === WINDOW) {
            levels.push(Math.max(-127, Math.round(10 * Math.log10(sum / WINDOW + 1e-13))));
            sum = 0;
            count = 0;
          }
        }
        carry = buf.subarray(whole);
      });
      child.on("error", reject);
      child.on("close", async (code) => {
        signal?.removeEventListener("abort", onAbort);
        if (code !== 0) return reject(new Error(`ffmpeg couldn't read the sound (${code})`));
        const out = Int8Array.from(levels);
        await fs.writeFile(file(project), Buffer.from(out.buffer));
        resolve(out);
      });
    }).finally(() => jobs.delete(project.id));
    jobs.set(project.id, job);
  }
  return jobs.get(project.id);
}

/** The quietest instant in [from, to] (seconds), or null when the window is empty or unmeasured. */
export function quietestAt(levels, from, to) {
  if (!levels || !(to > from)) return null;
  const a = Math.max(0, Math.floor(from / LEVEL_STEP));
  const b = Math.min(levels.length - 1, Math.ceil(to / LEVEL_STEP));
  if (b < a) return null;
  let best = a;
  // Ties go to the middle of the quietest stretch, not its edge.
  for (let i = a; i <= b; i++) if (levels[i] < levels[best]) best = i;
  let end = best;
  while (end + 1 <= b && levels[end + 1] === levels[best]) end++;
  return ((best + end) / 2) * LEVEL_STEP + LEVEL_STEP / 2;
}
