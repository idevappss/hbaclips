// Dope Edits: jobs (analyze → direct → render) and the HTTP API + UI, as a mountable router.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { PROJECTS_DIR, ROOT } from "../lib/tools.js";
import { transcribe } from "../lib/transcribe.js";
import { analyzeSource, speechLines } from "./analyze.js";
import { analyzeMusic, musicStarts } from "./beats.js";
import { directEdit, hasClaudeKey } from "./director.js";
import { addIdea, blendedRecipe, deleteIdea, distillStyle, IDEAS_MEDIA, listIdeas, readStyle, recordFeedback, remodelIdea, resumeModeling, styleGuidance, updateIdea } from "./ideas.js";
import { ACCENTS, LOOKS, TEXT_STYLES, vocabulary } from "./looks.js";
import { pruneSegments, renderPlan } from "./render.js";
import { DATA_DIR, EDITS_DIR, deleteEdit, editDir, listEdits, loadEdit, newId, saveEdit, sourcePath } from "./store.js";
import { ASPECTS, buildPlan } from "./timeline.js";
import { PLAN_VERSION, SFX_DIR, toEditPlan } from "./contract.js";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const UPLOADS = path.join(DATA_DIR, "uploads");
const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const AUDIO_RE = /\.(mp3|wav|m4a|aac|flac|ogg|opus|aiff?)$/i;
const BUSY = ["queued", "analyzing", "directing", "rendering"];

// The shared sound library (lib/sounds.js, data/sounds/). Read straight from disk on every call: lib/sounds.js
// caches its database per process, so writing through it from a second server would clobber HBA Clips's copy.
const SOUNDS_JSON = path.join(ROOT, "data", "sounds.json");
const SOUNDS_DIR = path.join(ROOT, "data", "sounds");
async function soundTracks() {
  const db = await fs.readFile(SOUNDS_JSON, "utf8").then(JSON.parse, () => ({ tracks: [] }));
  return (db.tracks || []).filter((t) => t.file);
}

// ---------------------------------------------------------------------------
// Options

export function normalizeOptions(input = {}, { hasMusic = false, sources = [] } = {}) {
  const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
  const longSingle = sources.length === 1 && sources[0].duration > 120;
  let audioMode = pick(input.audioMode, ["auto", "music", "mix", "source"], "auto");
  if (audioMode === "auto") audioMode = hasMusic ? (longSingle ? "mix" : "music") : "source";
  if (!hasMusic && audioMode !== "source") audioMode = "source";
  return {
    length: Math.min(180, Math.max(5, Math.round(Number(input.length) || 30))),
    aspect: pick(input.aspect, Object.keys(ASPECTS), "9:16"),
    energy: pick(input.energy, ["auto", "hype", "medium", "chill"], "auto"),
    audioMode,
    vibe: String(input.vibe || "").trim().slice(0, 1500),
    title: String(input.title || "").trim().slice(0, 80),
    look: pick(input.look, ["auto", ...Object.keys(LOOKS)], "auto"),
    // null/"" mean "let the director decide" (Number(null) would silently turn the grade off).
    lookIntensity: input.lookIntensity === undefined || input.lookIntensity === null || input.lookIntensity === "" || !Number.isFinite(Number(input.lookIntensity)) ? null : Math.min(1.2, Math.max(0, Number(input.lookIntensity))),
    textStyle: pick(input.textStyle, ["auto", ...Object.keys(TEXT_STYLES)], "auto"),
    accent: /^#?[0-9a-f]{6}$/i.test(String(input.accent || "")) ? String(input.accent).replace("#", "").toUpperCase() : null,
    captions: input.captions === true || input.captions === "true",
    sfx: pick(input.sfx, ["full", "subtle", "off"], "full"),
    ideaIds: Array.isArray(input.ideaIds) ? input.ideaIds.map(String).slice(0, 20) : [],
  };
}

// ---------------------------------------------------------------------------
// Jobs: one at a time (rendering is heavy), each can be stopped.

const queue = [];
const running = new Map(); // editId → { controller }
let pumping = false;
// false when a host (HBA Clips) renders plans itself: jobs stop once the plan is ready.
let defaultRender = true;

