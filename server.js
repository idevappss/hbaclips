import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import { FFMPEG, ROOT, PROJECTS_DIR, run } from "./lib/tools.js";
import { analyze, clipLengths, describeClaudeError, hasClaudeKey, packAnalysis, resolveClips } from "./lib/analyze.js";
import { clipTaste, learnTaste, moreLikeThisNote, recordClipFeedback } from "./lib/cliptaste.js";
import { LONG_FORMATS, normalizeLongDesign } from "./lib/longedit.js";
import { clearAudience, getAudience, ingestSource, readSourceParts } from "./lib/audience.js";
import { retitleClip } from "./lib/retitle.js";
import { generateQuestions, listQuestions, removeQuestion, setStatus as setQuestionStatus } from "./lib/intentional.js";
import { getSettings as autoPostSettings, runAutoPost, startAutoPost, updateSettings as updateAutoPost } from "./lib/autopost.js";
import { preflight, repairsFor, scoreReview, sensePass } from "./lib/review.js";
import { readSavedDocument } from "./editor/document.js";
import { isMaterial, materialBlocks, materialRecords, materialsDir } from "./lib/materials.js";
import { findSilences, readSilences } from "./lib/silence.js";
import { checkPicks, clipFromPick, packTranscript } from "./lib/picks.js";
import { correctWords } from "./lib/corrections.js";
import { titleChat } from "./lib/titlechat.js";
import { mixMusicBed } from "./lib/bed.js";
import { measureLevels, readLevels } from "./lib/levels.js";
import { sourceCuts } from "./lib/sourcecuts.js";
import { faceBand } from "./lib/facezone.js";
import { addChannel, checkChannels, listChannels, removeChannel, startChannelWatch, updateChannel } from "./lib/youtubewatch.js";
import { formatMoneyText } from "./lib/money.js";
import { factorSignals, postPerformance } from "./lib/performance.js";
import { ASPECTS, FONTS, STYLES, buildCompositionHtml, normalizeDesign } from "./lib/compose.js";
import { CAPTION_QUALITY, captionQualityStatus } from "./lib/transcribe.js";
import { applyWordFixes, clipMusic, mapFocus, planClip, wordKey } from "./lib/clipplan.js";
import { toTightened } from "./lib/tighten.js";
import { WORK_FILE, hasWorkingCopy } from "./lib/work.js";
import {
  BUSY_STATUSES,
  RENDER_BUSY,
  cancelAllRenders,
  cancelRender,
  findItem,
  finishedRender,
  isRendering,
  processProject,
  queueEditRender,
  queueLongRender,
  stopProcessing,
  startLongEdit,
  queueRender,
  clipFocus,
  retranscribeProject,
  warmProject,
} from "./lib/pipeline.js";
import { createEditsIntegration } from "./edits/index.js";
import { HF_LENGTHS, HF_PACES, createHfEdit, normalizeHfDesign, pickTrack, planHfEdit } from "./lib/hfplan.js";
import { buildHfEditHtml } from "./lib/hfedit.js";
import {
  DOPE_LOOKS,
  DOPE_TEXT_STYLES,
  changeDopeFinish,
  deleteDopeEdit,
  describeDopeEdit,
  dopeMusicFile,
  dopePlanLength,
  dopePreviewHtml,
  rerollDopeEdit,
  startDopeEdit,
  stopDopePlanning,
} from "./lib/dope.js";
import { LENGTHS, VIBES, buildEditHtml, normalizeEditDesign, planTimeline } from "./lib/edit.js";
import { createEdit } from "./lib/edits.js";
import { AUDIO_EXT, SOUNDS_DIR, addTrack, getTrack, importFolder, listTracks, removeTrack, renameTrack } from "./lib/sounds.js";
import { deleteProject, listProjects, loadProject, newProjectId, projectDir, saveProject } from "./lib/store.js";
import { isLink, ytDlpPath } from "./lib/youtube.js";
import {
  STUDY_MEDIA_DIR,
  addFileReference,
  addLinkReference,
  createProfile,
  deleteProfile,
  getStudy,
  removeReference,
  renameProfile,
  saveFeedback,
  setActiveProfile,
  analyzeReference,
  measuredReferences,
} from "./lib/study.js";
import { HF_STYLES, styleSummaries } from "./lib/hfstyles.js";
import { createInstagramIntegration } from "./instagram/index.js";
import { createIntegrations } from "./integrations/index.js";
import { router as titlesRouter, recordEdit } from "./titles/index.js";
import { router as musicRouter } from "./music/index.js";
import { router as editorRouter } from "./editor/index.js";
import { router as resourcesRouter } from "./resources/index.js";
import analytics from "./analytics/index.js";
import thumbnails from "./thumbnails/index.js";
import {
  CAN_PUBLISH,
  PUBLISHERS,
  addAccount,
  createPost,
  deletePost,
  listAccounts,
  listPosts,
  removeAccount,
  removePostsForProject,
  setPublished,
  summary as scheduleSummary,
  tick,
  updatePost,
} from "./lib/scheduler.js";

// Background work (renders, scans, downloads, publishing) runs outside requests. A stray failure there should be
// logged and surfaced on its item, not take the whole studio down.
process.on("unhandledRejection", (err) => console.error("Unhandled background error:", err));

// Load .env from the app folder, whatever directory the server was launched from.
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const PORT = Number(process.env.PORT) || 5173;
const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, "public")));
app.use("/files", express.static(PROJECTS_DIR));

// Live previews: the HyperFrames player + runtime and the fonts/GSAP compositions use.
const HF_DIST = path.join(ROOT, "node_modules", "hyperframes", "dist");
app.get("/vendor/hyperframes-player.js", (_req, res) => res.sendFile(path.join(HF_DIST, "hyperframes-player.global.js")));
app.get("/vendor/hyperframe-runtime.js", (_req, res) => res.sendFile(path.join(HF_DIST, "hyperframe.runtime.iife.js")));
app.use("/studio-assets", express.static(path.join(ROOT, "assets")));

// Instagram publishing lives in instagram/ (SCHEDULER session) and title taste in titles/ (TITLES session);
// see shared/CONTRACT.md and titles/README.md.
const instagram = createInstagramIntegration({ dataDir: path.join(ROOT, "data", "instagram"), projectsDir: PROJECTS_DIR });
app.use("/api/integrations/instagram", instagram.router);
PUBLISHERS.instagram = instagram.publish;
CAN_PUBLISH.instagram = (account) => instagram.canPublish(account); // unlinked accounts go to "Due now"
app.use("/api/titles", titlesRouter);
// Claude key status + "credits left" (integrations/, APIs session; integrations/README.md). Created once: it
// installs the fetch watcher that prices this server's Claude calls.
const integrations = createIntegrations({ dataDir: path.join(ROOT, "data", "integrations") });
app.use("/api/integrations", integrations.router);
// "Save this sound?" for studied videos (music/, MUSIC session; see music/README.md).
app.use("/api/music", musicRouter);
// Timeline editor for "Preview & edit" (editor/, Timeline session; see editor/README.md).
app.use("/api/editor", editorRouter);
// Assets: brand kit and resources (resources/, owned by the Assets session).
app.use("/api/resources", resourcesRouter);
// Analytics: how posted clips and channels are doing (analytics/, owned by the Analytics session).
app.use("/api/analytics", analytics.router);
analytics.start();
// Thumbnails: a 1280×720 thumbnail made for every video while it transcribes (thumbnails/, owned by the
// Thumbnails session; see thumbnails/README.md). start() is the watcher — the tab's switches turn it off.
app.use("/api/thumbnails", thumbnails.router);
thumbnails.start();
// Dope edits planner (edits/, DOPE CLIPS session; shared/EDIT_PLAN.md). It only plans here: lib/dope.js +
// lib/editplan.js preview and render its plans with HyperFrames.
const editsPlanner = createEditsIntegration({ sounds: { addTrack }, render: false });
app.use("/edits", editsPlanner.router);

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      req.projectId ??= newProjectId();
      // Pictures and PDFs that came with the video go in their own folder (lib/materials.js).
      const dir = file.fieldname === "materials" ? materialsDir(req.projectId) : projectDir(req.projectId);
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) =>
      cb(null, file.fieldname === "materials" ? `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}${path.extname(file.originalname).toLowerCase()}` : `source${path.extname(file.originalname).toLowerCase() || ".mp4"}`),
  }),
  fileFilter: (_req, file, cb) =>
    cb(null, file.fieldname === "materials" ? isMaterial(file) : file.mimetype.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.originalname)),
});

const summary = (p) => ({
  id: p.id,
  name: p.name,
  createdAt: p.createdAt,
  status: p.status,
  message: p.message,
  duration: p.source?.duration,
  clipCount: p.clips?.length || 0,
  renderedCount: p.clips?.filter((c) => finishedRender(c)).length || 0,
});

/** JSON handler: resolves to the response body; thrown errors become 400s with a readable message. */
const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const withProject = (fn) =>
  handle(async (req, res) => {
    const project = await loadProject(req.params.id);
    if (!project) {
      res.status(404);
      throw new Error("Project not found");
    }
    return fn(req, project);
  });

const findClip = (project, clipId) => {
  const clip = project.clips?.find((c) => c.id === clipId);
  if (!clip) throw new Error("Clip not found");
  return clip;
};

/** A clip's saved design, falling back to how it was last rendered (clips from before designs existed). */
const clipDesign = (clip) => clip.design || { style: clip.render?.style, cropX: clip.render?.cropX };

