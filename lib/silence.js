// Where the speaker is actually silent, measured from the sound rather than the transcript. Whisper stretches a
// word's timing across the pause after it ("so……… anyway"), which hides dead air from a cut that only looks at
// the gaps between words. Measured once per project from the cleaned dialogue and cached next to it.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { projectDir } from "./store.js";
import { FFMPEG, abortError } from "./tools.js";

// Measured from the original sound: the dialogue cleanup evens out loud and quiet on purpose, which erases
// exactly the difference between talking and not talking (on one podcast it lifted the quiet floor 14 dB).
const RATE = 8000;
const WINDOW = 400; // 50 ms of samples
const MIN_WINDOWS = 6; // 0.3 s
const VERSION = 2;

const cacheFile = (project) => path.join(projectDir(project.id), "silence.json");
const jobs = new Map();

/** Silent stretches [{ start, end }] in the video's sound, measured once and cached; [] without sound. */
export async function findSilences(project, { signal } = {}) {
  const cached = await readSilences(project);
  if (cached) return cached;
  if (!project.source?.hasAudio || !project.source.file) return [];
  if (!jobs.has(project.id)) {
    const job = measure(path.join(projectDir(project.id), project.source.file), signal)
      .then(async (silences) => {
        await fs.writeFile(cacheFile(project), JSON.stringify({ version: VERSION, silences }));
        return silences;
      })
      .finally(() => jobs.delete(project.id));
    jobs.set(project.id, job);
  }
  return jobs.get(project.id);
}

/** The cached silences, or null when they haven't been measured yet (never blocks). */
export async function readSilences(project) {
  try {
    const data = JSON.parse(await fs.readFile(cacheFile(project), "utf8"));
    return data.version === VERSION ? data.silences : null;
  } catch {
    return null;
  }
}

/** Loudness in dB of every 50 ms of the file's sound, decoded as 8 kHz mono. */
function envelope(file, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const child = spawn(FFMPEG, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"]);
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
          levels.push(10 * Math.log10(sum / WINDOW + 1e-10));
          sum = 0;
          count = 0;
        }
      }
      carry = buf.subarray(whole);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(abortError());
      if (code !== 0) return reject(new Error(`ffmpeg couldn't read the sound (exit ${code})`));
      resolve(levels);
    });
  });
}

async function measure(file, signal) {
  const levels = await envelope(file, signal);
  if (levels.length < 40) return [];
  const sorted = [...levels].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const speech = sorted[Math.floor(sorted.length * 0.9)];
  // Too little between the room and the voice (music under the talking, a loud street): don't guess.
  if (speech - floor < 12) return [];
  const gate = floor + (speech - floor) * 0.3;

  const silences = [];
  const sec = WINDOW / RATE;
  let runStart = -1;
  let blips = 0;
  for (let i = 0; i <= levels.length; i++) {
    const quiet = i < levels.length && levels[i] < gate;
    if (quiet) {
      if (runStart < 0) runStart = i;
      blips = 0;
    } else if (runStart >= 0 && i < levels.length && blips === 0 && levels[i + 1] < gate) {
      blips = 1; // one loud 50 ms (a click, a breath) inside a pause doesn't end it
    } else if (runStart >= 0) {
      const end = i - blips;
      if (end - runStart >= MIN_WINDOWS) silences.push({ start: Math.round(runStart * sec * 1000) / 1000, end: Math.round(end * sec * 1000) / 1000 });
      runStart = -1;
      blips = 0;
    }
  }
  return silences;
}

/**
 * Pull word timings back to the sound: a word whose tail (or head) runs into measured silence ends where the
 * silence starts (or starts where it ends), so the pause between words shows its real length.
 */
export function fitWordsToSpeech(words, silences) {
  // Only real pauses count: a short quiet run inside a word is usually a soft consonant, not air.
  const pauses = (silences || []).filter((s) => s.end - s.start >= 0.45);
  if (!pauses.length) return words;
  silences = pauses;
  let k = 0;
  return words.map((w) => {
    while (k < silences.length && silences[k].end <= w.start) k++;
    let { start, end } = w;
    for (let m = k; m < silences.length && silences[m].start < end; m++) {
      const s = silences[m];
      // Keep a sliver of the word either side so a cut never clips its consonants.
      if (s.start > start + 0.12 && s.start < end) end = Math.min(end, s.start + 0.1);
      else if (s.end > start && s.end < end - 0.12 && s.start <= start) start = Math.max(start, s.end - 0.08);
    }
    return start === w.start && end === w.end ? w : { ...w, start, end: Math.max(end, start + 0.08) };
  });
}
