// What's inside each source clip: moments with motion / exposure / color / loudness scores, plus
// labeled contact sheets so Claude can actually see the footage when it directs the edit.
import fs from "node:fs/promises";
import path from "node:path";
import { FFMPEG, FFPROBE, run } from "../lib/tools.js";
import { decodeAudio } from "./beats.js";

const LABEL_FONT = "/System/Library/Fonts/Helvetica.ttc";
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

export async function probeMedia(file) {
  // Full stream dump: this ffprobe build can't select side data entries, and rotation lives there on phone video.
  const out = await run(FFPROBE, ["-v", "error", "-show_format", "-show_streams", "-of", "json", file]);
  const info = JSON.parse(out);
  const duration = Number(info.format?.duration) || 0;
  const hasAudio = info.streams.some((s) => s.codec_type === "audio");
  const video = info.streams.find((s) => s.codec_type === "video" && s.width);
  if (!video) return { kind: "audio", duration, hasAudio };

  const rotation = Number(video.tags?.rotate ?? video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0);
  let { width, height } = video;
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  const rate = (s) => {
    const [num, den] = String(s || "0/0").split("/").map(Number);
    return den ? num / den : 0;
  };
  const fps = rate(video.avg_frame_rate) || rate(video.r_frame_rate) || 30;
  return { kind: "video", duration, width, height, fps: r2(fps), hasAudio, orientation: width > height * 1.1 ? "landscape" : height > width * 1.1 ? "portrait" : "square" };
}

/** Per-sample scene-change score, brightness and saturation. Long sources are scanned on keyframes only. */
async function scanFrames(file, duration, workDir, { onProgress, signal }) {
  const metaFile = path.join(workDir, "frames.txt");
  const rate = duration > 1200 ? 1 : duration > 300 ? 2 : 4;
  const args = ["-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1"];
  if (duration > 600) args.push("-skip_frame", "nokey");
  args.push("-i", file, "-an", "-sn", "-dn", "-vf", `fps=${rate},scale=192:-2,select='gte(scene,0)',signalstats,metadata=print:file=frames.txt`, "-f", "null", "-");
  await run(FFMPEG, args, {
    cwd: workDir,
    signal,
    onLine: (line) => {
      const m = line.match(/^out_time_us=(\d+)/);
      if (m && duration) onProgress?.(clamp01(Number(m[1]) / 1e6 / duration));
    },
  });

  const samples = [];
  let cur = null;
  for (const line of (await fs.readFile(metaFile, "utf8")).split("\n")) {
    const head = line.match(/pts_time:([\d.]+)/);
    if (head) {
      cur = { t: Number(head[1]), scene: 0, y: 0.5, sat: 0.3 };
      samples.push(cur);
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^lavfi\.(scene_score|signalstats\.YAVG|signalstats\.SATAVG)=([\d.]+)/);
    if (!kv) continue;
    const v = Number(kv[2]);
    if (kv[1] === "scene_score") cur.scene = v;
    else if (kv[1].endsWith("YAVG")) cur.y = v / 255;
    else cur.sat = clamp01(v / 110);
  }
  await fs.rm(metaFile, { force: true });
  return { samples, rate };
}

/** Loudness per half second, 0–1 relative to the loudest stretch. */
async function loudness(file, { signal }) {
  const rate = 4000;
  const pcm = await decodeAudio(file, { rate, signal });
  const hop = rate / 2;
  const out = [];
  for (let i = 0; i + hop <= pcm.length; i += hop) {
    let s = 0;
    for (let j = i; j < i + hop; j++) s += pcm[j] * pcm[j];
    out.push(Math.sqrt(s / hop));
  }
  const top = [...out].sort((a, b) => b - a)[Math.floor(out.length * 0.02)] || 1e-9;
  return out.map((v) => clamp01(v / top));
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Shots from scene-score spikes; long shots split into ~4 s moments so there's something to choose between. */
function buildMoments(samples, duration, loud, letter) {
  const cuts = [0];
  samples.forEach((s, i) => {
    const around = samples.slice(Math.max(0, i - 4), i + 5).map((x) => x.scene).sort((a, b) => a - b);
    const median = around[Math.floor(around.length / 2)] || 0;
    if (s.t > 0.3 && s.scene > 0.3 && s.scene > median * 2.5 && s.t - cuts.at(-1) >= 0.7) cuts.push(s.t);
  });
  const bounds = [...cuts, duration];

  const pieces = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const [a, b] = [bounds[k], bounds[k + 1]];
    if (b - a < 0.35) continue;
    const parts = Math.max(1, Math.round((b - a) / (b - a > 20 ? 5 : 4)));
    for (let p = 0; p < parts; p++) {
      pieces.push({ start: a + ((b - a) * p) / parts, end: a + ((b - a) * (p + 1)) / parts, cut: p === 0 && k > 0 });
    }
  }

  const moments = pieces.map((m, i) => {
    const inside = samples.filter((s) => s.t > m.start + 0.05 && s.t < m.end - 0.05);
    const motion = clamp01(mean(inside.map((s) => s.scene)) * 6);
    const bright = mean(inside.map((s) => s.y)) || 0.5;
    const sat = mean(inside.map((s) => s.sat)) || 0.3;
    const sound = loud.length ? mean(loud.slice(Math.floor(m.start * 2), Math.max(Math.floor(m.start * 2) + 1, Math.ceil(m.end * 2)))) : 0;
    const exposure = bright < 0.1 ? 0 : 1 - Math.abs(bright - 0.48) * 1.6;
    const score = clamp01(0.42 * motion + 0.28 * clamp01(exposure) + 0.18 * sat + 0.12 * sound);
    return {
      id: `${letter}${i + 1}`,
      start: r3(m.start),
      end: r3(m.end),
      cut: m.cut,
      motion: r2(motion),
      bright: r2(bright),
      sat: r2(sat),
      loud: r2(sound),
      score: r2(score),
    };
  });
  return { moments, cuts: cuts.length - 1 };
}