/** Merge design changes from a request body (including the older { style, cropX } shape) onto a clip. */
function designFrom(clip, body = {}) {
  const legacy = {};
  if (body.style) legacy.style = body.style;
  if (body.cropX !== undefined) legacy.cropX = body.cropX;
  return normalizeDesign({ ...clipDesign(clip), ...legacy, ...(body.design || {}) });
}

const wordsCache = new Map();
async function projectWords(project) {
  if (!wordsCache.has(project.id)) {
    wordsCache.set(project.id, correctWords(JSON.parse(await fs.readFile(path.join(projectDir(project.id), "words.json"), "utf8"))));
  }
  return wordsCache.get(project.id);
}

// ---------- config ----------

app.get("/api/config", async (_req, res) => {
  res.json({
    claude: hasClaudeKey(),
    captionQuality: await captionQualityStatus(),
    styles: Object.entries(STYLES).map(([id, s]) => ({ id, label: s.label, description: s.description, layout: s.layout, accent: s.design.accentColor, design: s.design })),
    aspects: ASPECTS,
    vibes: Object.fromEntries(Object.entries(VIBES).map(([id, v]) => [id, { label: v.label, description: v.description }])),
    lengths: LENGTHS,
    dope: { looks: DOPE_LOOKS, textStyles: DOPE_TEXT_STYLES },
    hfLengths: HF_LENGTHS,
    longFormats: LONG_FORMATS,
    hfPaces: HF_PACES,
    fonts: Object.fromEntries(Object.entries(FONTS).map(([id, f]) => [id, { label: f.label }])),
  });
});

// ---------- projects ----------

app.get("/api/projects", handle(async () => (await listProjects()).map(summary)));

/** Caption accuracy level from a form or JSON body (lib/transcribe.js CAPTION_QUALITY). */
const captionQualityFrom = (value) => (CAPTION_QUALITY[value] ? value : "standard");

/**
 * What the creator wants from a new video, asked right after they pick it: one finished Dope edit, or clips.
 * Arrives as JSON (a string in multipart uploads). Applied when processing finishes (lib/pipeline.js).
 */
function intentFrom(raw) {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value?.mode === "edit") {
    const trackId = typeof value.trackId === "string" && /^(shuffle|none|[\w-]{1,40})$/.test(value.trackId) ? value.trackId : "shuffle";
    return { mode: "edit", design: normalizeHfDesign(value.design || {}), trackId };
  }
  if (value?.mode === "long") return { mode: "long", design: normalizeLongDesign(value.design || {}) };
  if (value?.mode === "clips") {
    const design = normalizeDesign({ style: value.design?.style, aspect: value.design?.aspect });
    return { mode: "clips", design: { style: design.style, aspect: design.aspect } };
  }
  return null;
}

// New videos are processed one at a time, in the order they arrived: a batch upload queues up instead of
// running several transcriptions at once and slowing every one of them down.
let intake = Promise.resolve();
const queueProcessing = (project) => {
  intake = intake
    .then(async () => {
      if (await loadProject(project.id)) await processProject(project); // skipped if it was deleted while waiting
    })
    .catch((err) => console.error(`[${project.id}]`, err));
};

app.post("/api/projects", upload.fields([{ name: "video", maxCount: 1 }, { name: "materials", maxCount: 20 }]), async (req, res) => {
  req.file = req.files?.video?.[0];
  if (!req.file) {
    if (req.projectId) await fs.rm(projectDir(req.projectId), { recursive: true, force: true });
    return res.status(400).json({ error: "Please upload a video file." });
  }
  const project = {
    id: req.projectId,
    name: req.file.originalname,
    createdAt: new Date().toISOString(),
    status: "queued",
    message: "Queued",
    source: { file: req.file.filename, size: req.file.size },
    materials: materialRecords(req.files?.materials),
    options: {
      language: req.body.language || "en",
      notes: (req.body.notes || "").slice(0, 500),
      captionQuality: captionQualityFrom(req.body.captionQuality),
      intent: intentFrom(req.body.intent),
      // "false": transcribe only and leave the picking to Claude in a chat (mcp/server.js).
      autoPick: String(req.body.autoPick ?? "true") !== "false",
    },
  };
  await saveProject(project);
  queueProcessing(project);
  res.status(201).json(project);
});

/** Start a project from a video link (YouTube and anything else yt-dlp supports). */
/** Start a project from a link: queued for download, transcription and picking. Shared by the link box and the channel watcher. */
async function importFromLink({ url, language, notes, captionQuality, intent, autoPick = true, autoRender = 0, origin = null, name = null }) {
  url = String(url || "").trim();
  if (!isLink(url)) throw new Error("Paste a full video link, like https://youtube.com/watch?v=…");
  if (!ytDlpPath()) throw new Error("Video links need yt-dlp. Install it with: brew install yt-dlp");
  const id = newProjectId();
  await fs.mkdir(projectDir(id), { recursive: true });
  const project = {
    id,
    name: name || url,
    createdAt: new Date().toISOString(),
    status: "queued",
    message: "Queued",
    source: { url, ...(origin ? { origin } : {}) },
    options: {
      language: language || "en",
      notes: String(notes || "").slice(0, 500),
      captionQuality: captionQualityFrom(captionQuality),
      intent: intentFrom(intent),
      autoPick: String(autoPick ?? "true") !== "false",
      // Render the best clips right after picking, through review, so they're waiting on the Review screen.
      autoRender: Math.max(0, Math.min(10, Math.round(Number(autoRender) || 0))),
    },
  };
  await saveProject(project);
  queueProcessing(project);
  return project;
}

app.post("/api/projects/import", handle(async (req, res) => {
  const project = await importFromLink({ url: req.body.url, language: req.body.language, notes: req.body.notes, captionQuality: req.body.captionQuality, intent: req.body.intent, autoPick: req.body.autoPick, autoRender: req.body.autoRender });
  res.status(201);
  return project;
}));

// ---------- YouTube channel watch ----------

app.get("/api/youtube/channels", handle(() => listChannels()));
app.post("/api/youtube/channels", handle(async (req, res) => {
  const channel = await addChannel(req.body.channel, { clipLatest: req.body.clipLatest === true, autoRender: req.body.autoRender ?? 3, notes: req.body.notes });
  res.status(201);
  // Clip the latest video right away when asked, instead of waiting for the next check.
  if (req.body.clipLatest === true) checkChannels(importChannelVideo).catch(() => {});
  return channel;
}));
app.patch("/api/youtube/channels/:channelId", handle((req) => updateChannel(req.params.channelId, req.body)));
app.delete("/api/youtube/channels/:channelId", handle(async (req) => {
  await removeChannel(req.params.channelId);
  return { ok: true };
}));
app.post("/api/youtube/check", handle(async () => ({ found: await checkChannels(importChannelVideo) })));

/** A new upload on a watched channel becomes a project that picks clips and renders the best few. */
function importChannelVideo(video) {
  console.log(`[youtube] new video on ${video.channel.title}: ${video.title}`);
  return importFromLink({
    url: video.url,
    name: video.title,
    notes: video.channel.notes,
    autoRender: video.channel.autoRender,
    origin: { kind: "youtube-channel", channelId: video.channel.id, channelTitle: video.channel.title, videoId: video.videoId, published: video.published },
  });
}

/** The project as the UI sees it: merged-engine edits carry the planner's live status and preview readiness. */
async function withLiveEdits(project) {
  if (!project.edits?.some((e) => e.engine === "dope" || e.engine === "hf")) return project;
  const live = (e) => {
    if (e.engine === "dope") return describeDopeEdit(project, e);
    if (e.engine !== "hf") return e;
    const r = e.render;
    const stale = r?.status === "done" && r.planVersion != null && (r.planVersion !== (e.planVersion || 0) || r.designKey !== JSON.stringify(normalizeHfDesign(e.design)));
    return { ...e, renderStale: stale, shotCount: e.plan?.segments.length || 0 };
  };
  return { ...project, edits: await Promise.all(project.edits.map(live)) };
}

// `work`: the light working copy is ready, so the page can play it instead of the full-size original.
app.get("/api/projects/:id", withProject(async (_req, project) => ({ ...(await withLiveEdits(project)), work: hasWorkingCopy(project) })));

app.delete("/api/projects/:id", withProject(async (_req, project) => {
  if (BUSY_STATUSES.includes(project.status)) throw new Error("This video is still being processed — delete it once that finishes.");
  cancelAllRenders(project);
  for (const edit of project.edits || []) if (edit.engine === "dope") await deleteDopeEdit(edit.id);
  await deleteProject(project.id);
  await removePostsForProject(project.id);
  return { ok: true };
}));

/** Stop a video that's downloading, transcribing or being picked; it can be tried again or deleted. */
app.post("/api/projects/:id/stop", withProject((_req, project) => {
  if (!BUSY_STATUSES.includes(project.status)) throw new Error("This video isn't processing.");
  return stopProcessing(project);
}));

app.post("/api/projects/:id/retry", withProject((_req, project) => {
  if (BUSY_STATUSES.includes(project.status)) throw new Error("This project is already processing.");
  delete project.stopRequested;
  Object.assign(project, { status: "queued", message: "Queued", error: null });
  queueProcessing(project);
  return project;
}));

