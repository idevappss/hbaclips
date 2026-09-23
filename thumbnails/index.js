// Thumbnails: every imported video gets a YouTube-ready 1280×720 thumbnail made for it, automatically,
// while it's still transcribing — unless the creator switches that off, globally or for one video.
// Owned by the THUMBNAILS session: thumbnails/ and data/thumbnails/. It only ever reads projects/.
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { ROOT } from "../lib/tools.js";
import { listProjects, loadProject, projectDir } from "../lib/store.js";
import { candidates } from "./frames.js";
import { headlineFor, hasClaudeKey } from "./headline.js";
import { LAYOUTS, LAYOUT_IDS, autoLayout, brandStyle, thumbnailHtml } from "./compose.js";
import { shoot, fileUrl, closeBrowser } from "./shot.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(ROOT, "data", "thumbnails");
const DB_FILE = path.join(DATA_DIR, "db.json");
const FILES_DIR = path.join(DATA_DIR, "files");

const THUMB = "thumb.jpg";
const POLL_MS = 15_000;
const CANDIDATE_COUNT = 10;
/** A video that's still transcribing has enough picture to work with; one still importing doesn't. */
const READY_STATES = new Set(["transcribing", "analyzing", "ready", "rendering", "done", "complete", "failed"]);

const now = () => new Date().toISOString();
const clean = (s, max = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const newId = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// ---------------------------------------------------------------------------
// data/thumbnails/db.json
//   settings { auto, layout, sub, logo }         — auto:false stops every automatic thumbnail
//   projects { <projectId>: { auto, state, error, itemId, at } }  — auto:false skips just that video
//   items    [ Item ]                            — the thumbnail each video has now
//   history  [ Item ]                            — the ones they replaced, newest first

const DEFAULTS = { auto: true, layout: "auto", sub: true, logo: false, accent: null };

let db;
let writes = Promise.resolve();
let syncedAt = 0;

/**
 * The library, re-read whenever the file has changed since we last touched it — the app and a dev server can
 * both be up, and neither should overwrite what the other saved.
 */
async function load() {
  const changed = await fs.stat(DB_FILE).then((s) => s.mtimeMs > syncedAt).catch(() => false);
  if (!db || changed) {
    let data = {};
    try {
      const raw = await fs.readFile(DB_FILE, "utf8");
      syncedAt = (await fs.stat(DB_FILE)).mtimeMs;
      data = JSON.parse(raw);
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // a hand-edit broke the JSON — never overwrite it
    }
    db = {
      settings: { ...DEFAULTS, ...(data.settings || {}) },
      projects: data.projects && typeof data.projects === "object" ? data.projects : {},
      items: Array.isArray(data.items) ? data.items : [],
      history: Array.isArray(data.history) ? data.history : [],
    };
  }
  return db;
}

function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  writes = writes
    .then(async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${DB_FILE}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(tmp, `${snapshot}\n`);
      await fs.rename(tmp, DB_FILE);
      syncedAt = await fs.stat(DB_FILE).then((s) => s.mtimeMs, () => Date.now());
    })
    .catch((err) => console.error("Saving thumbnails failed:", err.message));
  return writes;
}

const projectState = (id) => (db.projects[id] ??= { auto: null, state: "waiting", error: null, itemId: null, at: null });
/** Automatic thumbnails run when the switch is on and this video hasn't been switched off. */
const autoFor = (id) => db.settings.auto !== false && projectState(id).auto !== false;

// ---------------------------------------------------------------------------
// Making one

/** The lightest copy of the video that exists: the working copy when the pipeline has made one. */
function videoFor(project) {
  const dir = projectDir(project.id);
  const work = path.join(dir, "work.mp4");
  if (existsSync(work)) return work;
  const source = project.source?.file && path.join(dir, project.source.file);
  return source && existsSync(source) ? source : null;
}

/** Whatever has been transcribed so far — a video mid-transcription still gives us something to read. */
async function transcriptText(project) {
  if (Array.isArray(project.segments) && project.segments.length) return project.segments.map((s) => s.text).join(" ");
  try {
    const raw = JSON.parse(await fs.readFile(path.join(projectDir(project.id), "transcript.json"), "utf8"));
    const segments = Array.isArray(raw) ? raw : raw.segments || [];
    return segments.map((s) => s.text).join(" ");
  } catch {
    return "";
  }
}

