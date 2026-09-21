// Looks at a finished render the way a person would before posting it: is there picture, does it move, can you
// hear it, and is it as long as it was supposed to be. One ffmpeg pass, so it costs a few seconds at the end of
// a render and catches the silent failures — a black export, a frozen frame, a missing audio track.
import { FFMPEG, run } from "./tools.js";
import { probe } from "./media.js";

const BLACK_SEC = 1; // a second of black is a dead opening, not a fade
const FROZEN_SEC = 2;
const SILENT_SEC = 3;
const DEAD_DB = -45; // quieter than this across the whole file means there's no audio in it
// Loudness for social: the mix lands near -14 LUFS. True peak has to leave room for the platform's own encode,
// which pushes inter-sample peaks up; a loudness range past 12 LU means the level jumps around.
const LOUDNESS = { low: -17, high: -11 };
const TRUE_PEAK_MAX = -0.5;
const RANGE_MAX = 12;
const SWELL_LU = 6; // a 3-second stretch this much louder than the whole clip: something swells over the voice

/** Longest run reported by a detector that prints `<name>_start` / `<name>_duration` lines. */
function longestRun(lines, name) {
  const runs = lines.flatMap((line) => {
    const m = line.match(new RegExp(`${name}_duration\\s*[:=]\\s*([\\d.]+)`));
    return m ? [Number(m[1])] : [];
  });
  return runs.length ? Math.max(...runs) : 0;
}

/**
 * Check a rendered file. `expect` is the duration the plan asked for, in seconds.
 * @returns {{ ok, duration, problems: [{ level: "error"|"warning", text }], black, frozen, silence, peakDb }}
 */
export async function checkRender(file, { expect = null, signal, holdEnd = 0 } = {}) {
  const info = await probe(file);
  const hasAudio = Boolean(info.hasAudio);
  const lines = [];
  await run(
    FFMPEG,
    [
      "-v", "info", "-nostats", "-i", file,
      "-vf", "blackdetect=d=0.1:pic_th=0.98,freezedetect=n=-50dB:d=0.5",
      ...(hasAudio ? ["-af", "silencedetect=n=-48dB:d=2,volumedetect,ebur128=peak=true"] : ["-an"]),
      "-f", "null", "-",
    ],
    { signal, onLine: (line) => lines.push(line) },
  );

  const black = longestRun(lines, "black");
  // A held last frame under a music-only ending is on purpose: freezes that run into the end of a clip with one
  // don't count.
  const info0 = Number(info.duration) || 0;
  const freezes = [];
  let freezeAt = null;
  for (const line of lines) {
    const s = line.match(/freeze_start:\s*([\d.]+)/);
    const d = line.match(/freeze_duration:\s*([\d.]+)/);
    if (s) freezeAt = Number(s[1]);
    else if (d && freezeAt !== null) {
      freezes.push({ start: freezeAt, dur: Number(d[1]) });
      freezeAt = null;
    }
  }
  if (freezeAt !== null) freezes.push({ start: freezeAt, dur: info0 - freezeAt });
  const frozen = freezes
    .filter((f) => !(holdEnd > 0 && f.start >= info0 - holdEnd - 1.5))
    .reduce((max, f) => Math.max(max, f.dur), 0);
  const silence = longestRun(lines, "silence");
  const peak = lines.map((l) => l.match(/max_volume:\s*(-?[\d.]+) dB/)).find(Boolean);
  const peakDb = peak ? Number(peak[1]) : null;
  const duration = Number(info.duration) || 0;
  const loud = hasAudio ? loudnessFrom(lines) : null;

  const problems = [];
  const say = (level, text) => problems.push({ level, text });
  if (black >= BLACK_SEC) say("error", `${black.toFixed(1)}s of black picture`);
  if (frozen >= FROZEN_SEC) say("error", `${frozen.toFixed(1)}s frozen on one frame`);
  if (!hasAudio) say("error", "no audio track");
  else if (peakDb !== null && peakDb <= DEAD_DB) say("error", "silent the whole way through");
  else if (silence >= SILENT_SEC) say("warning", `${silence.toFixed(1)}s of silence`);
  if (loud?.truePeak !== null && loud?.truePeak !== undefined && loud.truePeak > TRUE_PEAK_MAX) {
    say("warning", `audio peaks at ${loud.truePeak.toFixed(1)} dBTP and may distort after upload`);
  } else if (peakDb !== null && peakDb >= -0.1) say("warning", "audio is clipping");
  if (loud?.integrated !== null && loud?.integrated !== undefined && peakDb > DEAD_DB) {
    if (loud.integrated < LOUDNESS.low) say("warning", `quiet at ${loud.integrated.toFixed(1)} LUFS (aim for -14)`);
    else if (loud.integrated > LOUDNESS.high) say("warning", `loud at ${loud.integrated.toFixed(1)} LUFS (aim for -14)`);
    if (loud.range > RANGE_MAX) say("warning", `level jumps around (${loud.range.toFixed(1)} LU range)`);
    if (loud.swell > SWELL_LU) say("warning", `a stretch gets ${loud.swell.toFixed(0)} LU louder than the rest`);
  }
  // The renderer drops or pads a frame here and there; a second off means the plan and the file disagree.
  if (expect && Math.abs(duration - expect) > Math.max(0.35, expect * 0.02)) {
    say("warning", `${duration.toFixed(1)}s long, expected ${expect.toFixed(1)}s`);
  }

  return { ok: !problems.some((p) => p.level === "error"), duration: Math.round(duration * 1000) / 1000, problems, black, frozen, silence, peakDb, loudness: loud };
}

/**
 * EBU R128 numbers from ffmpeg's ebur128 log: integrated loudness, loudness range, true peak, and how far the
 * loudest 3-second stretch (after the first 3 s) rises above the whole.
 */
function loudnessFrom(lines) {
  const num = (re) => {
    const hit = lines.map((l) => l.match(re)).filter(Boolean).at(-1);
    return hit ? Number(hit[1]) : null;
  };
  // The summary block comes last; the per-frame lines before it carry "S:" short-term readings.
  const integrated = num(/^\s*I:\s*(-?[\d.]+) LUFS/);
  const range = num(/^\s*LRA:\s*(-?[\d.]+) LU/);
  const truePeak = num(/^\s*Peak:\s*(-?[\d.]+|-inf) dBFS/);
  let loudest = -Infinity;
  for (const line of lines) {
    const m = line.match(/\bt:\s*([\d.]+).*?\bS:\s*(-?[\d.]+)/);
    if (m && Number(m[1]) >= 3) loudest = Math.max(loudest, Number(m[2]));
  }
  const swell = integrated !== null && Number.isFinite(loudest) ? Math.round((loudest - integrated) * 10) / 10 : null;
  return { integrated, range, truePeak: Number.isFinite(truePeak) ? truePeak : null, swell };
}

/** One line for the creator: what's wrong with this render, or nothing when it's clean. */
export function describeQa(qa) {
  if (!qa?.problems?.length) return null;
  const errors = qa.problems.filter((p) => p.level === "error");
  return `${errors.length ? "Check this render" : "Heads up"}: ${qa.problems.map((p) => p.text).join(", ")}`;
}