/** Who asked for a job: method, URL, referring page and client, kept on the edit for tracing. */
const requestVia = (req, extra = "") =>
  `${req.method} ${req.originalUrl}${extra ? ` ${extra}` : ""} · from ${req.get("referer") || "no referer"} · ${String(req.get("user-agent") || "no user agent").slice(0, 60)}`;

function enqueue(edit, kind, { render, via = "unknown" } = {}) {
  if (running.has(edit.id) || queue.some((j) => j.id === edit.id)) throw new Error("This edit is already being worked on.");
  queue.push({ id: edit.id, kind, render: render ?? defaultRender, controller: new AbortController() });
  edit.jobs = [...(edit.jobs || []).slice(-29), { at: new Date().toISOString(), kind, render: render ?? defaultRender, via }];
  Object.assign(edit, { status: "queued", progress: 0, message: queue.length > 1 ? `Waiting for ${queue.length - 1} edit(s) ahead…` : "Starting…", error: null });
  saveEdit(edit);
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    const job = queue.shift();
    const edit = await loadEdit(job.id);
    if (!edit) continue;
    running.set(edit.id, job);
    try {
      await work(edit, job);
    } catch (err) {
      if (job.controller.signal.aborted) {
        Object.assign(edit, { status: edit.versions?.length ? "done" : edit.editPlan ? "planned" : "cancelled", progress: 0, message: "Stopped", error: null });
      } else {
        console.error(`[edit ${edit.id}]`, err);
        Object.assign(edit, { status: "error", message: "Something went wrong", error: err.message });
      }
      await saveEdit(edit);
    } finally {
      running.delete(edit.id);
    }
  }
  pumping = false;
}

function throttle(fn, ms = 600) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    }
  };
}

/** Analysis of every source and the music (cached on disk), shaped for the director and timeline. */
async function gather(edit, { signal, set }) {
  const dir = editDir(edit.id);
  const scanned = [];
  for (const [k, src] of edit.sources.entries()) {
    const file = sourcePath(edit, src);
    // HBA Clips projects are analyzed once and shared by every edit that uses them (moment ids carry the letter).
    const workDir = src.projectId ? path.join(DATA_DIR, "analysis", `project-${src.projectId}`, src.letter) : path.join(dir, "analysis", src.letter);
    const a = await analyzeSource(file, workDir, {
      letter: src.letter,
      maxSheets: edit.sources.length > 4 ? 1 : 2,
      signal,
      onProgress: throttle((p) => set({ progress: Math.round(2 + (38 * (k + p)) / edit.sources.length), message: `Watching ${src.name}…` })),
    });
    scanned.push({ src, file, workDir, a });
  }

  // Speech only matters when some dialogue can make it into the edit ("auto" resolves once durations are known).
  const { audioMode } = normalizeOptions(edit.options, { hasMusic: Boolean(edit.music), sources: scanned.map((s) => s.a) });
  const analyzed = [];
  for (const { src, file, workDir, a } of scanned) {
    let words = null;
    if (audioMode !== "music" && a.hasAudio && a.duration >= 4) {
      const cached = path.join(workDir, "words.json");
      words = await fs.readFile(cached, "utf8").then(JSON.parse, () => null);
      if (!words && src.projectId) words = await fs.readFile(path.join(PROJECTS_DIR, src.projectId, "words.json"), "utf8").then(JSON.parse, () => null);
      if (!words) {
        set({ message: `Listening to ${src.name} (Whisper)…` });
        words = await transcribe(file, workDir, { onProgress: throttle((line) => set({ message: `Listening to ${src.name}… ${line.slice(0, 60)}` }), 1500) }).catch((err) => {
          console.error(`[edit ${edit.id}] transcription skipped:`, err.message);
          return [];
        });
      }
      await fs.writeFile(cached, JSON.stringify(words));
    }
    analyzed.push({ ...a, letter: src.letter, name: src.name, file, workDir, words, speech: words?.length ? speechLines(words) : null });
  }

  let music = null;
  if (edit.music) {
    set({ progress: 41, message: "Finding the beat…" });
    const file = path.isAbsolute(edit.music.file) ? edit.music.file : path.join(dir, edit.music.file);
    const cacheFile = path.join(dir, "music.json");
    const stat = await fs.stat(file);
    const key = `${stat.size}:${stat.mtimeMs}`;
    let cached = await fs.readFile(cacheFile, "utf8").then(JSON.parse, () => null);
    if (cached?.key !== key) {
      cached = { key, ...(await analyzeMusic(file, { signal })) };
      await fs.writeFile(cacheFile, JSON.stringify(cached));
    }
    music = { ...cached, name: edit.music.name, file };
  }
  return { analyzed, music };
}