/** Redo captions with a bigger speech model in the background; clips, titles and edits stay as they are. */
app.post("/api/projects/:id/retranscribe", withProject(async (req, project) => {
  if (project.status !== "ready") throw new Error("Wait for this video to finish processing.");
  if (!project.source.hasAudio) throw new Error("This video has no sound to caption.");
  if (project.captions?.status === "running") throw new Error("Captions are already being redone.");
  const quality = captionQualityFrom(req.body.quality);
  project.captions = { status: "running", quality, startedAt: new Date().toISOString() };
  await saveProject(project);
  retranscribeProject(project.id, quality);
  return project.captions;
}));

app.patch("/api/projects/:id/clips/:clipId", withProject(async (req, project) => {
  const clip = findClip(project, req.params.clipId);
  const { title, highlight, start, end } = req.body;
  if (typeof title === "string" && title.trim() && title.trim() !== clip.title) {
    // Hand-edited hooks are the best signal for the creator's title taste.
    recordEdit({ before: clip.title, after: title, kind: "hook", source: `${project.id}/${clip.id}` }).catch((err) => console.error("Title edit not recorded:", err));
    clip.title = title.trim().slice(0, 120);
  }
  if (typeof highlight === "string") clip.highlight = highlight.trim().slice(0, 40);
  // Transcript editor: words struck out of the video, and per-clip spelling fixes.
  if (Array.isArray(req.body.cuts)) {
    clip.cuts = req.body.cuts
      .map((c) => ({ start: Number(c?.start), end: Number(c?.end) }))
      .map((c) => ({ start: +Number(c.start).toFixed(3), end: +Number(c.end).toFixed(3) }))
      .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end - c.start >= 0.05 && c.end - c.start <= 120)
      .sort((a, b) => a.start - b.start)
      .slice(0, 200);
  }
  if (req.body.wordFixes && typeof req.body.wordFixes === "object") {
    const fixes = { ...(clip.wordFixes || {}) };
    for (const [key, text] of Object.entries(req.body.wordFixes).slice(0, 200)) {
      if (!/^\d{1,8}$/.test(key)) continue;
      if (text === null || String(text).trim() === "") delete fixes[key];
      else fixes[key] = String(text).trim().slice(0, 60);
    }
    clip.wordFixes = fixes;
  }
  // Approval gates what Claude may render without asking again (see /api/projects/:id/clips/propose).
  if (typeof req.body.approved === "boolean") clip.approved = req.body.approved;
  // Pin the opening line: { start, end } in source seconds, or null to let the engine choose again.
  if (req.body.hook === null) delete clip.hook;
  else if (req.body.hook && Number.isFinite(req.body.hook.start) && Number.isFinite(req.body.hook.end) && req.body.hook.end - req.body.hook.start >= 1) {
    clip.hook = { start: +req.body.hook.start.toFixed(3), end: +Math.min(req.body.hook.end, req.body.hook.start + 10).toFixed(3) };
  }
  if (req.body.design && typeof req.body.design === "object") clip.design = designFrom(clip, { design: req.body.design });
  if (Number.isFinite(start) || Number.isFinite(end)) {
    const s = Math.max(0, Number.isFinite(start) ? start : clip.start);
    const e = Math.min(project.source.duration, Number.isFinite(end) ? end : clip.end);
    if (e - s < 3) throw new Error("Clips must be at least 3 seconds long.");
    // Kept stretches (what's left after the cut marks) follow a trim that widens the clip: the first stretch reaches
    // back to a new earlier start, the last one out to a new later end. Narrowing is handled by clamping at plan time.
    if (clip.parts?.length) {
      const first = clip.parts[0];
      const last = clip.parts.at(-1);
      if (s < first.start && Math.abs(first.start - clip.start) < 0.6) first.start = +s.toFixed(3);
      if (e > last.end && Math.abs(last.end - clip.end) < 0.6) last.end = +e.toFixed(3);
    }
    clip.start = +s.toFixed(3);
    clip.end = +e.toFixed(3);
  }
  await saveProject(project);
  return clip;
}));

// Title ideas chat on the Titles page (lib/titlechat.js): the creator's ideas in, premium titles in their voice out.
app.post("/api/title-chat", handle((req) => titleChat({ messages: req.body.messages, kind: req.body.kind })));

/**
 * The clip's words for the transcript editor: every word spoken across the clip's range (and its hook), with what
 * happens to it — played (and where on the clip's timeline), struck out by the creator, or taken out automatically
 * (filler, pauses, restarts, profanity, the length cap). A design in the query previews unsaved style changes.
 */
app.get("/api/projects/:id/clips/:clipId/words", withProject(async (req, project) => {
  const clip = findClip(project, req.params.clipId);
  const words = await projectWords(project);
  const plan = planClip(clip, words, clipDesign(clip), { analysis: project.analysis, silences: await readSilences(project), levels: await readLevels(project) });
  const fixed = applyWordFixes(words, clip.wordFixes);
  const ranges = [...(plan.hook ? [{ ...plan.hook, hook: true }] : []), { start: clip.start, end: clip.end }];
  const cut = (w) => (clip.cuts || []).some((c) => w.start >= c.start - 0.02 && w.end <= c.end + 0.02);
  const sections = ranges.map((r) => ({
    hook: Boolean(r.hook),
    words: fixed
      .filter((w) => w.start >= r.start - 0.05 && w.start < r.end - 0.01)
      .map((w) => {
        const t = toTightened(plan.parts, (w.start + w.end) / 2);
        const key = wordKey(w);
        return { key, text: w.text, said: clip.wordFixes?.[key] ? words.find((x) => wordKey(x) === key)?.text : undefined, start: w.start, end: w.end, t: t === null ? null : Math.max(0, +(t - (w.end - w.start) / 2).toFixed(3)), cut: cut(w), removed: t === null && !cut(w) };
      }),
  }));
  return { duration: plan.duration, sections, cuts: clip.cuts || [] };
}));

// ---------- Claude as the editor (also used by mcp/server.js) ----------

/** The transcript packed for reading: phrase lines with timestamps, pauses and existing clips marked. */
app.get("/api/projects/:id/transcript", withProject(async (req, project) => {
  const words = await projectWords(project);
  if (!words.length) throw new Error(project.status === "ready" ? "This video has no speech to read." : "It's still being transcribed.");
  const from = Number(req.query.from) || 0;
  const to = Number(req.query.to) || Infinity;
  return { projectId: project.id, name: project.name, duration: project.source.duration, words: words.length, ...packTranscript(words, { from, to, clips: project.clips || [] }) };
}));

/**
 * Add clips Claude picked (or a person typed in): each is checked against the transcript first, and a list with any
 * problem is rejected whole with every problem named. New clips arrive unapproved; nothing renders yet.
 */
app.post("/api/projects/:id/clips/propose", withProject(async (req, project) => {
  if (project.status !== "ready") throw new Error("Wait for this video to finish processing.");
  const words = await projectWords(project);
  const replace = req.body.replace === true;
  const keep = replace ? (project.clips || []).filter((c) => finishedRender(c) || c.approved) : project.clips || [];
  const check = checkPicks(req.body.picks, { words, duration: project.source.duration, existing: keep });
  if (!check.ok) {
    const err = new Error(`These picks need fixing:\n- ${check.problems.join("\n- ")}`);
    err.problems = check.problems;
    throw err;
  }
  let next = Math.max(0, ...(project.clips || []).map((c) => Number(String(c.id).replace(/\D/g, "")) || 0)) + 1;
  const added = check.clips.map((pick) => clipFromPick(pick, `clip-${next++}`, 0));
  project.clips = [...keep, ...added].map((c, i) => ({ ...c, rank: i + 1 }));
  await saveProject(project);
  return { added: added.map((c) => project.clips.find((x) => x.id === c.id)), clips: project.clips.length };
}));

/** Rewrite a finished video's titles, YouTube titles, hooks and key messages (keeps its clips and renders). */
app.post("/api/projects/:id/titles/refresh", withProject(async (_req, project) => {
  if (project.status !== "ready" || !project.segments?.length) throw new Error("Wait for this video to finish processing.");
  const { duration, width, height } = project.source;
  let analysis;
  try {
    analysis = await analyze({
      segments: project.segments,
      duration,
      width,
      height,
      notes: project.options?.notes,
      ...clipLengths(duration),
      minClips: 3,
      maxClips: 3,
    });
  } catch (err) {
    throw new Error(describeClaudeError(err).replace(", so these are demo picks", ""));
  }
  project.analysis = packAnalysis(analysis, project.segments);
  await saveProject(project);
  return project.analysis;
}));

// ---------- renders ----------

/**
 * A premixed music bed for a clip preview, cached in the project folder by track, length and level so dragging
 * sliders doesn't rebuild it. Previews used to loop the raw song, and every loop after the first played at full
 * volume.
 */
async function previewBed(project, track, duration, level) {
  const dir = path.join(projectDir(project.id), "beds");
  const name = `${track.id}-${Math.round(duration * 10)}-${Math.round(level * 100)}.m4a`;
  const file = path.join(dir, name);
  if (!existsSync(file)) {
    await fs.mkdir(dir, { recursive: true });
    await mixMusicBed(path.join(SOUNDS_DIR, track.file), file, { duration, level });
    // Keep the cache small: only the newest beds stay.
    const files = await fs.readdir(dir);
    if (files.length > 24) {
      const dated = await Promise.all(files.map(async (f) => ({ f, t: (await fs.stat(path.join(dir, f))).mtimeMs })));
      for (const { f } of dated.sort((a, b) => b.t - a.t).slice(24)) await fs.rm(path.join(dir, f), { force: true });
    }
  }
  return { src: `/files/${project.id}/beds/${name}`, duration, volume: 1, premixed: true };
}

