// Planning "Dope edits": scan a video for its best-looking moments, fit them to a track's beat grid
// (or an even rhythm without music), and store the plan on the project for preview and rendering.
import fs from "node:fs/promises";
import path from "node:path";
import { projectDir, saveProject } from "./store.js";
import { normalizeEditDesign } from "./edit.js";
import { getTrack } from "./sounds.js";
import { FFMPEG, run } from "./tools.js";

/** Seconds per shot when there's no beat grid to cut to. */
const SHOT_SECONDS = { hype: 1.1, cinematic: 2.4, smooth: 2 };
const MIN_SHOT = { hype: 0.8, cinematic: 1.6, smooth: 1.4 };

function throttled(fn, ms = 800) {
  let lastAt = 0;
  return (...args) => {
    const now = Date.now();
    if (now - lastAt >= ms) {
      lastAt = now;
      fn(...args);
    }
  };
}

/** Moments are expensive to find on long videos, so each project scans once and caches the result (per source file version). */
export async function loadMoments(project, onProgress) {
  const src = path.join(projectDir(project.id), project.source.file);
  const cache = path.join(projectDir(project.id), "moments.json");
  const { size, mtimeMs } = await fs.stat(src);
  const key = `${project.source.file}:${size}:${Math.round(mtimeMs)}`;
  try {
    const cached = JSON.parse(await fs.readFile(cache, "utf8"));
    if (cached.key === key) return cached.moments;
  } catch {
    // not scanned yet
  }
  const { scanMoments } = await import("./visual.js");
  const scan = await scanMoments(src, { onProgress });
  const moments = scan.moments.slice(0, 500);
  await fs.writeFile(cache, JSON.stringify({ key, moments }));
  return moments;
}

/** Timeline cut points: on the track's beats when we have them, otherwise an even rhythm for the vibe. */
async function planCuts(track, length, vibe) {
  if (track?.beats?.length) {
    const { cutGrid } = await import("./beats.js");
    const cuts = cutGrid(
      { bpm: track.bpm, beats: track.beats, strengths: track.strengths, downbeats: track.downbeats, duration: track.duration },
      { targetSec: length, minShot: MIN_SHOT[vibe] },
    ).filter((t) => t < length - 0.3);
    if (cuts.length) return cuts[0] === 0 ? cuts : [0, ...cuts];
  }
  const step = SHOT_SECONDS[vibe];
  return Array.from({ length: Math.max(1, Math.floor(length / step)) }, (_, i) => Math.round(i * step * 1000) / 1000);
}

/**
 * Start building an edit in the background. Returns the edit record right away (status "scanning");
 * it becomes "ready" (with shots/cuts/beats) or "error" on the project.
 */