async function work(edit, job) {
  const { signal } = job.controller;
  const set = (patch) => {
    if (signal.aborted) return;
    Object.assign(edit, patch);
    return saveEdit(edit);
  };
  const dir = editDir(edit.id);
  const redirect = job.kind !== "rerender" || !edit.raw;

  await set({ status: "analyzing", progress: 1, message: "Watching your clips…" });
  const { analyzed, music } = await gather(edit, { signal, set });
  signal.throwIfAborted();
  const options = normalizeOptions(edit.options, { hasMusic: Boolean(music), sources: analyzed });
  edit.options = options;

  let raw = edit.raw;
  if (redirect) {
    await set({ status: "directing", progress: 43, message: hasClaudeKey() ? "Claude is directing the edit…" : "Planning the edit…" });
    const recipe = await blendedRecipe(options.ideaIds);
    const energy = options.energy === "auto" ? recipe?.energy || "hype" : options.energy;
    const starts = music ? musicStarts(music, options.length) : [];
    raw = await directEdit({
      sources: analyzed,
      music,
      starts,
      options: { ...options, energy },
      style: await styleGuidance(options.ideaIds),
      recipe,
      seed: `${edit.id}:${edit.versions.length}:${Date.now()}`,
    });
    signal.throwIfAborted();
  }

  // Creator overrides always win over the director.
  const final = {
    ...raw,
    look: options.look !== "auto" ? options.look : raw.look,
    lookIntensity: options.lookIntensity ?? raw.lookIntensity,
    textStyle: options.textStyle !== "auto" ? options.textStyle : raw.textStyle,
    accent: options.accent || raw.accent,
    title: options.title || raw.title,
    musicStart: edit.musicStart ?? raw.musicStart,
  };
  const sources = Object.fromEntries(analyzed.map((a) => [a.letter, { file: a.file, duration: a.duration, hasAudio: a.hasAudio, fps: a.fps, words: a.words }]));
  const plan = buildPlan(final, { sources, music, options });

  const planVersion = (edit.planVersion || 0) + 1;
  const editPlan = toEditPlan(plan, { edit, raw, analyzed, planVersion });
  if (!job.render) {
    await set({ status: "planned", progress: 100, message: `Planned ${plan.shots.length} shots · ${plan.length.toFixed(1)}s`, raw, plan, editPlan, planVersion });
    return;
  }

  const version = (edit.versions.at(-1)?.n || 0) + 1;
  await set({ status: "rendering", progress: 46, message: "Cutting shots…", raw, plan, editPlan, planVersion });
  const onProgress = throttle((f, message) => set({ progress: Math.round(46 + 53 * f), message }), 500);
  const started = Date.now();
  const result = await renderPlan(plan, dir, { outName: `v${version}.mp4`, onProgress, signal });
  await pruneSegments(dir, new Set(result.segments));

  edit.versions.push({
    n: version,
    file: `v${version}.mp4`,
    length: plan.length,
    shots: plan.shots.length,
    look: plan.look,
    textStyle: plan.textStyle,
    bpm: plan.music?.bpm ?? null,
    mode: raw.mode,
    concept: raw.concept,
    notice: raw.notice || null,
    renderSeconds: Math.round((Date.now() - started) / 1000),
    createdAt: new Date().toISOString(),
  });
  await set({ status: "done", progress: 100, message: `Rendered v${version} in ${Math.round((Date.now() - started) / 1000)}s`, current: version });
}

// ---------------------------------------------------------------------------
// Planning API (for hosts that render plans themselves)

function newEditRecord({ id, sources, music, input }) {
  const edit = {
    id,
    name: String(input.name || "").trim().slice(0, 80) || (sources.length === 1 ? sources[0].name.replace(/\.[^.]+$/, "") : `${sources.length}-clip edit`),
    createdAt: new Date().toISOString(),
    status: "queued",
    progress: 0,
    message: "Queued",
    error: null,
    sources,
    music,
    musicStart: null,
    raw: null,
    plan: null,
    editPlan: null,
    planVersion: 0,
    versions: [],
    current: null,
  };
  // "auto" audio settles once source durations are known; without a song it can only be the clips' own sound.
  edit.options = { ...normalizeOptions(input, { hasMusic: Boolean(music) }), audioMode: input.audioMode || "auto" };
  if (edit.options.audioMode === "auto" && !music) edit.options.audioMode = "source";
  return edit;
}