/** Live preview page for the player: the clip composed with an unsaved design/title, playing from the source video. */
/** A clip's cached subject path for previews; when it isn't tracked yet, start tracking and preview centered. */
async function previewFocus(project, clip) {
  const cached = await clipFocus(project, clip, { compute: false }).catch(() => null);
  if (!cached) clipFocus(project, clip).catch(() => {});
  return cached;
}

app.get("/api/projects/:id/clips/:clipId/preview", async (req, res) => {
  const project = await loadProject(req.params.id);
  const clip = project?.clips?.find((c) => c.id === req.params.clipId);
  if (!clip) return res.status(404).type("text").send("Clip not found");
  let design = {};
  try {
    design = JSON.parse(String(req.query.design || "{}"));
  } catch {
    // fall back to the saved design
  }
  const draft = {
    ...clip,
    title: formatMoneyText(typeof req.query.title === "string" && req.query.title.trim() ? req.query.title.trim().slice(0, 120) : clip.title),
    highlight: typeof req.query.highlight === "string" ? req.query.highlight.slice(0, 40) : clip.highlight,
  };
  try {
    const resolved = designFrom(clip, { design });
    const words = await projectWords(project);
    // Previews use the measured pauses once they exist and start measuring otherwise, without waiting on it.
    const silences = await readSilences(project);
    if (!silences) findSilences(project).catch(() => {});
    // Cut points snap to quiet instants once the level map exists (measured in the background on first preview).
    const levels = await readLevels(project);
    if (!levels) measureLevels(project).catch(() => {});
    const edited = await sourceCuts(project, clip.start, clip.end).catch(() => null);
    const plan = planClip(draft, words, resolved, { analysis: project.analysis, silences, levels, stills: edited?.stills });
    const videoSrc = `/files/${project.id}/${encodeURIComponent(hasWorkingCopy(project) ? WORK_FILE : project.source.file)}`;
    const track = await clipMusic(clip, resolved, { projectId: project.id });
    // Footage that's already jump-cut previews without our zooms, the same as it renders.
    const faces = resolved.style === "podcast" ? null : await faceBand(project, clip.start, clip.end, { compute: false }).catch(() => null);
    if (resolved.style !== "podcast" && !faces) faceBand(project, clip.start, clip.end).catch(() => {});
    const { html } = buildCompositionHtml({
      faceBand: faces,
      sourceEdited: Boolean(edited?.busy),
      clip: draft,
      words,
      source: project.source,
      design: resolved,
      videoSrc,
      mediaStart: clip.start,
      focus: mapFocus(await previewFocus(project, clip), draft, plan.parts),
      // The same pieces the render will cut, played straight from the working copy.
      timeline: { duration: plan.duration, parts: plan.parts.map((p) => ({ t: p.t, dur: p.dur, src: videoSrc, mediaStart: p.start })), words: plan.words },
      // The same finished bed a render gets: leveled flat, looped with crossfades, one steady level the whole way.
      music: track ? await previewBed(project, track, plan.duration, resolved.musicLevel) : null,
      assetBase: "/studio-assets/",
      runtimeSrc: "/vendor/hyperframe-runtime.js",
    });
    res.type("html").set("Cache-Control", "no-store").send(html);
  } catch (err) {
    res.status(500).type("text").send(err.message);
  }
});

app.post("/api/projects/:id/clips/:clipId/render", withProject((req, project) => {
  const clip = findClip(project, req.params.clipId);
  clip.design = designFrom(clip, req.body);
  return queueRender(project, clip.id, { design: clip.design });
}));

// ---------- dope edits ----------

const findEdit = (project, editId) => {
  const edit = project.edits?.find((e) => e.id === editId);
  if (!edit) throw new Error("Edit not found");
  return edit;
};

/** Visual tweaks only — a different length or track needs a new edit. */
function applyEditLook(edit, design = {}) {
  const { length: _length, ...look } = design;
  edit.design = normalizeEditDesign({ ...edit.design, ...look });
}

app.post("/api/projects/:id/edits", withProject(async (req, project) => {
  if (project.status !== "ready") throw new Error("Wait for this video to finish processing.");
  if (req.body.engine === "hf") return createHfEdit(project, { design: req.body.design, trackId: req.body.trackId });
  if (req.body.engine === "classic") return createEdit(project, { design: req.body.design, trackId: req.body.trackId });
  const entry = await startDopeEdit(project, { ...(req.body.design || {}), trackId: req.body.trackId });
  return describeDopeEdit(project, entry);
}));

app.patch("/api/projects/:id/edits/:editId", withProject(async (req, project) => {
  const edit = findEdit(project, req.params.editId);
  if (edit.engine === "hf") {
    if (edit.status === "scanning") throw new Error("This edit is still being cut.");
    const next = normalizeHfDesign({ ...edit.design, ...(req.body.design || {}), variant: edit.design.variant });
    const trackChanged = req.body.trackId !== undefined && (req.body.trackId || null) !== edit.trackId;
    // Style, length and format change the cut itself; look and text tweaks just save.
    const recut = trackChanged || ["style", "length", "aspect", "pace", "voiceIntro"].some((key) => next[key] !== edit.design[key]);
    if (trackChanged) edit.trackId = req.body.trackId || null;
    edit.design = next;
    await saveProject(project);
    if (recut) planHfEdit(project, edit);
    return edit;
  }
  if (edit.engine === "dope") {
    const finish = req.body.finish || {};
    await changeDopeFinish(edit.id, finish);
    if (typeof finish.title === "string") edit.design.title = finish.title.trim().slice(0, 80);
    await saveProject(project);
    return describeDopeEdit(project, edit);
  }
  applyEditLook(edit, req.body.design);
  await saveProject(project);
  return edit;
}));

app.post("/api/projects/:id/edits/:editId/reroll", withProject(async (req, project) => {
  const edit = findEdit(project, req.params.editId);
  if (edit.engine === "hf") {
    if (edit.status === "scanning") throw new Error("This edit is still being cut.");
    edit.design = normalizeHfDesign({ ...edit.design, variant: (edit.design.variant || 0) + 1 });
    planHfEdit(project, edit);
    return edit;
  }
  if (edit.engine !== "dope") throw new Error("Re-roll works on edits made by the director.");
  await rerollDopeEdit(edit.id);
  return describeDopeEdit(project, edit);
}));

/** Swap in a different song from the sound library and re-cut the edit to its beat. */
app.post("/api/projects/:id/edits/:editId/shuffle-music", withProject(async (req, project) => {
  const edit = findEdit(project, req.params.editId);
  if (edit.engine !== "hf") throw new Error("Shuffling songs works on HyperFrames edits.");
  if (edit.status === "scanning") throw new Error("This edit is still being cut.");
  const track = await pickTrack(edit.design.style, edit.design.length, { exclude: edit.trackId });
  if (!track) throw new Error("Add a few songs to your sound library first.");
  edit.trackId = track.id;
  planHfEdit(project, edit);
  return edit;
}));

/** The music an edit's plan uses, for its live preview. */
app.get("/api/projects/:id/edits/:editId/music", async (req, res) => {
  const project = await loadProject(req.params.id);
  const edit = project?.edits?.find((e) => e.id === req.params.editId && e.engine === "dope");
  const file = edit ? await dopeMusicFile(edit.id) : null;
  if (!file) return res.status(404).type("text").send("No music for this edit");
  res.sendFile(file);
});

app.delete("/api/projects/:id/edits/:editId", withProject(async (req, project) => {
  const edit = findEdit(project, req.params.editId);
  cancelRender(project, edit.id);
  if (edit.engine === "dope") await deleteDopeEdit(edit.id);
  project.edits = project.edits.filter((e) => e.id !== edit.id);
  await saveProject(project);
  const dir = projectDir(project.id);
  await fs.rm(path.join(dir, "edits", edit.id), { recursive: true, force: true });
  const file = finishedRender(edit)?.file;
  if (file) await fs.rm(path.join(dir, file), { force: true });
  return { ok: true };
}));

app.post("/api/projects/:id/edits/:editId/render", withProject(async (req, project) => {
  const edit = findEdit(project, req.params.editId);
  if (edit.engine === "dope") {
    const live = await describeDopeEdit(project, edit);
    if (live.status !== "ready") throw new Error("This edit is still being planned.");
    queueEditRender(project, edit.id);
    return describeDopeEdit(project, edit);
  }
  if (edit.engine === "hf") {
    if (edit.status !== "ready") throw new Error("This edit is still being cut.");
    return queueEditRender(project, edit.id);
  }
  if (req.body.design) applyEditLook(edit, req.body.design);
  return queueEditRender(project, edit.id);
}));

app.post("/api/projects/:id/edits/:editId/cancel", withProject(async (req, project) => {
  const edit = findEdit(project, req.params.editId);
  if (cancelRender(project, edit.id)) return edit.engine === "dope" ? describeDopeEdit(project, edit) : edit;
  if (edit.engine === "dope") {
    await stopDopePlanning(edit.id);
    return describeDopeEdit(project, edit);
  }
  throw new Error("This edit isn't rendering.");
}));

