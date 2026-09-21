import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HYPERFRAMES, ROOT, run } from "./tools.js";

const MODELS_DIR = path.join(os.homedir(), ".cache", "hyperframes", "whisper", "models");

/**
 * Caption accuracy levels (local Whisper via HyperFrames). Bigger models make fewer word mistakes but run slower
 * and download once (from Hugging Face, ggerganov/whisper.cpp) the first time they're used.
 */
export const CAPTION_QUALITY = {
  standard: { label: "Standard", hint: "Fast", en: "small.en", any: "small", sizeMb: 488 },
  high: { label: "High", hint: "Fewer mistakes, ~3× slower", en: "medium.en", any: "medium", sizeMb: 1530 },
  best: { label: "Best", hint: "Most accurate, slowest", en: "large-v3", any: "large-v3", sizeMb: 3100 },
};

const modelFor = (quality, language) => {
  const level = CAPTION_QUALITY[quality] || CAPTION_QUALITY.standard;
  // `.en` models translate non-English speech, so only use them for English.
  return language === "en" ? level.en : level.any;
};

/** Which caption levels are ready to use without a download. */
export async function captionQualityStatus() {
  const files = new Set(await fs.readdir(MODELS_DIR).catch(() => []));
  return Object.fromEntries(
    Object.entries(CAPTION_QUALITY).map(([id, level]) => [
      id,
      { ...level, installed: files.has(`ggml-${level.en}.bin`) || files.has(`ggml-${level.any}.bin`) },
    ]),
  );
}

/**
 * Word-level transcript via HyperFrames' local speech-to-text (Parakeet when installed, otherwise Whisper).
 * Returns a flat array: [{ text, start, end }, ...]
 */
export async function transcribe(videoPath, workDir, { language = "en", quality = "standard", onProgress, signal } = {}) {
  const model = process.env.WHISPER_MODEL || modelFor(quality, language);
  const args = ["transcribe", videoPath, "-d", workDir, "--model", model, "--json"];
  if (language && language !== "auto") args.push("--language", language);

  await run(HYPERFRAMES, args, { cwd: ROOT, onLine: onProgress, signal });

  const words = JSON.parse(await fs.readFile(path.join(workDir, "transcript.json"), "utf8"));
  // Whisper marks non-speech as ♪, [MUSIC], (laughs), etc. — those aren't captionable words.
  const nonSpeech = /^[♪♫\s]+$|^[[(].*[\])]$/;
  return words
    .filter((w) => typeof w.text === "string" && w.text.trim() && !nonSpeech.test(w.text.trim()))
    .map((w) => ({ text: w.text.trim(), start: Number(w.start), end: Number(w.end) }));
}

/**
 * Group words into sentence-ish segments so Claude can reference clip
 * boundaries by index instead of guessing float timestamps.
 */
export function segmentWords(words, { maxWords = 28, pause = 0.7 } = {}) {
  const segments = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    segments.push({
      index: segments.length,
      start: current[0].start,
      end: current.at(-1).end,
      firstWord: current[0].i,
      lastWord: current.at(-1).i,
      text: current.map((w) => w.text).join(" "),
    });
    current = [];
  };
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (current.length && prev && w.start - prev.end >= pause) flush();
    current.push({ ...w, i });
    if (/[.?!]["')\]]?$/.test(w.text) || current.length >= maxWords) flush();
  });
  flush();
  return segments;
}
