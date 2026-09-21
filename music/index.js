// Music Channel: whenever the creator studies a video, offer to keep its sound. Saved sounds go into the
// shared sound library (lib/sounds.js), so any clip or edit can reuse them. Owned by the MUSIC session.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { FFMPEG, FFPROBE, ROOT, run } from "../lib/tools.js";
import { ytDlpPath } from "../lib/youtube.js";
import { STUDY_MEDIA_DIR, getStudy } from "../lib/study.js";
import { SOUNDS_DIR, addTrack, getTrack, listTracks } from "../lib/sounds.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(ROOT, "data", "music");
const FILE = path.join(DATA_DIR, "channel.json");
const TMP_DIR = path.join(DATA_DIR, "tmp");

const now = () => new Date().toISOString();
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// data/music/channel.json
//   references: { [refId]: { status: "saving" | "saved" | "skipped" | "error", soundId?, error?, decidedAt } }
//   sounds:     { [trackId]: where a saved sound came from (link, uploader, track/artist, trim) }
// A studied video with no entry in `references` still gets asked.

let db;
let writes = Promise.resolve();
const inFlight = new Map();

async function load() {
  if (!db) {
    let data = {};
    try {
      data = JSON.parse(await fs.readFile(FILE, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // a hand-edit broke the JSON — never overwrite it
    }
    db = { references: data.references || {}, sounds: data.sounds || {} };
    // A save can't resume across restarts; let the creator retry it.
    for (const d of Object.values(db.references)) {
      if (d.status === "saving") Object.assign(d, { status: "error", error: "Interrupted when the server restarted." });
    }
  }
  return db;
}

function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  writes = writes
    .then(async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${FILE}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(tmp, snapshot);
      await fs.rename(tmp, FILE);
    })
    .catch((err) => console.error("Saving the Music Channel failed:", err));
  return writes;
}

/** The line of a tool failure worth showing: yt-dlp's ERROR line, else the first line of output. */
function readable(err) {
  const lines = String(err.message).split("\n").map(clean).filter(Boolean);
  const line = lines.find((l) => l.startsWith("ERROR:")) || lines[1] || lines[0] || "Something went wrong.";
  return line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, "").slice(0, 200);
}

// ---------------------------------------------------------------------------
// Pulling the audio out

/** Download a link's best audio (or the whole video, for sites without an audio-only format) into `dir`. */
async function downloadAudio(url, dir) {
  const bin = ytDlpPath();
  if (!bin) throw new Error("Saving sounds from links needs yt-dlp. Install it with: brew install yt-dlp");
  await fs.mkdir(dir, { recursive: true });
  const out = await run(bin, [
    "--no-playlist", "--no-warnings", "--no-progress",
    "-f", "ba[ext=m4a]/ba/b",
    "-o", path.join(dir, "audio.%(ext)s"),
    "--dump-single-json", "--no-simulate",
    url,
  ]);
  const file = (await fs.readdir(dir)).find((name) => name.startsWith("audio.") && !/\.(part|ytdl)$/.test(name));
  if (!file) throw new Error("The download finished, but no audio came out of it.");
  let info = {};
  try {
    info = JSON.parse(out);
  } catch {
    // metadata is a nice-to-have
  }
  return { src: path.join(dir, file), info };
}

