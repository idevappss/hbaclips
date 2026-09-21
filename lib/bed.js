// The music under a talking clip, mixed into one finished file before the render. Playing a short song several
// times inside the composition broke in two ways the creator heard: every repeat after the first came in at full
// volume (as loud as the voice), and a song that opens on silence dropped out at each restart. Baking the loop,
// the level and the ending into a single file means the composition just plays it.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { FFMPEG, FFPROBE, run } from "./tools.js";
import { MUSIC_BED_LUFS } from "./media.js";

const CROSSFADE = 1.5;
const FADE_IN = 0.6;
const FADE_OUT = 0.9;

async function durationOf(file, signal) {
  const out = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { signal });
  return Number(out.trim()) || 0;
}

/**
 * @param src       the library track
 * @param dest      .m4a to write
 * @param duration  the clip's full length, ending included
 * @param level     the bed under speech (musicLevel, e.g. 0.13)
 * @param tail      the music-only ending, or null: { at (s), ramp (s), level } — the song stays at `level` until
 *                  `at`, then comes up to `tail.level`
 */
export async function mixMusicBed(src, dest, { duration, level, tail = null, signal } = {}) {
  const D = Math.max(1, Number(duration) || 1);
  const tmp = path.join(os.tmpdir(), `bed-${crypto.randomBytes(4).toString("hex")}.wav`);
  try {
    // 1) The song without its silent opening, matched to the same loudness as every other bed.
    await run(FFMPEG, [
      "-y", "-loglevel", "error", "-i", src, "-vn",
      // Leveled flat first: a song's quiet intro and loud drop would otherwise sound like the bed fading in and
      // out under the voice. A slow normalizer evens its sections, a gentle compressor holds the peaks, then it's
      // matched to the same loudness as every other bed.
      "-af", `silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,dynaudnorm=f=150:g=11:p=0.9:m=40,acompressor=threshold=-26dB:ratio=6:attack=20:release=200:makeup=3,loudnorm=I=${MUSIC_BED_LUFS}:TP=-1.5:LRA=4`,
      "-ar", "48000", "-ac", "2", tmp,
    ], { signal });
    const len = await durationOf(tmp, signal);
    if (len < 2) throw new Error("This music track is too short to use as a bed.");

    // 2) Enough copies to cover the clip, each flowing into the next with a crossfade instead of a restart.
    const copies = len >= D ? 1 : Math.min(12, Math.ceil((D - CROSSFADE) / Math.max(0.5, len - CROSSFADE)) + 1);
    const inputs = Array.from({ length: copies }, () => ["-i", tmp]).flat();
    let graph = "";
    let last = "[0:a]";
    for (let i = 1; i < copies; i++) {
      graph += `${last}[${i}:a]acrossfade=d=${Math.min(CROSSFADE, len / 3).toFixed(2)}:c1=tri:c2=tri[x${i}];`;
      last = `[x${i}]`;
    }

    // 3) The level: flat under the talking, up to the ending's level once the words are done, faded at both edges.
    const L = level;
    const volume = tail
      ? `if(lt(t,${tail.at}),${L},if(lt(t,${tail.at + tail.ramp}),${L}+(${tail.level}-${L})*(0.5-0.5*cos(PI*(t-${tail.at})/${tail.ramp})),${tail.level}))`
      : `${L}`;
    graph += `${last}atrim=0:${D.toFixed(3)},asetpts=PTS-STARTPTS,volume='${volume}':eval=frame,afade=t=in:d=${FADE_IN},afade=t=out:st=${Math.max(0, D - FADE_OUT).toFixed(3)}:d=${FADE_OUT}[bed]`;

    await run(FFMPEG, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", graph, "-map", "[bed]", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", dest], { signal });
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
