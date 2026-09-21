// Word timings pinned to the audio with WhisperX's aligner (lib/align/align.py). whisper.cpp hears the words well
// but its timings drift — a word's end runs into the pause after it — and every cut and caption is placed from
// those timings. WhisperX lives in its own Python environment (~/.cache/clipstudio/whisperx); when it isn't
// there, or a stretch won't align, the original timings stay.
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { FFMPEG, ROOT } from "./tools.js";

const VENV_PY = path.join(os.homedir(), ".cache", "clipstudio", "whisperx", "venv", "bin", "python");
const SCRIPT = path.join(ROOT, "lib", "align", "align.py");

export const alignerAvailable = () => existsSync(VENV_PY);

/** Segments for the aligner: sentence-sized runs of words (split on punctuation, pauses and length). */
function toSegments(words) {
  const segments = [];
  let run = [];
  const flush = () => {
    if (run.length) segments.push({ from: run[0].i, to: run.at(-1).i, start: run[0].w.start, end: run.at(-1).w.end, text: run.map((r) => r.w.text).join(" ") });
    run = [];
  };
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (run.length && (w.start - prev.end > 0.8 || run.length >= 30)) flush();
    run.push({ w, i });
    if (/[.?!]$/.test(String(w.text))) flush();
  });
  flush();
  return segments;
}

/**
 * @param media  the audio or video to align against (the cleaned working copy is best)
 * @returns words with aligned start/end where the aligner placed them confidently; untouched otherwise
 */
export async function alignWords(media, words, { language = "en", onProgress, signal } = {}) {
  if (!alignerAvailable() || !words?.length) return words;
  const segments = toSegments(words);
  const tmp = path.join(os.tmpdir(), `align-${crypto.randomBytes(4).toString("hex")}`);
  const segFile = `${tmp}-in.json`;
  const outFile = `${tmp}-out.json`;
  await fs.writeFile(segFile, JSON.stringify(segments.map(({ start, end, text }) => ({ start, end, text }))));
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(VENV_PY, [SCRIPT, media, segFile, outFile, language === "auto" ? "en" : language], {
        env: { ...process.env, PATH: [path.dirname(FFMPEG), process.env.PATH].join(path.delimiter), TOKENIZERS_PARALLELISM: "false" },
      });
      let tail = "";
      child.stderr.on("data", (d) => {
        const text = d.toString();
        tail = (tail + text).slice(-2000);
        const m = text.match(/PROGRESS (\d+)\/(\d+)/g)?.pop()?.match(/(\d+)\/(\d+)/);
        if (m) onProgress?.(Number(m[1]) / Number(m[2]));
      });
      const onAbort = () => child.kill("SIGKILL");
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", reject);
      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        code === 0 ? resolve() : reject(new Error(`WhisperX alignment failed (${code}): ${tail.trim().split("\n").pop()}`));
      });
    });
    const aligned = JSON.parse(await fs.readFile(outFile, "utf8"));
    const out = words.map((w) => ({ ...w }));
    let moved = 0;
    segments.forEach((seg, s) => {
      const placed = aligned[s]?.words || [];
      for (let k = 0; k <= seg.to - seg.from; k++) {
        const a = placed[k];
        const w = out[seg.from + k];
        // Trust a placement only near where whisper heard the word; a wild jump means the aligner lost its place.
        if (!a || !Number.isFinite(a.start) || !Number.isFinite(a.end) || a.end <= a.start) continue;
        if (Math.abs(a.start - w.start) > 1 || Math.abs(a.end - w.end) > 1 || a.end - a.start > 2.5) continue;
        w.start = Math.round(a.start * 1000) / 1000;
        w.end = Math.round(a.end * 1000) / 1000;
        moved++;
      }
    });
    // Keep the timeline in order.
    for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].start) out[i].start = out[i - 1].start;
    out.aligned = { words: moved, of: words.length };
    return out;
  } finally {
    await fs.rm(segFile, { force: true });
    await fs.rm(outFile, { force: true });
  }
}