async function projectSource(projectId, letter) {
  const p = await fs.readFile(path.join(PROJECTS_DIR, String(projectId), "project.json"), "utf8").then(JSON.parse, () => null);
  if (!p?.source?.file) throw new Error(`HBA Clips project ${projectId} not found.`);
  return { letter, name: p.name, file: path.join(PROJECTS_DIR, p.id, p.source.file), projectId: p.id, size: p.source.size };
}

/**
 * Start planning an edit (no rendering). Resolves right away with the queued edit; use waitForPlan() or poll.
 * @param projectIds  HBA Clips projects to use as sources (source video + transcript reused, nothing copied)
 * @param files       [{ path, name? }] other local videos (programmatic use only)
 * @param trackId     sound library track (data/sounds.json)
 * @param musicFile   { path, name? } a local song instead (programmatic use only)
 * @param options     see normalizeOptions(); plus name
 */
export async function planEdit({ projectIds = [], files = [], trackId = null, musicFile = null, options = {}, via = "planEdit()" } = {}) {
  const sources = [];
  for (const pid of [].concat(projectIds).slice(0, 20)) sources.push(await projectSource(pid, String.fromCharCode(65 + sources.length)));
  for (const f of files.slice(0, 20 - sources.length)) {
    const file = path.resolve(String(f.path));
    await fs.access(file).catch(() => {
      throw new Error(`Video not found: ${file}`);
    });
    sources.push({ letter: String.fromCharCode(65 + sources.length), name: f.name || path.basename(file), file });
  }
  if (!sources.length) throw new Error("Give at least one projectId or file.");
  let music = null;
  if (trackId) {
    const track = (await soundTracks()).find((t) => t.id === String(trackId));
    if (!track) throw new Error("That song isn't in the sound library anymore.");
    music = { name: track.name, file: path.join(SOUNDS_DIR, track.file), trackId: track.id };
  } else if (musicFile?.path) {
    const file = path.resolve(String(musicFile.path));
    await fs.access(file).catch(() => {
      throw new Error(`Song not found: ${file}`);
    });
    music = { name: musicFile.name || path.basename(file), file };
  }
  const edit = newEditRecord({ id: newId(), sources, music, input: options });
  await saveEdit(edit);
  enqueue(edit, "make", { render: false, via });
  return edit;
}