/** The creator's title taste, so thumbnail words sound like them. Optional: titles/ is its own session. */
async function taste() {
  try {
    const { titleGuidance } = await import("../titles/index.js");
    return (await titleGuidance()) || "";
  } catch {
    return "";
  }
}

const itemFile = (item, name = THUMB) => path.join(FILES_DIR, item.id, name);

/** Replaced thumbnails stay browsable under "All thumbnails" until they fall off the end of the history. */
const HISTORY_MAX = 80;
async function archive(items) {
  for (const old of items) db.history.unshift({ ...old, replacedAt: now() });
  for (const dropped of db.history.splice(HISTORY_MAX)) {
    await fs.rm(path.join(FILES_DIR, dropped.id), { recursive: true, force: true }).catch(() => {});
  }
}

/** Render (or re-render) an item's picture from its stored still and words. */
async function paint(item) {
  const style = await brandStyle({ accent: item.accent, logo: item.logo });
  const layout = LAYOUT_IDS.has(item.layout) ? item.layout : autoLayout(item.frame?.face);
  const html = thumbnailHtml({
    imageUrl: fileUrl(itemFile(item, item.frame.file)),
    headline: item.layout === "word" ? item.word || item.headline : item.headline,
    sub: item.sub,
    layout,
    accent: style.accent,
    face: item.frame?.face,
    logoUrl: style.logoUrl,
    badge: item.badge,
    hit: item.word,
  });
  const shot = await shoot(html, itemFile(item));
  Object.assign(item, { usedLayout: layout, usedAccent: style.accent, width: shot.width, height: shot.height, size: shot.size, updatedAt: now() });
  return item;
}

const running = new Map();

/**
 * Make the thumbnail for one project: stills → Claude picks and writes → Chrome paints it.
 * Replaces the project's earlier thumbnail. Returns the item.
 */
export function generate(projectId, { signal, onProgress } = {}) {
  if (running.has(projectId)) return running.get(projectId);
  const job = (async () => {
    await load();
    const project = await loadProject(projectId);
    if (!project) throw new Error("Project not found");
    const video = videoFor(project);
    if (!video) throw new Error("This project has no video yet.");

    const state = projectState(projectId);
    Object.assign(state, { state: "working", error: null, at: now() });
    await persist();

    const item = {
      id: newId(),
      projectId,
      name: clean(project.name) || "Untitled",
      headline: "",
      word: "",
      sub: "",
      badge: "",
      layout: db.settings.layout === "auto" ? null : db.settings.layout,
      accent: db.settings.accent,
      logo: db.settings.logo === true,
      liked: null,
      auto: true,
      createdAt: now(),
      updatedAt: now(),
    };
    const dir = path.join(FILES_DIR, item.id);
    await fs.mkdir(dir, { recursive: true });

    try {
      onProgress?.("Reading frames");
      const duration = project.source?.duration || 60;
      const cands = await candidates(video, { duration, count: CANDIDATE_COUNT, outDir: dir, signal });

      onProgress?.(hasClaudeKey() ? "Claude is picking the frame" : "Picking the frame");
      const text = await transcriptText(project);
      const picked = await headlineFor({ cands, text, name: project.name, notes: project.options?.notes, taste: await taste(), signal, tmpDir: dir });

      const frame = picked.frame || cands[0];
      Object.assign(item, {
        headline: picked.headline,
        word: picked.word || picked.headline.split(" ").pop(),
        sub: db.settings.sub ? picked.sub : "",
        layout: item.layout || picked.layout,
        why: picked.why,
        demo: picked.demo === true,
        partial: !text,
        frame: { file: path.basename(frame.file), at: frame.at, face: frame.face, score: frame.score },
        candidates: cands.map((c) => ({ file: path.basename(c.file), at: c.at, score: c.score, face: c.face })),
      });

      onProgress?.("Painting it");
      await paint(item);

      await archive(db.items.filter((i) => i.projectId === projectId));
      db.items = db.items.filter((i) => i.projectId !== projectId);
      db.items.unshift(item);
      Object.assign(state, { state: "ready", error: null, itemId: item.id, at: now() });
      await persist();
      return item;
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      if (err?.name !== "AbortError") {
        Object.assign(state, { state: "failed", error: err.message.split("\n")[0], at: now() });
        await persist();
      }
      throw err;
    }
  })();
  running.set(projectId, job);
  job.catch(() => {}).finally(() => running.delete(projectId));
  return job;
}

// ---------------------------------------------------------------------------
// The watcher: new videos get a thumbnail on their own, one at a time

let timer = null;
let ticking = false;