export async function createEdit(project, { design: input, trackId } = {}) {
  // The footage scanner is a separate module; fail with a clear message if it can't load.
  try {
    await import("./visual.js");
    await import("./beats.js");
  } catch {
    throw new Error("Dope edits are still being installed — try again in a few minutes.");
  }
  const design = normalizeEditDesign(input);
  const edit = {
    id: `edit-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    status: "scanning",
    message: "Finding the best-looking moments…",
    design,
    trackId: trackId || null,
  };
  project.edits = [edit, ...(project.edits || [])];
  await saveProject(project);
  planEdit(project, edit).catch((err) => console.error(`[${project.id}/${edit.id}]`, err));
  return edit;
}

async function planEdit(project, edit) {
  // The edit lives inside project.edits, so progress is saved by saving the project.
  const set = (patch) => {
    Object.assign(edit, patch);
    return saveProject(project);
  };
  try {
    const seconds = Number(project.source.duration) || 0;
    if (seconds < 4) {
      throw new Error(`This video is only ${Math.round(seconds * 10) / 10}s long. Dope edits need a few seconds of footage to pick moments from — try a longer video.`);
    }
    const moments = await loadMoments(project, throttled((f) => set({ message: `Scanning the footage… ${Math.round(f * 100)}%` })));
    const track = edit.trackId ? await getTrack(edit.trackId) : null;
    if (edit.trackId && !track) throw new Error("That music track is no longer in your sound library.");

    const sourceDuration = project.source.duration;
    const length = Math.max(5, Math.min(edit.design.length, track?.duration ? Math.floor(track.duration) : Infinity, Math.floor(sourceDuration)));
    let cuts = await planCuts(track, length, edit.design.vibe);
    const longest = Math.max(...cuts.map((t, i) => (cuts[i + 1] ?? length) - t));

    const { pickShots } = await import("./visual.js");
    const picked = pickShots(moments, {
      targetSec: length * 1.6,
      shotMin: MIN_SHOT[edit.design.vibe] * 0.8,
      shotMax: Math.max(3, longest + 0.5),
      minGapSec: Math.max(0.5, Math.min(4, sourceDuration / (cuts.length * 2.5))),
    });
    // The strongest shot for every cut, back in story order. Shots too close to the end of the video to fill
    // the longest slot are skipped rather than shifted, which could drag them across a scene cut.
    const shots = [...picked]
      .filter((s) => s.start <= sourceDuration - longest - 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, cuts.length)
      .sort((a, b) => a.start - b.start);
    if (!shots.length) throw new Error("Couldn't find usable moments in this video.");
    cuts = cuts.slice(0, shots.length);

    const beats = (track?.beats || []).map((t, i) => ({ t, strength: track.strengths?.[i] ?? 0.5 })).filter((b) => b.t < length);
    await set({ message: "Preparing the preview…" });
    const proxy = await buildProxy(project, edit.id, shots, cuts, length);
    await set({
      status: "ready",
      message: `${shots.length} shots · ${length}s${track ? ` · ${track.name}` : " · original sound"}`,
      shots,
      cuts,
      duration: length,
      beats,
      proxy,
      error: null,
    });
  } catch (err) {
    await set({ status: "error", message: "Couldn't build this edit", error: err.message });
  }
}

/**
 * One small 720p file with every shot back to back, so the live preview plays a single light video
 * instead of seeking the full-size source for each shot. Each shot gets its full slot length
 * (enough for any vibe) and `offsets[i]` is where shot i starts inside the file.
 */
async function buildProxy(project, editId, shots, cuts, length) {
  const dir = path.join(projectDir(project.id), "edits", editId);
  await fs.mkdir(dir, { recursive: true });
  const src = path.join(projectDir(project.id), project.source.file);
  const spans = shots.map((s, i) => Math.max(0.3, (cuts[i + 1] ?? length) - cuts[i]) + 0.1);
  const offsets = [];
  let at = 0;
  for (const span of spans) {
    offsets.push(Math.round(at * 1000) / 1000);
    at += span;
  }

  const inputs = shots.flatMap((s, i) => ["-ss", s.start.toFixed(3), "-t", spans[i].toFixed(3), "-i", src]);
  const withAudio = Boolean(project.source.hasAudio);
  const chains = shots.map(
    (_, i) =>
      `[${i}:v]scale=-2:720,setsar=1,fps=30,format=yuv420p[v${i}]` + (withAudio ? `;[${i}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]` : ""),
  );
  const concatInputs = shots.map((_, i) => `[v${i}]${withAudio ? `[a${i}]` : ""}`).join("");
  const filter = `${chains.join(";")};${concatInputs}concat=n=${shots.length}:v=1:a=${withAudio ? 1 : 0}[v]${withAudio ? "[a]" : ""}`;

  await run(FFMPEG, [
    "-y", "-loglevel", "error",
    ...inputs,
    "-filter_complex", filter,
    "-map", "[v]", ...(withAudio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "128k"] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
    "-movflags", "+faststart",
    path.join(dir, "proxy.mp4"),
  ]);
  return { file: `edits/${editId}/proxy.mp4`, offsets };
}