/** The edit-plan/1 JSON once planning finishes (rejects on error, stop or timeout). */
export async function waitForPlan(editId, { timeoutMs = 15 * 60_000, signal } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const edit = await loadEdit(editId);
    if (!edit) throw new Error("Edit not found");
    const queued = running.has(editId) || queue.some((j) => j.id === editId);
    if (!queued && edit.status === "error") throw new Error(edit.error || "Planning failed");
    if (!queued && edit.status === "cancelled") throw new Error("Planning was stopped");
    if (!queued && !BUSY.includes(edit.status) && edit.editPlan) return edit.editPlan;
    if (Date.now() > until) throw new Error("Timed out waiting for the plan");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// ---------------------------------------------------------------------------
// Integration surface

/** Finished edits, newest first — for HBA Clips's scheduler library. */
export async function libraryItems() {
  const items = [];
  for (const edit of await listEdits()) {
    const v = edit.versions?.find((x) => x.n === edit.current) || edit.versions?.at(-1);
    if (!v) continue;
    items.push({
      source: "edits",
      editId: edit.id,
      version: v.n,
      title: edit.name,
      caption: edit.options?.vibe || "",
      duration: v.length,
      file: `${edit.id}/${v.file}`,
      videoPath: path.join(editDir(edit.id), v.file),
      renderedAt: v.createdAt,
    });
  }
  return items;
}

/** Absolute path of a rendered edit file given `${editId}/v3.mp4`, or null. */
export function videoPath(file) {
  const m = String(file).match(/^([a-z0-9]+-[a-f0-9]{6})\/(v\d+\.mp4)$/);
  return m ? path.join(editDir(m[1]), m[2]) : null;
}

async function clipStudioProjects() {
  const ids = await fs.readdir(PROJECTS_DIR).catch(() => []);
  const out = [];
  for (const id of ids) {
    const p = await fs.readFile(path.join(PROJECTS_DIR, id, "project.json"), "utf8").then(JSON.parse, () => null);
    if (!p?.source?.file || !p.source.duration) continue;
    out.push({ id: p.id, name: p.name, duration: p.source.duration, width: p.source.width, height: p.source.height, createdAt: p.createdAt, hasTranscript: await fs.stat(path.join(PROJECTS_DIR, id, "words.json")).then(() => true, () => false) });
  }
  return out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

const summary = (e) => ({
  id: e.id,
  name: e.name,
  createdAt: e.createdAt,
  updatedAt: e.updatedAt,
  status: e.status,
  progress: e.progress,
  message: e.message,
  error: e.error,
  sources: e.sources.length,
  length: e.options?.length,
  aspect: e.options?.aspect,
  current: e.current || null,
  planVersion: e.planVersion || 0,
  versions: e.versions.length,
  file: e.versions.find((v) => v.n === e.current)?.file || null,
});

/**
 * @param sounds  optional { addTrack } from lib/sounds.js. Pass it when mounting inside HBA Clips's process so
 *                songs uploaded here join the shared sound library; without it they stay with their edit.
 */
export function createEditsIntegration({ sounds, render = true } = {}) {
  defaultRender = render;
  const router = express.Router();
  const upload = multer({ dest: UPLOADS });

  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      if (res.statusCode < 400) res.status(400);
      res.json({ error: err.message });
    }
  };
  const withEdit = (fn) =>
    handle(async (req, res) => {
      const edit = await loadEdit(req.params.id);
      if (!edit) {
        res.status(404);
        throw new Error("Edit not found");
      }
      return fn(req, edit);
    });
  const cleanupUploads = (files) => Promise.all((files || []).map((f) => fs.rm(f.path, { force: true })));

  // Relative URLs in the UI need a trailing slash when mounted (e.g. /edits → /edits/).
  router.use((req, res, next) => {
    if (req.method === "GET" && req.baseUrl && req.originalUrl === req.baseUrl) return res.redirect(301, `${req.baseUrl}/`);
    next();
  });
  router.use(express.static(PUBLIC));
  router.use("/media", express.static(EDITS_DIR, { fallthrough: false }));
  router.use("/ideas-media", express.static(IDEAS_MEDIA, { fallthrough: false }));
  router.use("/sfx", express.static(SFX_DIR, { fallthrough: false }));
  router.use(express.json({ limit: "2mb" }));

  router.get("/api/config", handle(() => ({
    claude: hasClaudeKey(),
    vocabulary: vocabulary(),
    looks: Object.fromEntries(Object.entries(LOOKS).map(([id, l]) => [id, { label: l.label, description: l.description }])),
    textStyles: Object.fromEntries(Object.entries(TEXT_STYLES).map(([id, t]) => [id, { label: t.label }])),
    aspects: ASPECTS,
    accents: ACCENTS,
  })));

  router.get("/api/clip-studio/projects", handle(() => clipStudioProjects()));

  router.get("/api/sounds", handle(async () => (await soundTracks()).map(({ id, name, duration, bpm, source, status, study }) => ({ id, name, duration, bpm, source, status, study: study || null }))));

  // ---------- edits ----------

  router.get("/api/edits", handle(async () => (await listEdits()).map(summary)));

  router.post(
    "/api/edits",
    upload.fields([{ name: "videos", maxCount: 20 }, { name: "music", maxCount: 1 }]),
    handle(async (req) => {
      const videos = (req.files?.videos || []).filter((f) => VIDEO_RE.test(f.originalname) || f.mimetype.startsWith("video/"));
      const musicFile = (req.files?.music || []).find((f) => AUDIO_RE.test(f.originalname) || f.mimetype.startsWith("audio/") || VIDEO_RE.test(f.originalname));
      let input = {};
      try {
        input = JSON.parse(req.body.options || "{}");
      } catch {
        // defaults
      }
      const projectIds = [].concat(input.projectIds || []).map(String).slice(0, 10);
      if (!videos.length && !projectIds.length) {
        await cleanupUploads([...(req.files?.videos || []), ...(req.files?.music || [])]);
        throw new Error("Add at least one video.");
      }

      const id = newId();
      const dir = editDir(id);
      await fs.mkdir(path.join(dir, "sources"), { recursive: true });
      const sources = [];
      const letter = () => String.fromCharCode(65 + sources.length);
      for (const pid of projectIds) {
        const p = await fs.readFile(path.join(PROJECTS_DIR, pid, "project.json"), "utf8").then(JSON.parse, () => null);
        if (!p?.source?.file) continue;
        sources.push({ letter: letter(), name: p.name, file: path.join(PROJECTS_DIR, pid, p.source.file), projectId: pid, size: p.source.size });
      }
      for (const f of videos.slice(0, 20 - sources.length)) {
        const name = `${letter()}${path.extname(f.originalname).toLowerCase() || ".mp4"}`;
        await fs.rename(f.path, path.join(dir, "sources", name));
        sources.push({ letter: letter(), name: f.originalname, file: `sources/${name}`, size: f.size });
      }
      let music = null;
      if (musicFile && sounds?.addTrack) {
        // One library: the upload becomes a track everyone can reuse.
        const file = `${newId()}${path.extname(musicFile.originalname).toLowerCase() || ".mp3"}`;
        await fs.mkdir(SOUNDS_DIR, { recursive: true });
        await fs.rename(musicFile.path, path.join(SOUNDS_DIR, file));
        const track = await sounds.addTrack({ file, name: musicFile.originalname, source: "edits" });
        music = { name: track.name, file: path.join(SOUNDS_DIR, file), trackId: track.id, size: musicFile.size };
      } else if (musicFile) {
        const name = `music${path.extname(musicFile.originalname).toLowerCase() || ".mp3"}`;
        await fs.rename(musicFile.path, path.join(dir, name));
        music = { name: musicFile.originalname, file: name, size: musicFile.size };
      } else if (input.trackId) {
        const track = (await soundTracks()).find((t) => t.id === String(input.trackId));
        if (!track) throw new Error("That song isn't in the sound library anymore.");
        music = { name: track.name, file: path.join(SOUNDS_DIR, track.file), trackId: track.id };
      }
      await cleanupUploads(videos.slice(20));

      const edit = newEditRecord({ id, sources, music, input });
      await saveEdit(edit);
      enqueue(edit, "make", { render: input.render === false ? false : undefined, via: requestVia(req) });
      return edit;
    }),
  );

  router.get("/api/edits/:id", withEdit((_req, edit) => edit));

  // ---------- planning only (hosts render the plan) ----------

  /** { projectIds, trackId?, options } → the queued edit. Poll GET /api/edits/:id until status is "planned". */
  router.post("/api/plans", handle((req) => planEdit({ projectIds: req.body?.projectIds, trackId: req.body?.trackId, options: req.body?.options || {}, via: requestVia(req) })));

  router.get("/api/edits/:id/plan", withEdit((_req, edit) => {
    if (!edit.editPlan) throw new Error(BUSY.includes(edit.status) ? "Still planning. Poll GET /api/edits/:id until status is planned." : "This edit has no plan yet.");
    return edit.editPlan;
  }));

  /** New plan for the same sources. keepShots: same shots, new finish (look, text, title, captions, SFX, music start). */
  router.post("/api/edits/:id/replan", withEdit((req, edit) => {
    const keepShots = Boolean(req.body.keepShots && edit.raw);
    edit.options = { ...edit.options, ...(req.body.options || {}) };
    if (req.body.musicStart !== undefined) edit.musicStart = req.body.musicStart === null ? null : Number(req.body.musicStart);
    else if (!keepShots) edit.musicStart = null;
    enqueue(edit, keepShots ? "rerender" : "reroll", { render: false, via: requestVia(req, `keepShots=${JSON.stringify(req.body?.keepShots)}`) });
    return edit;
  }));

  router.delete("/api/edits/:id", withEdit(async (_req, edit) => {
    const job = running.get(edit.id) || queue.find((j) => j.id === edit.id);
    if (job) {
      job.controller.abort();
      queue.splice(queue.indexOf(job), queue.includes(job) ? 1 : 0);
    }
    await deleteEdit(edit.id);
    return { ok: true };
  }));

  /** New direction (same sources), optionally with changed options. */
  router.post("/api/edits/:id/reroll", withEdit((req, edit) => {
    edit.options = { ...edit.options, ...(req.body.options || {}) };
    if (req.body.musicStart !== undefined) edit.musicStart = req.body.musicStart === null ? null : Number(req.body.musicStart);
    else edit.musicStart = null;
    enqueue(edit, "reroll", { via: requestVia(req) });
    return edit;
  }));

  /** Same shots, new finish: look, text, title, captions, SFX, music start. */
  router.post("/api/edits/:id/rerender", withEdit((req, edit) => {
    if (!edit.raw) throw new Error("This edit hasn't been directed yet.");
    const allowed = ["look", "lookIntensity", "textStyle", "accent", "title", "captions", "sfx", "aspect", "length"];
    for (const key of allowed) if (req.body.options?.[key] !== undefined) edit.options[key] = req.body.options[key];
    if (req.body.musicStart !== undefined) edit.musicStart = req.body.musicStart === null ? null : Number(req.body.musicStart);
    enqueue(edit, "rerender", { via: requestVia(req) });
    return edit;
  }));

  router.post("/api/edits/:id/cancel", withEdit((_req, edit) => {
    const job = running.get(edit.id) || queue.find((j) => j.id === edit.id);
    if (!job) throw new Error("This edit isn't being worked on.");
    job.controller.abort();
    const waiting = queue.indexOf(job);
    if (waiting !== -1) {
      queue.splice(waiting, 1);
      Object.assign(edit, { status: edit.versions.length ? "done" : "cancelled", message: "Stopped", progress: 0 });
      saveEdit(edit);
    }
    return edit;
  }));

  router.post("/api/edits/:id/current", withEdit(async (req, edit) => {
    const n = Number(req.body.version);
    if (!edit.versions.some((v) => v.n === n)) throw new Error("No such version");
    edit.current = n;
    await saveEdit(edit);
    return edit;
  }));

  router.post("/api/edits/:id/feedback", withEdit(async (req, edit) => {
    const version = Number(req.body.version) || edit.current;
    const v = edit.versions.find((x) => x.n === version);
    if (!v) throw new Error("No such version");
    v.rating = req.body.rating;
    v.note = String(req.body.note || "").trim().slice(0, 1000);
    const entry = await recordFeedback({ editId: edit.id, version, rating: req.body.rating, note: v.note, plan: version === edit.versions.at(-1).n ? edit.plan : null });
    await saveEdit(edit);
    return entry;
  }));

  // ---------- style ideas ----------

  router.get("/api/ideas", handle(() => listIdeas()));
  router.post("/api/ideas", upload.array("files", 12), handle(async (req) => {
    try {
      return await addIdea({ title: req.body.title, notes: req.body.notes, url: req.body.url, files: req.files || [] });
    } catch (err) {
      await cleanupUploads(req.files);
      throw err;
    }
  }));
  router.patch("/api/ideas/:id", handle((req) => updateIdea(req.params.id, req.body || {})));
  router.post("/api/ideas/:id/remodel", handle((req) => remodelIdea(req.params.id)));
  router.delete("/api/ideas/:id", handle(async (req) => {
    await deleteIdea(req.params.id);
    return { ok: true };
  }));
  router.get("/api/style", handle(async () => ({ markdown: await readStyle() })));
  router.post("/api/style/refresh", handle(async () => ({ markdown: await distillStyle() })));

  async function start() {
    await fs.mkdir(UPLOADS, { recursive: true });
    // Anything mid-flight when the server stopped can't resume.
    for (const edit of await listEdits()) {
      if (BUSY.includes(edit.status)) {
        const settled = edit.versions.length ? "done" : edit.editPlan ? "planned" : null;
        Object.assign(edit, { status: settled || "error", progress: 0, message: "Interrupted", error: settled ? null : "Interrupted when the server restarted. Hit re-roll to try again." });
        await saveEdit(edit);
      }
    }
    // Old abandoned uploads.
    for (const name of await fs.readdir(UPLOADS).catch(() => [])) {
      const file = path.join(UPLOADS, name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 6 * 3600_000) await fs.rm(file, { force: true });
    }
    await resumeModeling();
  }

  return { router, start, libraryItems, videoPath, planEdit, waitForPlan, planVersion: PLAN_VERSION };
}