/** Projects that should get an automatic thumbnail right now. */
async function pending() {
  const projects = await listProjects();
  return projects.filter((p) => {
    if (!autoFor(p.id)) return false;
    if (db.items.some((i) => i.projectId === p.id)) return false;
    const state = projectState(p.id);
    if (state.state === "working" || state.state === "failed") return false;
    if (!p.source?.duration) return false;
    return READY_STATES.has(p.status) || Boolean(p.clips?.length);
  });
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await load();
    if (db.settings.auto === false) return;
    for (const project of await pending()) {
      if (db.settings.auto === false) break; // switched off mid-run
      try {
        await generate(project.id);
        console.log(`Thumbnail ready for "${project.name || project.id}".`);
      } catch (err) {
        console.error(`Thumbnail for ${project.id} failed:`, err.message.split("\n")[0]);
      }
    }
  } catch (err) {
    console.error("Thumbnail watcher:", err.message);
  } finally {
    ticking = false;
  }
}

export function start() {
  if (timer) return;
  timer = setInterval(() => tick(), POLL_MS);
  timer.unref?.();
  tick();
}

export async function stop() {
  clearInterval(timer);
  timer = null;
  await closeBrowser();
}

// ---------------------------------------------------------------------------
// HTTP API, mounted at /api/thumbnails

const publicItem = (item, base = "/api/thumbnails") => ({
  ...item,
  url: `${base}/items/${item.id}/file`,
  downloadUrl: `${base}/items/${item.id}/file?download`,
  frames: (item.candidates || []).map((c) => ({ ...c, url: `${base}/items/${item.id}/frames/${encodeURIComponent(c.file)}` })),
  candidates: undefined,
});

const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message.split("\n")[0] });
  }
};

const find = async (id, { past = true } = {}) => {
  await load();
  const item = db.items.find((i) => i.id === id) || (past ? db.history.find((i) => i.id === id) : null);
  if (!item) throw Object.assign(new Error("That thumbnail is gone."), { status: 404 });
  return item;
};

export const router = express.Router();
router.use(express.json({ limit: "1mb" }));
router.use("/ui", express.static(path.join(HERE, "public"), { setHeaders: (res) => res.set("Cache-Control", "no-cache") }));

/** Everything the tab shows: the switch, every video, and the thumbnails made for them. */
router.get("/", handle(async (req) => {
  await load();
  const projects = await listProjects();
  const byProject = new Map(db.items.map((i) => [i.projectId, i]));
  const names = new Map(projects.map((p) => [p.id, p.name]));
  return {
    settings: db.settings,
    layouts: LAYOUTS,
    claude: hasClaudeKey(),
    history: db.history.map((i) => ({ ...publicItem(i, req.baseUrl), past: true, videoName: names.get(i.projectId) || i.name })),
    videos: projects.map((p) => {
      const state = projectState(p.id);
      const item = byProject.get(p.id);
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        duration: p.source?.duration,
        createdAt: p.createdAt,
        auto: state.auto !== false,
        state: item ? "ready" : state.state,
        error: state.error,
        thumbnail: item ? publicItem(item, req.baseUrl) : null,
      };
    }),
  };
}));

/** The switch. `{ auto: false }` stops automatic thumbnails for every video. */
router.patch("/settings", handle(async (req) => {
  await load();
  const body = req.body || {};
  if ("auto" in body) db.settings.auto = body.auto !== false;
  if ("sub" in body) db.settings.sub = body.sub !== false;
  if ("logo" in body) db.settings.logo = body.logo === true;
  if ("layout" in body) db.settings.layout = LAYOUT_IDS.has(body.layout) ? body.layout : "auto";
  if ("accent" in body) db.settings.accent = HEX.test(body.accent || "") ? body.accent : null;
  await persist();
  if (db.settings.auto !== false) tick();
  return db.settings;
}));

/** The per-video switch: `{ auto: false }` means don't make one for this video. */
router.post("/videos/:id/auto", handle(async (req) => {
  await load();
  const state = projectState(req.params.id);
  state.auto = req.body?.auto !== false;
  await persist();
  if (state.auto && db.settings.auto !== false) tick();
  return { id: req.params.id, auto: state.auto };
}));

/** Make one now — by hand, whatever the switches say. */
router.post("/videos/:id/generate", handle(async (req) => {
  await load();
  projectState(req.params.id).state = "waiting";
  const item = await generate(req.params.id);
  return publicItem(item, req.baseUrl);
}));

