// Study: videos the creator admires, what they like about each, grouped into taste profiles
// (theirs, a friend's, a client's). Persisted to data/study.json; media under data/study/.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT } from "./tools.js";
import { downloadVideo, fetchInfo } from "./youtube.js";
import { describeReel, measureReel } from "./reelstyle.js";

const FILE = path.join(ROOT, "data", "study.json");
export const STUDY_MEDIA_DIR = path.join(ROOT, "data", "study");

/** What a creator can say they like about a reference. */
export const LIKE_TAGS = [
  "Hook",
  "Pacing & cuts",
  "Captions",
  "Music & sound",
  "Transitions & effects",
  "Color & look",
  "Storytelling",
  "Title & thumbnail",
  "Energy",
  "Humor",
];

let db;
let writes = Promise.resolve();
const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
const now = () => new Date().toISOString();

async function load() {
  if (!db) {
    try {
      db = JSON.parse(await fs.readFile(FILE, "utf8"));
    } catch {
      db = { profiles: [], references: [], activeProfileId: null };
    }
    if (!db.profiles.length) {
      const me = { id: newId("prof"), name: "Me", createdAt: now() };
      db.profiles.push(me);
      db.activeProfileId = me.id;
    }
    db.activeProfileId ??= db.profiles[0].id;
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
    .catch((err) => console.error("Saving study data failed:", err));
  return writes;
}

const findProfile = (id) => {
  const profile = db.profiles.find((p) => p.id === id);
  if (!profile) throw new Error("Profile not found");
  return profile;
};

const findReference = (id) => {
  const reference = db.references.find((r) => r.id === id);
  if (!reference) throw new Error("Reference not found");
  return reference;
};

// ---------- profiles ----------

export async function getStudy() {
  await load();
  return { profiles: db.profiles, activeProfileId: db.activeProfileId, references: db.references, likeTags: LIKE_TAGS };
}

export async function createProfile(name) {
  await load();
  const clean = String(name || "").trim().slice(0, 40);
  if (!clean) throw new Error("Give the profile a name.");
  const profile = { id: newId("prof"), name: clean, createdAt: now() };
  db.profiles.push(profile);
  db.activeProfileId = profile.id;
  await persist();
  return profile;
}

export async function renameProfile(id, name) {
  await load();
  const clean = String(name || "").trim().slice(0, 40);
  if (!clean) throw new Error("Give the profile a name.");
  findProfile(id).name = clean;
  await persist();
  return findProfile(id);
}

export async function deleteProfile(id) {
  await load();
  findProfile(id);
  if (db.profiles.length === 1) throw new Error("Keep at least one profile.");
  const mediaFiles = db.references.filter((r) => r.profileId === id && r.file).map((r) => r.file);
  db.profiles = db.profiles.filter((p) => p.id !== id);
  db.references = db.references.filter((r) => r.profileId !== id);
  if (db.activeProfileId === id) db.activeProfileId = db.profiles[0].id;
  await persist();
  await Promise.all(mediaFiles.map((f) => fs.rm(path.join(STUDY_MEDIA_DIR, f), { force: true })));
}

export async function setActiveProfile(id) {
  await load();
  findProfile(id);
  db.activeProfileId = id;
  await persist();
  return id;
}

// ---------- references ----------

/** Add a video link: its details are fetched in the background, then the creator says what they like. */
export async function addLinkReference({ url, profileId }) {
  await load();
  const reference = {
    id: newId("ref"),
    profileId: profileId && db.profiles.some((p) => p.id === profileId) ? profileId : db.activeProfileId,
    kind: "link",
    url,
    status: "fetching",
    info: { title: url },
    likes: [],
    notes: "",
    createdAt: now(),
  };
  db.references.unshift(reference);
  await persist();

  fetchInfo(url)
    .then((info) => Object.assign(reference, { info, status: "ready", error: null }))
    .catch((err) => Object.assign(reference, { status: "error", error: err.message.split("\n")[0].slice(0, 200) }))
    .finally(persist);
  return reference;
}

/** Add an uploaded clip (already saved into STUDY_MEDIA_DIR as `file`). */
export async function addFileReference({ file, originalName, profileId }) {
  await load();
  const reference = {
    id: newId("ref"),
    profileId: profileId && db.profiles.some((p) => p.id === profileId) ? profileId : db.activeProfileId,
    kind: "file",
    file,
    status: "ready",
    info: { title: String(originalName || file).replace(/\.[^.]+$/, "") },
    likes: [],
    notes: "",
    createdAt: now(),
  };
  db.references.unshift(reference);
  await persist();
  return reference;
}

export async function saveFeedback(id, { likes, notes, title }) {
  await load();
  const reference = findReference(id);
  if (Array.isArray(likes)) reference.likes = [...new Set(likes.filter((tag) => LIKE_TAGS.includes(tag)))];
  if (typeof notes === "string") reference.notes = notes.slice(0, 2000);
  if (typeof title === "string" && title.trim() && reference.kind === "file") reference.info.title = title.trim().slice(0, 140);
  reference.updatedAt = now();
  await persist();
  return reference;
}

export async function removeReference(id) {
  await load();
  const reference = findReference(id);
  db.references = db.references.filter((r) => r.id !== id);
  await persist();
  if (reference.file) await fs.rm(path.join(STUDY_MEDIA_DIR, reference.file), { force: true });
  if (reference.media) await fs.rm(path.join(STUDY_MEDIA_DIR, reference.media), { force: true });
  await fs.rm(path.join(STUDY_MEDIA_DIR, "sheets", `${id}.jpg`), { force: true });
}

// ---------- style analysis ----------

const analyzing = new Set();

/** The reference's own video on disk, downloading a linked reel the first time (the creator asked to analyze it). */
async function referenceVideo(reference) {
  if (reference.kind === "file") return path.join(STUDY_MEDIA_DIR, reference.file);
  const saved = path.join(STUDY_MEDIA_DIR, "reels", `${reference.id}.mp4`);
  try {
    await fs.access(saved);
  } catch {
    const dir = path.join(STUDY_MEDIA_DIR, "reels", `${reference.id}-dl`);
    await fs.mkdir(dir, { recursive: true });
    const name = await downloadVideo(reference.url, dir, { maxHeight: 1920 });
    await fs.rename(path.join(dir, name), saved);
    await fs.rm(dir, { recursive: true, force: true });
  }
  reference.media = `reels/${reference.id}.mp4`;
  return saved;
}

/** Measure a reference's editing style (cuts, pacing, tone, color) in the background. */
export async function analyzeReference(id) {
  await load();
  const reference = findReference(id);
  if (reference.kind === "link" && reference.status !== "ready") throw new Error("Wait for the link details to load first.");
  if (analyzing.has(id)) return reference;
  analyzing.add(id);
  reference.style = { ...(reference.style || {}), status: "analyzing", error: null };
  await persist();

  (async () => {
    const file = await referenceVideo(reference);
    await fs.mkdir(path.join(STUDY_MEDIA_DIR, "sheets"), { recursive: true });
    const metrics = await measureReel(file, { sheetPath: path.join(STUDY_MEDIA_DIR, "sheets", `${id}.jpg`) });
    reference.style = { status: "ready", measuredAt: now(), metrics, traits: describeReel(metrics), sheet: `sheets/${id}.jpg` };
  })()
    .catch((err) => {
      console.error(`[study ${id}] style analysis failed:`, err.message);
      reference.style = { ...(reference.style || {}), status: "error", error: err.message.split("\n")[0].slice(0, 200) };
    })
    .finally(() => {
      analyzing.delete(id);
      persist();
    });
  return reference;
}

/** Measured references, for the style engine. */
export async function measuredReferences() {
  await load();
  return db.references.filter((r) => r.style?.status === "ready");
}

// ---------- taste ----------

/**
 * A prompt block describing what a profile likes, for clip picking, titles and edits.
 * Returns "" until the profile has references with feedback.
 */
export async function tasteGuidance(profileId) {
  await load();
  const profile = db.profiles.find((p) => p.id === (profileId || db.activeProfileId));
  if (!profile) return "";
  const refs = db.references.filter((r) => r.profileId === profile.id && (r.likes.length || r.notes));
  if (!refs.length) return "";

  const tally = new Map();
  for (const r of refs) for (const tag of r.likes) tally.set(tag, (tally.get(tag) || 0) + 1);
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([tag, n]) => `${tag} (${n})`);

  const lines = refs.slice(0, 20).map((r) => {
    const who = r.info.uploader ? ` by ${r.info.uploader}` : "";
    const likes = r.likes.length ? ` — likes: ${r.likes.join(", ")}` : "";
    const notes = r.notes ? ` — "${r.notes.replace(/\s+/g, " ").slice(0, 300)}"` : "";
    return `- ${r.info.title}${who}${likes}${notes}`;
  });

  return `<style_references profile="${profile.name}">
Videos this creator studies and admires, with what they like about each. Lean into those qualities when picking moments, writing hooks and titles, and pacing edits. Never copy a reference's content.
What they care about most: ${top.join(", ") || "see notes"}
${lines.join("\n")}
</style_references>`;
}
