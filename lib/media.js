import { FFMPEG, FFPROBE, run } from "./tools.js";

export async function probe(file) {
  const out = await run(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate,color_transfer",
    "-of", "json",
    file,
  ]);
  const info = JSON.parse(out);
  const video = info.streams.find((s) => s.codec_type === "video");
  if (!video) throw new Error("No video stream found in the uploaded file.");
  const [num, den] = (video.r_frame_rate || "30/1").split("/").map(Number);
  return {
    duration: Number(info.format.duration),
    width: video.width,
    height: video.height,
    fps: den ? num / den : 30,
    hasAudio: info.streams.some((s) => s.codec_type === "audio"),
    // iPhones record HDR (HLG) by default; without tone-mapping it plays washed out and grey in a normal video.
    hdr: ["arib-std-b67", "smpte2084"].includes(video.color_transfer),
  };
}

/** HDR (HLG or PQ) to normal SDR video, applied before scaling when the source is HDR. */
export const HDR_TO_SDR = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";

/**
 * Dialogue cleanup, podcast-voice chain. The creator heard the previous chain as "echoy and underwater": its
 * normalizer lifted the room's reverb in every gap between words, and it left a boomy, dull room mic that way.
 * This one cuts rumble and the boxy low-mids, brings back presence and air, denoises lightly (word loss is the
 * thing to avoid), compresses gently, levels to -14 LUFS, and only then eases the room down between words with a
 * soft gate (at most -8 dB, never muting) before a limiter holds the peaks.
 * Measured on a 30s podcast stretch against the previous chain: room sound between words 15 dB under the voice
 * (was 12, the raw recording 16), low-mid mud 0.9 dB over presence (was 3.5, raw 5.1), highs +3.5 dB, and a
 * speech-model pass hears every word (it transcribed this chain more accurately than the old one).
 */
export const AUDIO_CLEANUP = [
  "highpass=f=80",
  "afftdn=nr=8:nf=-50",
  "equalizer=f=200:t=q:w=1:g=-4",
  "equalizer=f=450:t=q:w=1:g=-2",
  "equalizer=f=3000:t=q:w=1.2:g=3.5",
  "highshelf=f=8000:g=4",
  "deesser=i=0.25:m=0.5:f=0.5",
  "acompressor=threshold=-18dB:ratio=2:attack=15:release=200:makeup=1:knee=6",
  "loudnorm=I=-14:TP=-2:LRA=11",
  "agate=threshold=0.15:ratio=2:range=0.4:attack=4:release=250:knee=4",
  "volume=1.6dB",
  "alimiter=limit=0.89:attack=3:release=60:level=false",
].join(",");
/** Bumped whenever AUDIO_CLEANUP changes, so existing working copies get their sound redone. */
export const AUDIO_CLEANUP_VERSION = 3;

/** Loudness every music bed is matched to before its level is applied, so each track sits the same under the voice. */
export const MUSIC_BED_LUFS = -14;

/** Copy a music track loudness-matched to MUSIC_BED_LUFS (AAC in .m4a). */
export async function normalizeMusicBed(src, dest, { signal } = {}) {
  await run(FFMPEG, ["-y", "-loglevel", "error", "-i", src, "-vn", "-af", `loudnorm=I=${MUSIC_BED_LUFS}:TP=-1.5:LRA=11`, "-ar", "48000", "-c:a", "aac", "-b:a", "192k", dest], { signal });
}