/** Live preview of an edit with unsaved tweaks, playing from its lightweight proxy file. */
app.get("/api/projects/:id/edits/:editId/preview", async (req, res) => {
  const project = await loadProject(req.params.id);
  const edit = project?.edits?.find((e) => e.id === req.params.editId);
  if (edit?.engine === "hf") {
    if (edit.status !== "ready" || !edit.plan || !edit.proxy) return res.status(409).type("text").send("This edit is still being cut.");
    let tweaks = {};
    try {
      tweaks = JSON.parse(String(req.query.design || "{}"));
    } catch {
      // fall back to the saved look
    }
    // Only look and text tweaks preview live; anything that changes the cut needs a re-cut.
    const LIVE = ["strength", "bars", "cropX", "autoFrame", "title", "captions", "accentColor"];
    const design = normalizeHfDesign({ ...edit.design, ...Object.fromEntries(Object.entries(tweaks).filter(([key]) => LIVE.includes(key))) });
    const track = edit.trackId ? await getTrack(edit.trackId) : null;
    const proxyUrl = `/files/${project.id}/${edit.proxy.file}`;
    const { html } = buildHfEditHtml({
      plan: edit.plan,
      design,
      videoSrcFor: () => proxyUrl,
      mediaStartFor: (s) => edit.proxy.offsets[s.index],
      music: track ? { src: `/sounds-media/${encodeURIComponent(track.file)}`, start: edit.plan.musicStart || 0 } : null,
      assetBase: "/studio-assets/",
      runtimeSrc: "/vendor/hyperframe-runtime.js",
    });
    return res.type("html").set("Cache-Control", "no-store").send(html);
  }
  if (edit?.engine === "dope") {
    const html = await dopePreviewHtml(project, edit.id);
    if (!html) return res.status(409).type("text").send("The preview is still being prepared.");
    return res.type("html").set("Cache-Control", "no-store").send(html);
  }
  if (!edit || edit.status !== "ready") return res.status(404).type("text").send("This edit isn't ready yet.");
  let tweaks = {};
  try {
    tweaks = JSON.parse(String(req.query.design || "{}"));
  } catch {
    // fall back to the saved look
  }
  const design = normalizeEditDesign({ ...edit.design, ...tweaks, length: edit.design.length });
  const track = edit.trackId ? await getTrack(edit.trackId) : null;
  const timeline = planTimeline({ shots: edit.shots, cuts: edit.cuts, duration: edit.duration, vibe: design.vibe });
  const proxyUrl = edit.proxy ? `/files/${project.id}/${edit.proxy.file}` : `/files/${project.id}/${encodeURIComponent(project.source.file)}`;
  const { html } = buildEditHtml({
    timeline,
    duration: edit.duration,
    beats: edit.beats,
    music: track ? { src: `/sounds-media/${encodeURIComponent(track.file)}` } : null,
    design,
    videoSrcFor: () => proxyUrl,
    mediaStartFor: (item) => (edit.proxy ? edit.proxy.offsets[item.index] : item.mediaStart),
    assetBase: "/studio-assets/",
    runtimeSrc: "/vendor/hyperframe-runtime.js",
  });
  res.type("html").set("Cache-Control", "no-store").send(html);
});

// ---------- sounds ----------

app.use("/sounds-media", express.static(SOUNDS_DIR));

const soundUpload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      await fs.mkdir(SOUNDS_DIR, { recursive: true });
      cb(null, SOUNDS_DIR);
    },
    filename: (_req, file, cb) => cb(null, `${newProjectId()}${path.extname(file.originalname).toLowerCase() || ".mp3"}`),
  }),
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith("audio/") || AUDIO_EXT.test(file.originalname)),
});

app.get("/api/sounds", handle(() => listTracks()));

app.post("/api/sounds/upload", soundUpload.array("tracks", 100), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "Please choose audio files (MP3, WAV, M4A…)." });
  const added = [];
  for (const file of req.files) added.push(await addTrack({ file: file.filename, name: file.originalname }));
  res.status(201).json(added);
});

app.post("/api/sounds/import-folder", handle(async (req) => {
  const folder = String(req.body.path || "").trim().replace(/^~(?=$|\/)/, os.homedir());
  if (!folder) throw new Error("Type the folder's path, like ~/Music/Reels");
  const stat = await fs.stat(folder).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("Couldn't find that folder.");
  const added = await importFolder(folder);
  return { added: added.length };
}));

