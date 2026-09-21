// Sound library: music tracks for edits, kept in data/sounds/ with tempo and beats cached per track.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { FFPROBE, HYPERFRAMES, ROOT, run } from "./tools.js";
import { auditTrack } from "./audioaudit.js";

const FILE = path.join(ROOT, "data", "sounds.json");
export const SOUNDS_DIR = path.join(ROOT, "data", "sounds");
export const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|aiff?)$/i;

let db;
let writes = Promise.resolve();
const newId = () => `snd_${crypto.randomBytes(5).toString("hex")}`;

/** Duration of any audio file (lib/media.js probe() expects a video stream). */
async function audioDuration(file) {
  const out = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const seconds = Number(out.trim());
  return Number.isFinite(seconds) ? seconds : null;
}

async function load() {
  if (!db) {
    try {
      db = JSON.parse(await fs.readFile(FILE, "utf8"));
    } catch {
      db = { tracks: [] };
    }
    // Analysis can't resume across restarts; try again.
    for (const t of db.tracks) if (t.status === "analyzing") analyzeTrack(t);
    backfillVocals();
  }
  return db;
}

function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  writes = writes
    .then(async () => {
      await fs.mkdir(path.dirname(FILE), { recursive: true });
      const tmp = `${FILE}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(tmp, snapshot);
      await fs.rename(tmp, FILE);
    })
    .catch((err) => console.error("Saving the sound library failed:", err));
  return writes;
}

/**
 * Does anyone sing or talk on this track? Talking clips need a bed with no words over it, so every track gets a
 * quick pass of the local speech model (a second or two). Music-only tracks come back with nothing.
 */
async function detectVocals(track) {
  const workDir = path.join(os.tmpdir(), `sound-vocals-${track.id}`);
  try {
    await fs.mkdir(workDir, { recursive: true });
    await run(HYPERFRAMES, ["transcribe", path.join(SOUNDS_DIR, track.file), "-d", workDir, "--model", "tiny.en", "--json"], { cwd: ROOT });
    const words = JSON.parse(await fs.readFile(path.join(workDir, "transcript.json"), "utf8"));
    // Whisper writes ♪ and [Music] over instrumentals; those aren't words.
    const real = words.filter((w) => typeof w.text === "string" && /[a-z]{2}/i.test(w.text) && !/^[[(]/.test(w.text.trim()));
    Object.assign(track, { wordCount: real.length, hasWords: real.length >= 8 });
  } catch (err) {
    Object.assign(track, { wordCount: null, hasWords: null });
    console.error(`[sound ${track.id}] couldn't check for vocals:`, err.message.split("\n").pop());
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/** Sound quality under a voice: dull low-bitrate sources, clipping, channels out of phase (lib/audioaudit.js). */
async function checkQuality(track) {
  try {
    track.quality = await auditTrack(path.join(SOUNDS_DIR, track.file), { duration: track.duration });
  } catch (err) {
    track.quality = null;
    console.error(`[sound ${track.id}] couldn't check quality:`, err.message.split("\n").pop());
  }
}

// Tracks added before vocal detection or the quality check existed get checked once, in the background, one at
// a time.
let vocalBackfill = null;
function backfillVocals() {
  vocalBackfill ??= (async () => {
    for (const track of db.tracks) {
      if (track.status !== "ready") continue;
      if (track.hasWords === undefined) await detectVocals(track);
      if (track.quality === undefined) await checkQuality(track);
      await persist();
    }
  })().catch((err) => console.error("Sound check failed:", err.message));
}

/** Tempo + beat grid, via lib/beats.js. Tracks stay usable (without beat sync) if analysis fails. */
async function analyzeTrack(track) {
  track.status = "analyzing";
  try {
    const { detectBeats } = await import("./beats.js");
    const info = await detectBeats(path.join(SOUNDS_DIR, track.file));
    Object.assign(track, {
      status: "ready",
      duration: track.duration ?? info.duration ?? null,
      bpm: info.bpm ? Math.round(info.bpm) : null,
      beats: info.beats,
      strengths: info.strengths,
      downbeats: info.downbeats,
      error: null,
    });
  } catch (err) {
    Object.assign(track, { status: "ready", bpm: null, beats: null, error: `Beat detection unavailable: ${err.message.split("\n")[0]}` });
  }
  await persist();
  await detectVocals(track);
  await checkQuality(track);
  await persist();
}

const publicTrack = ({ beats, strengths, downbeats, ...track }) => ({ ...track, beatCount: beats?.length || 0 });

/**
 * A track with nothing sung or spoken over it — the bed a talking clip can sit on. Beds that failed the quality
 * check (too dull, or out of phase) are left out while there's anything better to use.
 */
export async function instrumentalTracks() {
  const beds = (await load()).tracks.filter((t) => t.status === "ready" && t.hasWords === false);
  const usable = beds.filter((t) => t.quality?.grade !== "poor");
  return (usable.length ? usable : beds).map(publicTrack);
}

export async function listTracks() {
  return (await load()).tracks.map(publicTrack);
}

export async function getTrack(id) {
  return (await load()).tracks.find((t) => t.id === id) || null;
}

/** Register an audio file already sitting in SOUNDS_DIR. */
export async function addTrack({ file, name, source = "upload" }) {
  await load();
  const track = {
    id: newId(),
    file,
    name: String(name || file).replace(AUDIO_EXT, "").slice(0, 120),
    duration: await audioDuration(path.join(SOUNDS_DIR, file)).catch(() => null),
    source,
    status: "analyzing",
    addedAt: new Date().toISOString(),
  };
  db.tracks.unshift(track);
  await persist();
  analyzeTrack(track);
  return publicTrack(track);
}

/** Copy every audio file from a folder (not recursive) into the library, skipping ones already imported. */
export async function importFolder(folder) {
  await load();
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const known = new Set(db.tracks.map((t) => t.originalPath).filter(Boolean));
  const added = [];
  await fs.mkdir(SOUNDS_DIR, { recursive: true });
  for (const entry of entries) {
    if (!entry.isFile() || !AUDIO_EXT.test(entry.name)) continue;
    const originalPath = path.join(folder, entry.name);
    if (known.has(originalPath)) continue;
    const file = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}${path.extname(entry.name).toLowerCase()}`;
    // Copy-on-write clone where the filesystem supports it, so big libraries don't double disk use.
    await fs.copyFile(originalPath, path.join(SOUNDS_DIR, file), fs.constants.COPYFILE_FICLONE);
    const track = await addTrack({ file, name: entry.name, source: "folder" });
    db.tracks.find((t) => t.id === track.id).originalPath = originalPath;
    added.push(track);
  }
  await persist();
  return added;
}

export async function renameTrack(id, name) {
  const track = await getTrack(id);
  if (!track) throw new Error("Track not found");
  const clean = String(name || "").trim().slice(0, 120);
  if (clean) track.name = clean;
  await persist();
  return publicTrack(track);
}

export async function removeTrack(id) {
  await load();
  const track = db.tracks.find((t) => t.id === id);
  if (!track) throw new Error("Track not found");
  db.tracks = db.tracks.filter((t) => t.id !== id);
  await persist();
  await fs.rm(path.join(SOUNDS_DIR, track.file), { force: true });
}
