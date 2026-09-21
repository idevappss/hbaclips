// The last touch on a finished render: its whole mix (voice, music, everything) measured and set to -14 LUFS with
// peaks under -1 dBTP, the way the platforms play it back. The voice chain already aims there, but mixing the bed
// in and the renderer's own audio path can move it. Only the sound is redone; the picture is copied untouched.
import fs from "node:fs/promises";
import { FFMPEG, run } from "./tools.js";

const TARGET = -14;
const TOLERANCE = 1; // within 1 LU of the target, leave it alone

async function measure(file, signal) {
  const lines = [];
  await run(FFMPEG, ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"], { signal, onLine: (l) => lines.push(l) });
  const text = lines.join("\n");
  const json = text.slice(text.lastIndexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Bring a rendered file's mix to -14 LUFS / -1 dBTP when it's off by more than 1 LU, with a measured (two-pass,
 * linear) normalization so the voice-to-music balance stays exactly as mixed.
 * @returns {{ before, after, changed }}
 */
export async function masterLoudness(file, { signal } = {}) {
  const m = await measure(file, signal);
  const before = m ? Number(m.input_i) : null;
  // Close enough on loudness and peaks already under -1 dBTP: leave it alone.
  if (!Number.isFinite(before) || before < -60 || (Math.abs(before - TARGET) <= TOLERANCE && Number(m.input_tp) <= -1)) return { before, after: before, changed: false };
  const tmp = `${file}.master.mp4`;
  const filter = `loudnorm=I=${TARGET}:TP=-1:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  try {
    await run(FFMPEG, ["-y", "-loglevel", "error", "-i", file, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-af", filter, "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", tmp], { signal });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  const after = Number((await measure(file, signal))?.input_i);
  return { before, after: Number.isFinite(after) ? after : null, changed: true };
}