/** Add pictures or PDFs to a project (a link import, or more after an upload). Used by the next analysis. */
const materialUpload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      const dir = materialsDir(req.params.id);
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}${path.extname(file.originalname).toLowerCase()}`),
  }),
  fileFilter: (_req, file, cb) => cb(null, isMaterial(file)),
  limits: { fileSize: 100 * 1024 * 1024 },
});
app.post(
  "/api/projects/:id/materials",
  async (req, res, next) => ((await loadProject(req.params.id)) ? next() : res.status(404).json({ error: "Project not found" })),
  materialUpload.array("materials", 20),
  handle(async (req) => {
    const project = await loadProject(req.params.id);
    if (!req.files?.length) throw new Error("Choose pictures or PDFs to add.");
    project.materials = [...(project.materials || []), ...materialRecords(req.files)];
    await saveProject(project);
    return { materials: project.materials };
  }),
);

/** A song from a link (YouTube, SoundCloud, TikTok, anything yt-dlp reads): its audio goes into the library. */
app.post("/api/sounds/import-link", handle(async (req) => {
  const url = String(req.body.url || "").trim();
  if (!isLink(url)) throw new Error("Paste a link to the song, like a YouTube or SoundCloud URL.");
  const bin = ytDlpPath();
  if (!bin) throw new Error("Downloading music from links needs yt-dlp. Install it with: brew install yt-dlp");
  const scratch = path.join(os.tmpdir(), `clipstudio-sound-${Date.now().toString(36)}`);
  await fs.mkdir(scratch, { recursive: true });
  try {
    let out;
    try {
      out = await run(bin, ["--no-playlist", "--no-warnings", "--no-progress", "-f", "ba[ext=m4a]/ba/b", "-o", path.join(scratch, "audio.%(ext)s"), "--dump-single-json", "--no-simulate", url]);
    } catch (err) {
      const line = String(err.message).split("\n").find((l) => l.startsWith("ERROR:"));
      throw new Error(line ? `Couldn't download that: ${line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, "").slice(0, 200)}` : "Couldn't download that link.");
    }
    const got = (await fs.readdir(scratch)).find((n) => n.startsWith("audio.") && !/\.(part|ytdl)$/.test(n));
    if (!got) throw new Error("The download finished, but no audio came out of it.");
    let info = {};
    try {
      info = JSON.parse(out);
    } catch {
      // the name is a nice-to-have
    }
    const file = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}.m4a`;
    await fs.mkdir(SOUNDS_DIR, { recursive: true });
    try {
      await run(FFMPEG, ["-y", "-loglevel", "error", "-i", path.join(scratch, got), "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", path.join(SOUNDS_DIR, file)]);
    } catch (err) {
      await fs.rm(path.join(SOUNDS_DIR, file), { force: true });
      throw new Error(/matches no streams/i.test(err.message) ? "That link has no sound to save." : "Couldn't convert that audio.");
    }
    const name = [info.artist || info.uploader, info.track || info.title].filter(Boolean).join(" — ") || "Linked track";
    return addTrack({ file, name, source: "link" });
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}));

app.patch("/api/sounds/:trackId", handle((req) => renameTrack(req.params.trackId, req.body.name)));
app.delete("/api/sounds/:trackId", handle(async (req) => {
  await removeTrack(req.params.trackId);
  return { ok: true };
}));

/** Apply one look (everything but the per-clip crop) to every clip in a project. */
app.post("/api/projects/:id/design-all", withProject(async (req, project) => {
  const { cropX: _crop, ...look } = req.body.design || {};
  for (const clip of project.clips || []) clip.design = normalizeDesign({ ...clipDesign(clip), ...look });
  await saveProject(project);
  return project;
}));

app.post("/api/projects/:id/clips/:clipId/cancel", withProject((req, project) => {
  const clip = findClip(project, req.params.clipId);
  if (!cancelRender(project, clip.id)) throw new Error("This clip isn't rendering.");
  return clip;
}));

app.post("/api/projects/:id/render-all", withProject((req, project) => {
  if (project.status !== "ready") throw new Error("Clips aren't ready yet.");
  for (const clip of project.clips) {
    if (isRendering(project, clip.id)) continue;
    clip.design = designFrom(clip, req.body);
    queueRender(project, clip.id, { design: clip.design });
  }
  return project;
}));

app.post("/api/projects/:id/cancel-all", withProject((_req, project) => {
  cancelAllRenders(project);
  return project;
}));

// ---------- scheduler ----------

/** Every clip with a finished render, across all projects — the scheduler's review queue. */
app.get("/api/library", handle(async () => {
  const posts = await listPosts();
  const items = [];
  for (const project of await listProjects()) {
    for (const clip of project.clips || []) {
      const render = finishedRender(clip);
      if (!render) continue;
      items.push({
        projectId: project.id,
        projectName: project.name,
        clipId: clip.id,
        title: clip.title,
        postTitle: clip.postTitle,
        caption: clip.caption,
        hashtags: clip.hashtags,
        score: clip.score,
        // The rendered file's own length when we've measured it (tightening and a stitched hook change it).
        duration: render.duration ?? +(clip.end - clip.start).toFixed(1),
        file: render.file,
        style: render.style,
        qa: render.qa ?? null,
        renderedAt: render.renderedAt,
        scheduledCount: posts.filter((p) => p.projectId === project.id && p.clipId === clip.id).length,
      });
    }
    for (const edit of project.edits || []) {
      const render = finishedRender(edit);
      if (!render) continue;
      // Each edit engine keeps its label and length in a different place.
      const label =
        edit.engine === "hf" ? `${HF_STYLES[edit.design.style]?.label || "HyperFrames"} edit` : edit.engine === "dope" ? "Director edit" : `${VIBES[edit.design.vibe]?.label || "Dope"} edit`;
      const duration = render.duration ?? (edit.engine === "dope" ? await dopePlanLength(edit.id) : (edit.duration ?? edit.plan?.duration ?? null));
      items.push({
        kind: "edit",
        projectId: project.id,
        projectName: project.name,
        clipId: edit.id,
        title: edit.design.title || edit.plan?.title || label,
        postTitle: edit.design.title || edit.plan?.title || "",
        caption: "",
        hashtags: [],
        score: null, // edits have no viral score
        duration: Number.isFinite(duration) ? duration : null,
        file: render.file,
        style: edit.design.style || edit.design.vibe || null,
        qa: render.qa ?? null,
        renderedAt: render.renderedAt,
        scheduledCount: posts.filter((p) => p.projectId === project.id && p.clipId === edit.id).length,
      });
    }
  }
  return items.sort((a, b) => (b.renderedAt || "").localeCompare(a.renderedAt || ""));
}));

app.get("/api/accounts", handle(() => listAccounts()));
app.post("/api/accounts", handle((req) => addAccount(req.body)));
app.delete("/api/accounts/:accountId", handle(async (req) => {
  await removeAccount(req.params.accountId);
  return { ok: true };
}));

// ---------- intentional reels: what to ask him on camera (lib/intentional.js) ----------
app.get("/api/intentional", handle(() => listQuestions()));
app.post("/api/intentional/generate", handle(async (req) => ({ added: await generateQuestions({ count: Math.min(15, Math.max(3, Number(req.body?.count) || 8)), note: req.body?.note }), ...(await listQuestions()) })));
app.patch("/api/intentional/:id", handle((req) => setQuestionStatus(req.params.id, req.body?.status)));
app.delete("/api/intentional/:id", handle((req) => removeQuestion(req.params.id)));

// ---------- who the clips are for (lib/audience.js) ----------
const audienceUpload = multer({ dest: path.join(os.tmpdir(), "clipstudio-audience"), limits: { fileSize: 40 * 1024 * 1024 } });

app.get("/api/audience", handle(() => getAudience()));
app.delete("/api/audience", handle(() => clearAudience()));

/** Hand it a workshop deck, a client call transcript or pasted text; it reads it once and folds it into the brief. */
app.post("/api/audience/sources", audienceUpload.single("file"), handle(async (req) => {
  const note = String(req.body?.note || "").slice(0, 300);
  if (req.file) {
    const name = req.file.originalname;
    if (!/\.(vtt|srt|txt|md|docx|pdf)$/i.test(name)) throw new Error("Use a transcript (.vtt, .srt, .txt), a Word file (.docx) or a PDF.");
    const brief = await ingestSource({ name, ...(await readSourceAs(req.file.path, name)), note });
    return { brief, ...(await getAudience()) };
  }
  const text = String(req.body?.text || "");
  const name = String(req.body?.name || "Pasted notes").slice(0, 120);
  return { brief: await ingestSource({ name, text, note }), ...(await getAudience()) };
}));

/** multer saves uploads without an extension; readSource picks its parser from one, so give it the original name. */
async function readSourceAs(tmpPath, originalName) {
  const withExt = `${tmpPath}${path.extname(originalName).toLowerCase()}`;
  await fs.rename(tmpPath, withExt);
  try {
    return await readSourceParts(withExt);
  } finally {
    await fs.rm(withExt, { force: true });
  }
}

// ---------- auto-post: one clip a day, on its own (lib/autopost.js) ----------
app.get("/api/autopost", handle(() => autoPostSettings()));
app.put("/api/autopost", handle((req) => updateAutoPost(req.body || {})));
app.post("/api/autopost/run", handle(async () => {
  const result = await runAutoPost({ force: true });
  return { ...result, settings: await autoPostSettings() };
}));

app.get("/api/posts", handle(() => listPosts()));

app.post("/api/posts", handle(async (req) => {
  const { projectId, clipId, accountIds, scheduledAt, caption } = req.body;
  const project = await loadProject(String(projectId || ""));
  if (!project) throw new Error("Project not found");
  const item = findItem(project, clipId);
  if (!item) throw new Error("Clip not found");
  const render = finishedRender(item);
  if (!render) throw new Error("Render this before scheduling it.");
  // Queuing a clip to post says "I like this one" as clearly as a heart does.
  if (!item.engine && Number.isFinite(item.start)) {
    projectWords(project)
      .then((words) => recordClipFeedback({ project, clip: item, words, verdict: "like", source: "scheduled" }))
      .catch((err) => console.error("Clip taste not recorded:", err.message));
  }
  return createPost({
    projectId: project.id,
    projectName: project.name,
    clipId: item.id,
    title: item.title ?? (item.design?.title || `${VIBES[item.design?.vibe]?.label || "Dope"} edit`),
    file: render.file,
    duration: +(item.duration ?? item.end - item.start).toFixed(1),
    caption,
    accountIds,
    scheduledAt,
    clip: {
      title: item.title ?? null,
      score: item.score ?? null,
      ratings: item.ratings ?? null,
      // The words the clip opens on (its pinned or picked hook, else its first sentence).
      hook: await openingWords(project, item),
      payoff: item.payoff ?? null,
      reason: item.reason ?? null,
      duration: +(render.duration ?? item.duration ?? item.end - item.start).toFixed(1),
      style: item.design?.style ?? null,
      reviewScore: render.review?.score ?? null,
      kind: item.engine ? "edit" : "clip",
    },
  });
}));

/** The first ~16 words a clip opens on, for the post's snapshot. Edits (no transcript range) get none. */
async function openingWords(project, item) {
  if (!Number.isFinite(item.start)) return null;
  try {
    const words = await projectWords(project);
    const from = Number.isFinite(item.hook?.start) ? item.hook.start : item.start;
    const opening = words.filter((w) => w.start >= from - 0.05).slice(0, 16).map((w) => w.text).join(" ");
    return opening || null;
  } catch {
    return null;
  }
}

/**
 * Rewrite the headline and posting copy on a video's clips (or one clip), from the words each clip plays. The cuts
 * and ranges stay as they are; a clip that is already rendered needs re-rendering for the new headline to show.
 */
app.post("/api/projects/:id/clips/retitle", withProject(async (req, project) => {
  if (!hasClaudeKey()) throw new Error("Add your Claude key to rewrite titles.");
  const only = typeof req.body.clipId === "string" ? [findClip(project, req.body.clipId)] : project.clips || [];
  if (!only.length) throw new Error("This video has no clips yet.");
  const note = String(req.body.note || "").slice(0, 300);
  const words = await projectWords(project);
  const done = [];
  for (const clip of only) {
    try {
      const fresh = await retitleClip({ project, clip, words, note });
      const before = clip.title;
      Object.assign(clip, fresh);
      done.push({ id: clip.id, before, after: clip.title });
    } catch (err) {
      console.error(`[${project.id}/${clip.id}] retitle`, err.message);
    }
  }
  await saveProject(project);
  return { rewritten: done, clips: project.clips };
}));

// ---------- re-pick: fresh clips with the current engine ----------

/**
 * Pick a video's clips again with everything the engine knows now, check each pick's words before spending a render
 * on it, and render the ones that hold up. Clips the creator shaped on the timeline stay and re-render as they are;
 * the other old clips move to project.archivedClips. Runs in the background; project.repick carries the status.
 */
app.post("/api/projects/:id/clips/repick", withProject(async (req, project) => {
  if (project.status !== "ready" || !project.segments?.length) throw new Error("Wait for this video to finish processing.");
  if (!hasClaudeKey()) throw new Error("Add your Claude key to pick clips again.");
  // Only a run on THIS process is really in flight; a "picking" flag left behind by a restart must not block a retry.
  if (repicking.has(project.id)) throw new Error("Already picking this video's clips again.");
  if (req.body.mode !== "add" && (project.clips || []).some((c) => ["queued", "rendering"].includes(c.render?.status))) throw new Error("Stop this video's renders first.");
  const max = Math.min(8, Math.max(2, Number(req.body.max) || 6));
  // "add" keeps every clip there is and only adds new ones that hold up; the default replaces the untouched ones.
  const add = req.body.mode === "add";
  project.repick = { status: "picking", message: add ? "Looking for more strong moments…" : "Picking the strongest moments again…", at: new Date().toISOString() };
  await saveProject(project);
  repicking.add(project.id);
  repickClips(project, { max, add })
    .finally(() => repicking.delete(project.id))
    .catch(async (err) => {
    console.error(`[${project.id}] re-pick`, err);
    project.repick = { status: "error", message: describeClaudeError(err).replace(", so these are demo picks", ""), at: new Date().toISOString() };
    await saveProject(project);
  });
  return project.repick;
}));

const repicking = new Set();

// A thought ends on a full stop or, when the transcript came back without punctuation, on a real pause.
const endsThought = (words, i) => /[.?!]$/.test(String(words[i].text)) || (words[i + 1] ? words[i + 1].start - words[i].end >= 0.45 : true);

/** Where the last complete thought inside a range finishes, so a clip stops on it instead of trailing off. */
function lastCompleteThought(words, start, end) {
  const inside = words.filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05);
  if (inside.length < 8) return null;
  for (let k = inside.length - 2; k > inside.length * 0.5; k--) {
    const i = words.indexOf(inside[k]);
    if (endsThought(words, i)) return +(words[i].end + 0.3).toFixed(3);
  }
  return null;
}

/** Where the next complete thought starts, so a clip doesn't open halfway through a sentence. */
function nextThoughtStart(words, start, end) {
  const inside = words.filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05);
  for (let k = 0; k < inside.length * 0.4; k++) {
    const i = words.indexOf(inside[k]);
    if (endsThought(words, i) && words[i + 1]) return +(words[i + 1].start - 0.12).toFixed(3);
  }
  return null;
}

const SENSE_BLOCKERS = new Set(["broken_thought_at_cut", "incomplete_end", "weak_open", "no_payoff", "dangling_reference", "health_claim_risk"]);

async function repickClips(project, { max, add = false }) {
  const say = (message) => saveProject(Object.assign(project, { repick: { ...project.repick, message } }));
  const words = await projectWords(project);
  const { duration, width, height } = project.source;

  const kept = [];
  for (const clip of project.clips || []) if (add || (await readSavedDocument(project.id, clip.id))) kept.push(clip);
  const taken = kept.map((c) => `${c.start.toFixed(1)}–${c.end.toFixed(1)}s`).join(", ");
  const earlier = (project.repick?.rejected || []).map((r) => `"${r.title}" (${r.why})`).join("; ");

  const analysis = await analyze({
    segments: project.segments,
    duration,
    width,
    height,
    notes: project.options?.notes,
    materials: await materialBlocks(project),
    focus: `Pick this video's clips from scratch, stricter than before: only moments that are one complete idea, open with a hook, and end on a clear payoff.${taken ? ` These ranges are already clips${add ? "" : " the creator edited by hand"}; new clips must not overlap them: ${taken}.` : ""}${earlier ? ` Earlier picks that didn't hold up, and why — don't repeat those mistakes: ${earlier}.` : ""}`,
    ...clipLengths(duration),
    minClips: 2,
    maxClips: 8,
  });
  const candidates = resolveClips(analysis.clips, project.segments, duration, { maxClips: 8 }).filter((c) => !kept.some((k) => c.start < k.end - 1 && c.end > k.start + 1));

  // The words each pick will actually play, read like a viewer before anything renders.
  const silences = await readSilences(project);
  const levels = await readLevels(project);
  const checked = [];
  for (const [i, c] of candidates.entries()) {
    await say(`Checking pick ${i + 1} of ${candidates.length} makes sense on its own…`);
    const design = normalizeDesign({ style: "podcast" });
    const stills = (await sourceCuts(project, c.start, c.end).catch(() => null))?.stills;
    const check = async () => {
      const plan = planClip(c, words, design, { analysis: project.analysis, silences, levels, stills });
      const sense = await sensePass({ plan, clip: c }).catch((err) => (console.error(`[${project.id}] pre-check`, err.message), null));
      // Scored exactly the way the render review will score it (cuts through words, meaning, penalties), so a pick
      // that passes here passes after rendering too — with a little headroom, since the picture is still unseen.
      const findings = [...preflight(plan, words), ...(sense?.issues || []).map((x) => ({ ...x, source: "sense", cut: x.cut > 0 ? x.cut : undefined }))];
      const merged = sense ? scoreReview({ findings, sense, picture: null }) : null;
      const issues = merged?.issues || findings;
      const senseScore = merged?.score ?? null;
      const serious = issues.filter((x) => SENSE_BLOCKERS.has(x.kind) && x.kind !== "health_claim_risk");
      const blocked = !merged || !merged.pass || senseScore < 65 || serious.filter((x) => x.severity === "major").length >= 2;
      return { plan, sense, issues, senseScore, blocked };
    };
    let result = await check();
    // Most blocked picks are fixable at the edges: a sentence broken at a cut (put that stretch of talk back), an
    // ending that trails off (end on the last complete thought) or an opening mid-sentence (start on the next one).
    if (result.blocked && result.sense) {
      const fixes = repairsFor({ issues: result.issues }, result.plan, c, design);
      let changed = false;
      if (fixes?.protect?.length > (c.protect || []).length) {
        c.protect = fixes.protect;
        if (fixes.wordFixes) c.wordFixes = fixes.wordFixes;
        changed = true;
      }
      const kinds = new Set(result.issues.filter((x) => x.severity !== "minor").map((x) => x.kind));
      if (kinds.has("incomplete_end") || kinds.has("no_payoff")) {
        const end = lastCompleteThought(words, c.start, c.end);
        if (end && end < c.end - 0.2 && end - c.start >= 15) {
          c.end = end;
          changed = true;
        }
      }
      if (kinds.has("weak_open")) {
        const start = nextThoughtStart(words, c.start, c.end);
        if (start && start > c.start + 0.2 && c.end - start >= 15) {
          c.start = start;
          if (c.parts?.length) c.parts = c.parts.filter((p) => p.end > start).map((p) => ({ ...p, start: Math.max(p.start, start) }));
          changed = true;
        }
      }
      if (changed) {
        await say(`Tidying the edges of pick ${i + 1} and checking it again…`);
        result = await check();
      }
    }
    checked.push({ clip: c, ...result });
  }
  const ranked = [...checked].sort((a, b) => (b.senseScore ?? 70) * 0.6 + b.clip.score * 0.4 - ((a.senseScore ?? 70) * 0.6 + a.clip.score * 0.4));
  let passing = ranked.filter((x) => !x.blocked).slice(0, add ? max : Math.max(0, max - kept.length));
  // A video with nothing left to show is worse than a video with its two best moments marked "needs your review":
  // the creator can still watch them, trim them in the editor, or throw them out themselves.
  if (!passing.length && !kept.length && ranked.length) passing = ranked.slice(0, 2).map((x) => ({ ...x, needsReview: true }));

  const archived = (project.clips || []).filter((c) => !kept.includes(c)).map((c) => ({ ...c, archivedAt: new Date().toISOString() }));
  let next = Math.max(0, ...[...(project.clips || []), ...(project.archivedClips || [])].map((c) => Number(String(c.id).replace(/\D/g, "")) || 0)) + 1;
  const fresh = passing.map(({ clip, senseScore, issues, needsReview }) => ({
    ...clip,
    id: `clip-${next++}`,
    design: { style: "podcast", aspect: "9:16" },
    ...(needsReview ? { needsReview: true } : {}),
    precheck: { score: senseScore, notes: issues.filter((x) => x.severity !== "minor").map((x) => x.note).slice(0, 4), at: new Date().toISOString() },
  }));
  const rejected = checked
    .filter((x) => !passing.includes(x))
    .map((x) => ({ title: x.clip.title, start: x.clip.start, end: x.clip.end, score: x.senseScore, why: (x.issues.find((i) => i.severity === "critical") || x.issues.find((i) => i.severity === "major") || { note: x.blocked ? "scored too low" : "a stronger pick took its place" }).note }));
  project.archivedClips = [...(project.archivedClips || []), ...archived];
  project.clips = [...kept, ...fresh];
  project.clips.forEach((c, i) => (c.rank = i + 1));
  if (!add) project.analysis = packAnalysis(analysis, project.segments);
  const dropped = checked.length - passing.length;
  const shaky = passing.filter((x) => x.needsReview).length;
  project.repick = { status: "done", at: new Date().toISOString(), message: `${fresh.length} fresh clip${fresh.length === 1 ? "" : "s"}${kept.length && !add ? ` + ${kept.length} you edited` : ""} rendering${dropped ? ` · ${dropped} pick${dropped === 1 ? "" : "s"} didn't hold up and were left out` : ""}${shaky ? " · nothing cleared the bar on this video, so its best moments are here for you to look at" : ""}`, rejected };
  await saveProject(project);
  for (const clip of add ? fresh : project.clips) {
    try {
      queueRender(project, clip.id, { design: designFrom(clip) });
    } catch (err) {
      console.error(`[${project.id}/${clip.id}] re-pick render`, err.message);
    }
  }
}