/** Evenly pick the strongest moments across the timeline (so sheets cover the whole source). */
function pickForSheets(moments, count) {
  if (moments.length <= count) return moments;
  const buckets = Array.from({ length: count }, () => []);
  moments.forEach((m, i) => buckets[Math.floor((i * count) / moments.length)].push(m));
  return buckets.map((b) => b.sort((x, y) => y.score - x.score)[0]).filter(Boolean);
}

/** Labeled contact sheets (one frame per chosen moment) for Claude's vision, plus a thumbnail per moment. */
async function contactSheets(file, source, picks, workDir, { maxSheets, signal }) {
  const portrait = source.height > source.width;
  const cell = portrait ? { w: 180, h: 320, cols: 8, rows: 3 } : source.width === source.height ? { w: 256, h: 256, cols: 6, rows: 4 } : { w: 320, h: 180, cols: 5, rows: 4 };
  const perSheet = cell.cols * cell.rows;
  const thumbsDir = path.join(workDir, "thumbs");
  await fs.mkdir(thumbsDir, { recursive: true });

  const chosen = picks.slice(0, perSheet * maxSheets);
  // Frame grabs are independent seeks, so run a few at once.
  let next = 0;
  const grab = async () => {
    while (next < chosen.length) {
      const m = chosen[next++];
      const at = Math.min(source.duration - 0.05, m.start + (m.end - m.start) * 0.45);
      await run(FFMPEG, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-ss", at.toFixed(3), "-i", file, "-frames:v", "1",
        "-vf", `scale=${cell.w}:${cell.h}:force_original_aspect_ratio=increase,crop=${cell.w}:${cell.h},drawtext=fontfile=${LABEL_FONT}:text='${m.id}  ${at.toFixed(1)}s':x=6:y=6:fontsize=${portrait ? 17 : 19}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=4`,
        "-q:v", "4",
        path.join(thumbsDir, `${m.id}.jpg`),
      ], { signal });
    }
  };
  await Promise.all([grab(), grab(), grab(), grab()]);

  const sheets = [];
  for (let s = 0; s * perSheet < chosen.length; s++) {
    const list = chosen.slice(s * perSheet, (s + 1) * perSheet);
    const listFile = path.join(workDir, `sheet-${s + 1}.txt`);
    await fs.writeFile(listFile, list.map((m) => `file 'thumbs/${m.id}.jpg'\nduration 1`).join("\n"));
    const name = `sheet-${s + 1}.jpg`;
    await run(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", path.basename(listFile),
      "-vf", `tile=${cell.cols}x${cell.rows}:padding=4:color=black`, "-frames:v", "1", "-q:v", "3", name,
    ], { cwd: workDir, signal });
    await fs.rm(listFile, { force: true });
    sheets.push({ file: name, moments: list.map((m) => m.id) });
  }
  return sheets;
}

/**
 * Analyze one source video into workDir (cached by file size + mtime).
 * @returns {{ kind, duration, width, height, fps, hasAudio, orientation, moments, sheets, cuts }}
 */
export async function analyzeSource(file, workDir, { letter, maxSheets = 2, onProgress, signal } = {}) {
  await fs.mkdir(workDir, { recursive: true });
  const stat = await fs.stat(file);
  const cacheFile = path.join(workDir, "analysis.json");
  const key = `${stat.size}:${stat.mtimeMs}:${letter}:${maxSheets}:v1`;
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    if (cached.key === key) return cached;
  } catch {
    // not analyzed yet
  }

  const info = await probeMedia(file);
  if (info.kind !== "video") throw new Error(`${path.basename(file)} has no video track.`);
  if (info.duration < 0.5) throw new Error(`${path.basename(file)} is too short to use.`);

  const [{ samples }, loud] = await Promise.all([
    scanFrames(file, info.duration, workDir, { onProgress: (p) => onProgress?.(p * 0.8), signal }),
    info.hasAudio ? loudness(file, { signal }).catch(() => []) : [],
  ]);
  const { moments, cuts } = buildMoments(samples, info.duration, loud, letter);
  const picks = pickForSheets(moments, (info.height > info.width ? 24 : 20) * maxSheets);
  onProgress?.(0.85);
  const sheets = await contactSheets(file, info, picks, workDir, { maxSheets, signal });
  onProgress?.(1);

  const result = { key, ...info, cuts, moments, sheets, analyzedAt: new Date().toISOString() };
  await fs.writeFile(cacheFile, JSON.stringify(result));
  return result;
}

/** Group transcript words into short spoken lines with timestamps. */
export function speechLines(words, { maxWords = 18, pause = 0.6 } = {}) {
  const lines = [];
  let cur = [];
  const flush = () => {
    if (cur.length) lines.push({ start: r3(cur[0].start), end: r3(cur.at(-1).end), text: cur.map((w) => w.text).join(" ") });
    cur = [];
  };
  words.forEach((w, i) => {
    if (cur.length && w.start - words[i - 1].end >= pause) flush();
    cur.push(w);
    if (/[.?!]$/.test(w.text) || cur.length >= maxWords) flush();
  });
  flush();
  return lines;
}
