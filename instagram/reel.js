// Instagram's Reels limits, checked before anything is uploaded.
// https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
import fs from "node:fs/promises";
import { probe } from "../lib/media.js";

export const LIMITS = { captionChars: 2200, hashtags: 30, mentions: 20, minSec: 3, maxSec: 15 * 60, maxBytes: 300 * 1024 * 1024, minFps: 23, maxFps: 60, maxWidth: 1920 };

export function checkCaption(caption) {
  const text = String(caption ?? "");
  const errors = [];
  if (text.length > LIMITS.captionChars) errors.push(`The caption is ${text.length} characters. Instagram allows ${LIMITS.captionChars}, hashtags included.`);
  const hashtags = (text.match(/#[\p{L}\p{N}_]+/gu) || []).length;
  if (hashtags > LIMITS.hashtags) errors.push(`The caption has ${hashtags} hashtags. Instagram allows ${LIMITS.hashtags}.`);
  const mentions = (text.match(/(?:^|[^\w@])@[\w.]+/g) || []).length;
  if (mentions > LIMITS.mentions) errors.push(`The caption has ${mentions} @mentions. Instagram allows ${LIMITS.mentions}.`);
  return errors;
}

/** → { ok, errors, warnings, media }. Errors block publishing; warnings are things Instagram may crop or reject. */
export async function checkReel({ caption, videoPath, probeVideo = probe }) {
  const errors = checkCaption(caption);
  const warnings = [];
  let media = null;

  const stat = videoPath ? await fs.stat(videoPath).catch(() => null) : null;
  if (!stat?.isFile()) {
    errors.push("The video file is missing.");
  } else if (!/\.(mp4|mov)$/i.test(videoPath)) {
    errors.push("Instagram Reels need an MP4 or MOV file.");
  } else {
    if (stat.size > LIMITS.maxBytes) errors.push(`The video is ${Math.round(stat.size / 1e6)} MB. Instagram allows up to 300 MB.`);
    const info = await probeVideo(videoPath).catch(() => null);
    if (!info) {
      errors.push("Couldn't read the video file.");
    } else {
      media = { sizeBytes: stat.size, durationSec: +info.duration.toFixed(2), width: info.width, height: info.height, fps: +info.fps.toFixed(2), hasAudio: info.hasAudio };
      if (!(info.duration >= LIMITS.minSec)) errors.push("Reels must be at least 3 seconds long.");
      if (info.duration > LIMITS.maxSec) errors.push("Reels can be at most 15 minutes long.");
      if (info.width && info.height && Math.abs(info.width / info.height - 9 / 16) > 0.02) {
        warnings.push(`The video is ${info.width}×${info.height}. Reels look best at 9:16 (1080×1920); other shapes get cropped or letterboxed.`);
      }
      if (info.width > LIMITS.maxWidth) warnings.push(`The video is ${info.width} px wide. Instagram's limit is ${LIMITS.maxWidth} px, so it may be rejected.`);
      if (info.fps < LIMITS.minFps || info.fps > LIMITS.maxFps) warnings.push(`The video runs at ${Math.round(info.fps)} fps. Instagram expects ${LIMITS.minFps}–${LIMITS.maxFps} fps.`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, media };
}