/** Change the words, the layout, the colour or the still, then repaint. */
router.patch("/items/:id", handle(async (req) => {
  const item = await find(req.params.id);
  const body = req.body || {};
  if ("headline" in body) item.headline = clean(body.headline, 120);
  if ("word" in body) item.word = clean(body.word, 40);
  if ("sub" in body) item.sub = clean(body.sub, 80);
  if ("badge" in body) item.badge = clean(body.badge, 24);
  if ("layout" in body) item.layout = LAYOUT_IDS.has(body.layout) ? body.layout : null;
  if ("accent" in body) item.accent = HEX.test(body.accent || "") ? body.accent : null;
  if ("logo" in body) item.logo = body.logo === true;
  if ("frame" in body) {
    const frame = (item.candidates || []).find((c) => c.file === body.frame);
    if (!frame) throw new Error("That still isn't one of this thumbnail's frames.");
    item.frame = { file: frame.file, at: frame.at, face: frame.face, score: frame.score };
  }
  await paint(item);
  await persist();
  return publicItem(item, req.baseUrl);
}));

/** Fresh words and a fresh pick for the same video. */
router.post("/items/:id/again", handle(async (req) => {
  const item = await find(req.params.id);
  return publicItem(await generate(item.projectId), req.baseUrl);
}));

/** ♥ / ✕ on a thumbnail's words, which also teaches the title taste when that session is installed. */
router.post("/items/:id/rate", handle(async (req) => {
  const item = await find(req.params.id);
  const liked = req.body?.liked === true ? true : req.body?.liked === false ? false : null;
  item.liked = liked;
  await persist();
  try {
    const titles = await import("../titles/index.js");
    if (liked === true) await titles.like({ title: item.headline, kind: "idea", note: "thumbnail headline", source: "thumbnails" });
    if (liked === false) await titles.avoid({ title: item.headline, kind: "idea", note: "thumbnail headline", source: "thumbnails" });
  } catch {
    // titles/ isn't installed, or it's mid-write — the rating still sticks here
  }
  return publicItem(item, req.baseUrl);
}));

/** Put a replaced thumbnail back as the video's current one. The one it displaces joins the history. */
router.post("/items/:id/restore", handle(async (req) => {
  const item = await find(req.params.id);
  if (db.items.includes(item)) return publicItem(item, req.baseUrl);
  await archive(db.items.filter((i) => i.projectId === item.projectId));
  db.items = db.items.filter((i) => i.projectId !== item.projectId);
  db.history = db.history.filter((i) => i !== item);
  delete item.replacedAt;
  item.updatedAt = now();
  db.items.unshift(item);
  const state = projectState(item.projectId);
  Object.assign(state, { state: "ready", itemId: item.id, error: null });
  await persist();
  return publicItem(item, req.baseUrl);
}));

router.delete("/items/:id", handle(async (req) => {
  const item = await find(req.params.id);
  db.history = db.history.filter((i) => i !== item);
  db.items = db.items.filter((i) => i !== item);
  const state = db.projects[item.projectId];
  if (state && state.itemId === item.id) Object.assign(state, { state: "waiting", itemId: null, error: null });
  await persist();
  await fs.rm(path.join(FILES_DIR, item.id), { recursive: true, force: true });
  return { ok: true };
}));

/** The finished 1280×720 JPEG. `?download` saves it under the video's name. */
router.get("/items/:id/file", async (req, res) => {
  try {
    const item = await find(req.params.id);
    if (req.query.download !== undefined) res.attachment(`${(item.name || "thumbnail").replace(/[^\w -]+/g, "").trim() || "thumbnail"}.jpg`);
    res.sendFile(itemFile(item));
  } catch (err) {
    res.status(err.status || 500).type("text").send(err.message);
  }
});

/** One of the candidate stills. */
router.get("/items/:id/frames/:file", async (req, res) => {
  try {
    const item = await find(req.params.id);
    const frame = (item.candidates || []).find((c) => c.file === req.params.file);
    if (!frame) return res.status(404).type("text").send("No such still.");
    res.sendFile(itemFile(item, frame.file));
  } catch (err) {
    res.status(err.status || 500).type("text").send(err.message);
  }
});

/** For other sessions: the thumbnail made for a video, or null. */
router.get("/for", handle(async (req) => {
  await load();
  const item = db.items.find((i) => i.projectId === req.query.projectId);
  return { thumbnail: item ? publicItem(item, req.baseUrl) : null };
}));

export default { router, start, stop, generate };
