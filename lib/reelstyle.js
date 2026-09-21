// Measures a studied reel's editing style: hard cuts and shot lengths, soft transitions, tone and color,
// letterboxing, plus a contact sheet to look at. Feeds the HyperFrames style engine (lib/hfstyles.js).
import { spawn } from "node:child_process";
import { FFMPEG, FFPROBE, toolEnv } from "./tools.js";

const r2 = (n) => Math.round(n * 100) / 100;
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

function capture(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: toolEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr.trim().split("\n").pop() || `${cmd} exited ${code}`))));
  });
}

const sceneTimes = (log) => [...log.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));

/**
 * @param file        local video
 * @param sheetPath   where to write a 24-frame contact sheet (jpg), or null
 * @returns { duration, width, height, cuts, cutsPerSec, avgShot, medianShot, softTransitions, luma, blacks, whites, contrast, saturation, warmth, letterbox }
 */
export async function measureReel(file, { sheetPath = null } = {}) {
  const info = JSON.parse(
    (await capture(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file])).stdout,
  );
  const duration = Number(info.format.duration) || 0;
  const { width, height } = info.streams[0] || {};
  if (!duration) throw new Error("Couldn't read this video.");

  const [hard, soft, stats, crop] = await Promise.all([
    capture(FFMPEG, ["-hide_banner", "-i", file, "-vf", "scale=360:-2,select='gt(scene,0.30)',showinfo", "-an", "-f", "null", "-"]),
    capture(FFMPEG, ["-hide_banner", "-i", file, "-vf", "scale=360:-2,select='between(scene,0.12,0.30)',showinfo", "-an", "-f", "null", "-"]),
    capture(FFMPEG, ["-hide_banner", "-i", file, "-vf", "fps=4,scale=320:-2,signalstats,metadata=print:file=-", "-an", "-f", "null", "-"]),
    capture(FFMPEG, ["-hide_banner", "-ss", String(duration * 0.4), "-i", file, "-t", "2", "-vf", "cropdetect=24:2:0", "-an", "-f", "null", "-"]),
  ]);
  if (sheetPath) {
    await capture(FFMPEG, ["-y", "-loglevel", "error", "-i", file, "-vf", `fps=${(24 / duration).toFixed(4)},scale=200:-2,tile=8x3:padding=4`, "-frames:v", "1", "-q:v", "4", sheetPath]);
  }

  const cuts = sceneTimes(hard.stderr).filter((t) => t > 0.15 && t < duration - 0.15);
  const bounds = [0, ...cuts, duration];
  const shots = bounds.slice(1).map((t, i) => t - bounds[i]).sort((a, b) => a - b);
  const grab = (key) => [...stats.stdout.matchAll(new RegExp(`lavfi\\.signalstats\\.${key}=([\\d.]+)`, "g"))].map((m) => Number(m[1]));
  const lastCrop = [...crop.stderr.matchAll(/crop=(\d+):(\d+):\d+:\d+/g)].pop();
  const blacks = avg(grab("YLOW"));
  const whites = avg(grab("YHIGH"));

  return {
    duration: r2(duration),
    width,
    height,
    cuts: cuts.length,
    cutsPerSec: r2(cuts.length / duration),
    avgShot: r2(avg(shots)),
    medianShot: r2(shots[Math.floor(shots.length / 2)]),
    softTransitions: sceneTimes(soft.stderr).length,
    luma: r2(avg(grab("YAVG"))),
    blacks: r2(blacks),
    whites: r2(whites),
    contrast: r2(whites - blacks),
    saturation: r2(avg(grab("SATAVG"))),
    warmth: r2(avg(grab("VAVG")) - avg(grab("UAVG"))), // > 0 warm/orange, < 0 cool/teal
    letterbox: lastCrop && (Number(lastCrop[1]) < width - 8 || Number(lastCrop[2]) < height - 8) ? { width: Number(lastCrop[1]), height: Number(lastCrop[2]) } : null,
  };
}

/** Plain-language read of the numbers, shown on the Study card. */
export function describeReel(m) {
  const pace = m.cutsPerSec >= 1.1 ? "Fast cuts" : m.cutsPerSec >= 0.5 ? "Steady cuts" : "Long, smooth shots";
  const tone = m.luma < 60 ? "dark & moody" : m.luma > 115 ? "bright" : "balanced exposure";
  const color = m.saturation < 5 ? "near black-and-white" : m.warmth > 6 ? "warm grade" : m.warmth < -3 ? "cool grade" : "neutral color";
  const punch = m.contrast > 140 ? "high contrast" : m.contrast < 80 ? "soft contrast" : null;
  return [pace, tone, color, punch, m.letterbox ? "letterboxed" : null].filter(Boolean);
}