/** Redo a working copy's cleaned sound from the original without re-encoding its picture. */
export async function recleanWorkingAudio(src, work, dest, { signal } = {}) {
  await run(FFMPEG, ["-y", "-loglevel", "error", "-i", work, "-i", src, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-af", AUDIO_CLEANUP, "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", dest], { signal });
}

// The Mac's hardware H.264 encoder is ~2.5x faster than x264 for the same cut; x264 is the fallback elsewhere.
let hardwareEncoder = process.platform === "darwin";
const encoderArgs = (bitrate) =>
  hardwareEncoder ? ["-c:v", "h264_videotoolbox", "-b:v", bitrate, "-allow_sw", "1"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "16"];

async function encode(args, { signal, bitrate }) {
  const build = () => args.flatMap((a) => (a === "@encoder" ? encoderArgs(bitrate) : [a]));
  try {
    await run(FFMPEG, build(), { signal });
  } catch (err) {
    if (!hardwareEncoder || signal?.aborted || err.name === "AbortError") throw err;
    console.error("Hardware video encoder failed; using x264 from now on:", err.message.split("\n").pop());
    hardwareEncoder = false;
    await run(FFMPEG, build(), { signal });
  }
}

/**
 * Frame-accurate cut of [start, end] into a standalone H.264/AAC file.
 * Capped at 1920px tall — enough for a sharp 1080×1920 crop. Output is 30fps (the compositions' rate) unless
 * `keepFps` is set, which slow-motion shots need to stay smooth.
 * `audioSrc` takes the sound from another file on the same timeline (the cleaned working copy).
 */
export async function cutSegment(src, dest, start, end, { signal, audioSrc = null, keepFps = false, fadeEdges = false, fadeSec = 0.03, holdEnd = 0, hdr = false } = {}) {
  const at = start.toFixed(3);
  const dur = (end - start).toFixed(3);
  // `holdEnd` freezes the last frame for that many extra seconds (the music-only ending); the sound stops at `end`.
  const limit = holdEnd > 0 ? ["-t", dur] : [];
  // Pieces played back to back click where the waveform is chopped mid-cycle; a few ms of fade at each edge removes it.
  const fades = fadeEdges ? ["-af", `afade=t=in:d=${Math.max(0.015, fadeSec * 0.75).toFixed(3)},afade=t=out:st=${Math.max(0, end - start - fadeSec).toFixed(3)}:d=${fadeSec.toFixed(3)}`] : [];
  await encode(
    [
      "-y", "-loglevel", "error",
      "-ss", at, ...limit, "-i", src,
      ...(audioSrc ? ["-ss", at, ...limit, "-i", audioSrc] : []),
      "-t", (end - start + Math.max(0, holdEnd)).toFixed(3),
      "-map", "0:v:0", "-map", audioSrc ? "1:a:0?" : "0:a:0?",
      "-vf", `${hdr ? `${HDR_TO_SDR},` : ""}${keepFps ? "" : "fps=30,"}scale=-2:'min(1920,ih)'${holdEnd > 0 ? `,tpad=stop_mode=clone:stop_duration=${holdEnd.toFixed(3)}` : ""}`,
      "@encoder", "-pix_fmt", "yuv420p",
      ...fades,
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      dest,
    ],
    { signal, bitrate: "40M" },
  );
}

/**
 * A light working copy of the whole video: ≤1440p, 30fps, dense keyframes (fast seeking for previews and
 * analysis) and, when asked, cleaned-up dialogue audio. Final renders still cut picture from the original.
 * @param onProgress (fraction 0–1)
 */
export async function makeWorkingCopy(src, dest, { duration, height, hasAudio, cleanAudio, onProgress, signal, hdr = false } = {}) {
  let lastSent = 0;
  const onLine = (line) => {
    const m = /out_time_us=(\d+)/.exec(line);
    if (!m || !duration || !onProgress) return;
    const fraction = Math.min(1, Number(m[1]) / 1e6 / duration);
    if (fraction - lastSent >= 0.02) {
      lastSent = fraction;
      onProgress(fraction);
    }
  };
  const args = [
    "-y", "-loglevel", "error", "-progress", "pipe:1", "-nostats",
    "-i", src,
    "-map", "0:v:0", ...(hasAudio ? ["-map", "0:a:0"] : []),
    "-vf", `${hdr ? `${HDR_TO_SDR},` : ""}fps=30,scale=-2:'min(1440,ih)'`,
    "@encoder", "-g", "30", "-pix_fmt", "yuv420p",
    ...(hasAudio ? ["-af", cleanAudio ? AUDIO_CLEANUP : "anull", "-ar", "48000", "-c:a", "aac", "-b:a", "192k"] : []),
    "-movflags", "+faststart",
    dest,
  ];
  // Enough bitrate for sharp previews without ballooning: ~12 Mbps at 1440p, ~6 Mbps at 1080p and below.
  const bitrate = height && height <= 1080 ? "6M" : "12M";
  const build = () => args.flatMap((a) => (a === "@encoder" ? encoderArgs(bitrate) : [a]));
  try {
    await run(FFMPEG, build(), { signal, onLine });
  } catch (err) {
    if (!hardwareEncoder || signal?.aborted || err.name === "AbortError") throw err;
    hardwareEncoder = false;
    await run(FFMPEG, build(), { signal, onLine });
  }
}

export async function extractPoster(src, dest, at = 1) {
  await run(FFMPEG, ["-y", "-loglevel", "error", "-ss", String(at), "-i", src, "-frames:v", "1", "-vf", "scale=480:-2", dest]);
}
