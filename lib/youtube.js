// Video links (YouTube and anything else yt-dlp supports): metadata and downloads.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { run, toolEnv } from "./tools.js";

const CANDIDATES = [process.env.YTDLP_PATH, "/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"];

export const isLink = (value) => /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(String(value || "").trim());

export function ytDlpPath() {
  for (const candidate of CANDIDATES) if (candidate && fs.existsSync(candidate)) return candidate;
  try {
    return execFileSync("which", ["yt-dlp"], { env: toolEnv, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function requireYtDlp() {
  const bin = ytDlpPath();
  if (!bin) throw new Error("Video links need yt-dlp. Install it with: brew install yt-dlp");
  return bin;
}

/** Title, channel, duration and thumbnail for a link, without downloading the video. */
export async function fetchInfo(url, { signal } = {}) {
  const out = await run(requireYtDlp(), ["--dump-single-json", "--no-playlist", "--no-warnings", url], { signal });
  const info = JSON.parse(out);
  return {
    id: info.id,
    title: info.title || url,
    uploader: info.uploader || info.channel || "",
    duration: info.duration || null,
    thumbnail: info.thumbnail || null,
    description: String(info.description || "").slice(0, 2000),
    viewCount: info.view_count ?? null,
    likeCount: info.like_count ?? null,
    platform: info.extractor_key || "",
    url: info.webpage_url || url,
  };
}

/**
 * Download a link's video (≤ maxHeight, merged to MP4) into destDir as source.<ext>.
 * @returns the file name inside destDir
 */
export async function downloadVideo(url, destDir, { signal, onProgress, maxHeight = 1080 } = {}) {
  const format = `bv*[height<=${maxHeight}][ext=mp4]+ba[ext=m4a]/b[height<=${maxHeight}][ext=mp4]/bv*[height<=${maxHeight}]+ba/b`;
  await run(
    requireYtDlp(),
    ["--no-playlist", "--no-warnings", "--newline", "-f", format, "--merge-output-format", "mp4", "-o", path.join(destDir, "source.%(ext)s"), url],
    {
      signal,
      onLine: (line) => {
        const match = line.match(/\[download\]\s+([\d.]+)%/);
        if (match) onProgress?.(Math.floor(Number(match[1])));
      },
    },
  );
  const file = fs.readdirSync(destDir).find((name) => /^source\.(mp4|mkv|webm|mov)$/i.test(name));
  if (!file) throw new Error("The download finished, but no video file came out of it.");
  return file;
}