/** Re-encode the first audio stream of any media file to AAC in the sound library, optionally trimmed. */
async function encodeSound(src, { start, end }) {
  const file = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}.m4a`;
  const dest = path.join(SOUNDS_DIR, file);
  const args = ["-y", "-loglevel", "error"];
  if (start > 0) args.push("-ss", start.toFixed(3));
  args.push("-i", src);
  if (end !== null) args.push("-t", (end - start).toFixed(3));
  args.push("-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", dest);
  await fs.mkdir(SOUNDS_DIR, { recursive: true });
  try {
    await run(FFMPEG, args);
  } catch (err) {
    await fs.rm(dest, { force: true });
    if (/matches no streams/i.test(err.message)) throw new Error("This video has no sound to save.");
    throw err;
  }
  return file;
}

async function audioDuration(file) {
  const out = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const sec = Number(out.trim());
  return Number.isFinite(sec) ? +sec.toFixed(2) : null;
}

/** "Song — Artist" when the site knows the track (TikTok, Reels, YouTube Music), else the video's title. */
function defaultName(reference, info) {
  const track = clean(info.track);
  const artist = clean(info.artist || info.creator);
  if (track) return artist && !track.toLowerCase().includes(artist.toLowerCase()) ? `${track} — ${artist}` : track;
  return clean(reference.info?.title) || "Saved sound";
}

async function extract(reference, { name, start, end }) {
  const scratch = path.join(TMP_DIR, reference.id);
  try {
    let src;
    let info = {};
    if (reference.kind === "file") src = path.join(STUDY_MEDIA_DIR, reference.file);
    else ({ src, info } = await downloadAudio(reference.url, scratch));

    const file = await encodeSound(src, { start, end });
    const ref = reference.info || {};
    return {
      file,
      name: clean(name).slice(0, 120) || defaultName(reference, info),
      meta: {
        refId: reference.id,
        profileId: reference.profileId,
        url: reference.url || null,
        title: ref.title || "",
        uploader: ref.uploader || clean(info.uploader),
        platform: ref.platform || clean(info.extractor_key),
        thumbnail: ref.thumbnail || null,
        track: clean(info.track) || null,
        artist: clean(info.artist || info.creator) || null,
        start,
        end,
        duration: await audioDuration(path.join(SOUNDS_DIR, file)).catch(() => null),
        savedAt: now(),
      },
    };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Channel

/**
 * @param loadStudy  resolves to { profiles, references } — lib/study.js by default; the dev server reads data/study.json.
 */
export function createMusicChannel({ loadStudy = getStudy } = {}) {
  async function findReference(id) {
    const reference = (await loadStudy()).references.find((r) => r.id === id);
    if (!reference) throw Object.assign(new Error("That studied video is gone."), { status: 404 });
    return reference;
  }

  /** What the Study prompt shows per reference: ask, waiting (link still loading), unavailable, or the decision. */
  async function referenceStates(references) {
    await load();
    const out = {};
    for (const r of references) {
      const decision = db.references[r.id];
      let state;
      if (decision) state = { ...decision };
      else if (r.kind === "link" && r.status !== "ready") state = { status: r.status === "error" ? "unavailable" : "waiting" };
      else state = { status: "ask" };

      if (state.status === "saved") {
        const track = await getTrack(state.soundId);
        // Deleted from the Sounds library: don't nag about it again.
        state = track ? { ...state, sound: { id: track.id, name: track.name } } : { status: "skipped" };
      }
      out[r.id] = state;
    }
    return out;
  }

  /** Every library track, with where it came from when it was saved from a studied video. */
  async function listSounds(base) {
    await load();
    return (await listTracks()).map((t) => {
      const study = db.sounds[t.id] || null;
      return { ...t, duration: t.duration ?? study?.duration ?? null, audioUrl: `${base}/sounds/${t.id}/audio`, study };
    });
  }

  /** The Music Channel section: studied videos still waiting on a decision, and sounds saved from studies. */
  async function channel(base) {
    const { profiles = [], references } = await loadStudy();
    const states = await referenceStates(references);
    const names = new Map(profiles.map((p) => [p.id, p.name]));
    const pending = references
      .filter((r) => ["ask", "saving", "error"].includes(states[r.id].status))
      .map((r) => ({
        ...states[r.id],
        refId: r.id,
        kind: r.kind,
        profile: names.get(r.profileId) || "",
        url: r.url || null,
        title: r.info?.title || r.url || "Uploaded clip",
        uploader: r.info?.uploader || "",
        platform: r.info?.platform || "",
        thumbnail: r.info?.thumbnail || null,
        duration: r.info?.duration ?? null,
      }));
    const saved = (await listSounds(base)).filter((s) => s.study);
    return { pending, saved, references: states };
  }

  /** Start pulling a studied video's sound into the library. Resolves right away with { status: "saving" }. */
  async function saveSound(refId, { name, start, end } = {}) {
    await load();
    const reference = await findReference(refId);
    if (inFlight.has(refId)) return db.references[refId];
    const existing = db.references[refId];
    if (existing?.status === "saved" && (await getTrack(existing.soundId))) return existing;
    if (reference.kind === "link" && reference.status !== "ready") {
      throw new Error(reference.status === "fetching" ? "Still reading that link — try again in a moment." : "Couldn't read that link, so there's no sound to save.");
    }

    const from = Number.isFinite(Number(start)) ? Math.max(0, Number(start)) : 0;
    const to = end === undefined || end === null || end === "" ? null : Number(end);
    if (to !== null && !(Number.isFinite(to) && to - from >= 1)) throw new Error("A sound needs to be at least 1 second long.");

    const decision = { status: "saving", decidedAt: now() };
    db.references[refId] = decision;
    await persist();

    const job = extract(reference, { name, start: from, end: to })
      .then(async ({ file, name: soundName, meta }) => {
        const track = await addTrack({ file, name: soundName, source: "study" });
        db.sounds[track.id] = meta;
        Object.assign(decision, { status: "saved", soundId: track.id, error: null });
      })
      .catch((err) => {
        console.error(`[music] saving the sound of ${refId} failed:`, err);
        Object.assign(decision, { status: "error", error: readable(err) });
      })
      .finally(() => {
        inFlight.delete(refId);
        return persist();
      });
    inFlight.set(refId, job);
    return decision;
  }

  async function skip(refId) {
    await load();
    await findReference(refId);
    if (inFlight.has(refId)) throw new Error("This sound is already saving.");
    if (db.references[refId]?.status === "saved") return db.references[refId];
    db.references[refId] = { status: "skipped", decidedAt: now() };
    await persist();
    return db.references[refId];
  }

  /** Forget a skip or failure so the prompt asks again. */
  async function askAgain(refId) {
    await load();
    const decision = db.references[refId];
    if (decision?.status === "saving" || decision?.status === "saved") return decision;
    delete db.references[refId];
    await persist();
    return { status: "ask" };
  }

  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  };

  const router = express.Router();
  router.use(express.json());
  router.use("/ui", express.static(path.join(HERE, "public")));
  router.get("/channel", (_req, res) => res.sendFile(path.join(HERE, "public", "channel.html")));

  router.get("/", handle((req) => channel(req.baseUrl)));
  router.get("/references", handle(async () => referenceStates((await loadStudy()).references)));
  router.post("/references/:refId/save", handle((req, res) => {
    res.status(202);
    return saveSound(req.params.refId, req.body || {});
  }));
  router.post("/references/:refId/skip", handle((req) => skip(req.params.refId)));
  router.delete("/references/:refId", handle((req) => askAgain(req.params.refId)));

  router.get("/sounds", handle((req) => listSounds(req.baseUrl)));
  router.get("/sounds/:id/audio", async (req, res) => {
    const track = await getTrack(req.params.id);
    if (!track) return res.status(404).type("text").send("Sound not found");
    res.sendFile(path.join(SOUNDS_DIR, track.file));
  });

  return { router, saveSound };
}

export const { router, saveSound } = createMusicChannel();