// ---------- full-video edits (lib/longedit.js) ----------

/** Plan (or re-plan) the full video as a YouTube video or a presentation; it renders when the plan is ready. */
app.post("/api/projects/:id/long", withProject(async (req, project) => {
  if (project.long && ["queued", "rendering"].includes(project.long.render?.status)) throw new Error("Stop the current render first.");
  if (!project.segments?.length) throw new Error("Wait for this video to finish transcribing.");
  if (!hasClaudeKey()) throw new Error("Add your Claude key to edit the full video.");
  startLongEdit(project, req.body.design || {});
  return project.long;
}));
app.post("/api/projects/:id/long/render", withProject(async (_req, project) => queueLongRender(project)));
app.post("/api/projects/:id/long/cancel", withProject(async (_req, project) => {
  cancelRender(project, "long");
  return project.long;
}));

// ---------- clip taste (lib/cliptaste.js) ----------

/** ♥ / ✕ on a picked clip: { verdict: "like" | "pass" | null, reason?, more? }. A like also looks for more like it. */
app.post("/api/projects/:id/clips/:clipId/feedback", withProject(async (req, project) => {
  const clip = findClip(project, req.params.clipId);
  const verdict = ["like", "pass"].includes(req.body.verdict) ? req.body.verdict : null;
  const reason = typeof req.body.reason === "string" ? req.body.reason : clip.feedback?.reason || "";
  await recordClipFeedback({ project, clip, words: await projectWords(project).catch(() => null), verdict, reason });
  if (verdict) clip.feedback = { verdict, reason: reason.trim().slice(0, 300), at: new Date().toISOString() };
  else {
    delete clip.feedback;
    if (clip.moreLike?.status !== "searching") delete clip.moreLike;
  }
  await saveProject(project);
  if (verdict === "like" && req.body.more !== false && !clip.moreLike && project.status === "ready" && hasClaudeKey()) startMoreLike(project, clip);
  return clip;
}));

app.post("/api/projects/:id/clips/:clipId/more-like-this", withProject(async (req, project) => {
  const clip = findClip(project, req.params.clipId);
  startMoreLike(project, clip);
  return clip;
}));

/** Remove a clip that isn't rendering (its render file, if any, stays on disk until the project is deleted). */
app.delete("/api/projects/:id/clips/:clipId", withProject(async (req, project) => {
  const clip = findClip(project, req.params.clipId);
  if (["queued", "rendering"].includes(clip.render?.status)) throw new Error("Stop this clip's render first.");
  const i = project.clips.indexOf(clip);
  project.clips.splice(i, 1);
  project.clips.forEach((c, n) => (c.rank = n + 1));
  await saveProject(project);
  return { ok: true, clips: project.clips.length };
}));

app.get("/api/clip-taste", handle(async () => clipTaste()));
app.post("/api/clip-taste/learn", handle(async () => ({ profile: await learnTaste() })));

/**
 * Search the clip's video for up to 3 more clips in the same vein and add them after the others. Runs in the
 * background; clip.moreLike carries { status: "searching" | "done" | "error", added, message }.
 */
function startMoreLike(project, clip) {
  if (clip.moreLike?.status === "searching") return;
  if (project.status !== "ready" || !project.segments?.length) throw new Error("Wait for this video to finish processing.");
  if (!hasClaudeKey()) throw new Error("Add your Claude key to find more clips like this.");
  clip.moreLike = { status: "searching", at: new Date().toISOString() };
  saveProject(project);
  findMoreLike(project, clip).catch((err) => console.error(`[${project.id}/${clip.id}] more like this:`, err.message));
}

async function findMoreLike(project, clip) {
  try {
    const words = await projectWords(project);
    const { duration, width, height } = project.source;
    const analysis = await analyze({
      segments: project.segments,
      duration,
      width,
      height,
      notes: project.options?.notes,
      focus: moreLikeThisNote(project, clip, words),
      materials: await materialBlocks(project),
      ...clipLengths(duration),
      minClips: 1,
      maxClips: 3,
    });
    // A new clip may graze a neighbour by its padding; it's nudged off it. Anything more is the same moment.
    const overlaps = (c) => {
      for (const o of project.clips || []) {
        if (c.start >= o.end || c.end <= o.start) continue;
        if (o.end - c.start <= 1) c.start = +(o.end + 0.02).toFixed(3);
        else if (c.end - o.start <= 1) c.end = +(o.start - 0.02).toFixed(3);
        else return true;
        if (c.parts?.length) {
          c.parts[0].start = Math.max(c.parts[0].start, c.start);
          c.parts.at(-1).end = Math.min(c.parts.at(-1).end, c.end);
        }
      }
      return c.end - c.start < 3;
    };
    let next = Math.max(0, ...(project.clips || []).map((c) => Number(String(c.id).replace(/\D/g, "")) || 0)) + 1;
    const added = resolveClips(analysis.clips, project.segments, duration, { maxClips: 3 })
      .filter((c) => !overlaps(c))
      .map((c) => ({ ...c, id: `clip-${next++}`, likeOf: clip.id }));
    // Added in place: renders running right now hold these same clip objects.
    project.clips.push(...added);
    project.clips.forEach((c, i) => (c.rank = i + 1));
    clip.moreLike = { status: "done", added: added.map((c) => c.id), at: new Date().toISOString(), message: added.length ? `Found ${added.length} more like this` : "No other moments in this video match it" };
  } catch (err) {
    console.error(`[${project.id}/${clip.id}] more like this:`, err.message);
    clip.moreLike = { status: "error", at: new Date().toISOString(), message: describeClaudeError(err).replace(", so these are demo picks", "") };
  }
  await saveProject(project);
}

/** How posted clips performed, joined to why they were picked (lib/performance.js). */
app.get("/api/performance", handle(async () => {
  const rows = await postPerformance();
  return { posts: rows, signals: factorSignals(rows) };
}));

app.patch("/api/posts/:postId", handle((req) => updatePost(req.params.postId, req.body)));
app.patch("/api/posts/:postId/targets/:accountId", handle((req) => setPublished(req.params.postId, req.params.accountId, Boolean(req.body.published))));
app.delete("/api/posts/:postId", handle(async (req) => {
  await deletePost(req.params.postId);
  return { ok: true };
}));

// Not under /api/scheduler — that prefix belongs to the Instagram module in scheduler/.
app.get("/api/schedule/summary", handle(() => scheduleSummary()));

// ---------- study ----------

app.use("/study-media", express.static(STUDY_MEDIA_DIR));

const studyUpload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      await fs.mkdir(STUDY_MEDIA_DIR, { recursive: true });
      cb(null, STUDY_MEDIA_DIR);
    },
    filename: (_req, file, cb) => cb(null, `${newProjectId()}${path.extname(file.originalname).toLowerCase() || ".mp4"}`),
  }),
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.originalname)),
});

app.get("/api/study", handle(() => getStudy()));
app.post("/api/study/profiles", handle((req) => createProfile(req.body.name)));
app.patch("/api/study/profiles/:profileId", handle((req) => renameProfile(req.params.profileId, req.body.name)));
app.delete("/api/study/profiles/:profileId", handle(async (req) => {
  await deleteProfile(req.params.profileId);
  return getStudy();
}));
app.post("/api/study/active", handle(async (req) => {
  await setActiveProfile(req.body.profileId);
  return getStudy();
}));

app.post("/api/study/references", handle((req) => {
  const url = String(req.body.url || "").trim();
  if (!isLink(url)) throw new Error("Paste a full video link, like https://youtube.com/watch?v=…");
  if (!ytDlpPath()) throw new Error("Video links need yt-dlp. Install it with: brew install yt-dlp");
  return addLinkReference({ url, profileId: req.body.profileId });
}));

app.post("/api/study/references/upload", studyUpload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Please upload a video file." });
  res.status(201).json(await addFileReference({ file: req.file.filename, originalName: req.file.originalname, profileId: req.body.profileId }));
});

app.patch("/api/study/references/:refId", handle((req) => saveFeedback(req.params.refId, req.body)));
app.post("/api/study/references/:refId/analyze", handle(async (req) => {
  const reference = (await getStudy()).references.find((r) => r.id === req.params.refId);
  if (reference?.kind === "link" && !ytDlpPath()) throw new Error("Analyzing a link needs yt-dlp. Install it with: brew install yt-dlp");
  return analyzeReference(req.params.refId);
}));
/** HyperFrames editing styles, tuned by the studied reels they were modeled on. */
app.get("/api/styles", handle(async () => styleSummaries(await measuredReferences())));
app.delete("/api/study/references/:refId", handle(async (req) => {
  await removeReference(req.params.refId);
  return { ok: true };
}));

// ---------- startup ----------

// Anything mid-flight when the server stopped can't resume; flag it so the UI offers a retry.
for (const project of await listProjects()) {
  let dirty = false;
  if (BUSY_STATUSES.includes(project.status)) {
    Object.assign(project, { status: "error", message: "Processing failed", error: "Interrupted when the server restarted." });
    dirty = true;
  }
  for (const item of [...(project.clips || []), ...(project.edits || [])]) {
    if (RENDER_BUSY.includes(item.render?.status)) {
      item.render = item.render.previous
        ? { ...item.render.previous, message: "Re-render interrupted — kept the previous version" }
        : { ...item.render, status: "error", message: "Render failed", error: "Interrupted when the server restarted." };
      dirty = true;
    }
  }
  for (const edit of project.edits || []) {
    if (edit.status === "scanning") {
      Object.assign(edit, { status: "error", message: "Couldn't build this edit", error: "Interrupted when the server restarted — create it again." });
      dirty = true;
    }
  }
  if (project.captions?.status === "running") {
    project.captions = { ...project.captions, status: "error", error: "Interrupted when the server restarted." };
    dirty = true;
  }
  if (dirty) await saveProject(project);
  // Older projects get their working copy and subject tracking in the background.
  if (project.status === "ready") warmProject(project);
}

// Check for posts whose time has come.
setInterval(() => tick().catch((err) => console.error("Scheduler tick failed:", err)), 15_000);
startAutoPost();
await tick();
instagram.start(); // token refresh + insights in the background
await editsPlanner.start(); // clears planning jobs interrupted by a restart

// Watched YouTube channels are checked shortly after start and every 15 minutes.
startChannelWatch(importChannelVideo);

app.listen(PORT, () => {
  console.log(`\n  HBA Content Backend → http://localhost:${PORT}`);
  console.log(`  Clip analysis: ${hasClaudeKey() ? "Claude (claude-opus-5)" : "demo heuristic — add ANTHROPIC_API_KEY to .env for Claude"}\n`);
});
