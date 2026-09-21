// Upload → probe → transcribe → analyze, and one render queue for clips and edits.
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AUDIO_CLEANUP_VERSION, probe, cutSegment, extractPoster, makeWorkingCopy, normalizeMusicBed, recleanWorkingAudio } from "./media.js";
import { trackSubject } from "./subject.js";
import { trackSpeakers } from "./speaker.js";
import { WORK_FILE, cleanAudioFile, hasWorkingCopy, workAudioMarker, workingFile } from "./work.js";
import { transcribe, segmentWords } from "./transcribe.js";
import { analyze, clipLengths, describeClaudeError, packAnalysis, resolveClips } from "./analyze.js";
import { materialBlocks } from "./materials.js";
import { findSilences } from "./silence.js";
import { mixMusicBed } from "./bed.js";
import { correctWords } from "./corrections.js";
import { alignWords, alignerAvailable } from "./align.js";
import { measureLevels } from "./levels.js";
import { sourceCuts } from "./sourcecuts.js";
import { formatMoneyText } from "./money.js";
import { repairsFor, reviewClip } from "./review.js";
import { masterLoudness } from "./master.js";
import { faceBand } from "./facezone.js";
import { documentPlan, readSavedDocument } from "../editor/document.js";
import { applyEditorLayers } from "../editor/director/render.js";
import { MUSIC_TAIL, buildComposition, normalizeDesign } from "./compose.js";
import { clipMusic, mapFocus, planClip } from "./clipplan.js";
import { normalizeEditDesign, planTimeline, writeEditComposition } from "./edit.js";
import { renderComposition } from "./render.js";
import { checkRender, describeQa } from "./qa.js";
import { getTrack, SOUNDS_DIR } from "./sounds.js";
import { prepareDopeRender } from "./dope.js";
import { writeHfEditComposition } from "./hfedit.js";
import { createHfEdit, normalizeHfDesign } from "./hfplan.js";
import { planLongEdit, renderLongEdit } from "./longedit.js";
import { EMPHASIS_VERSION, emphasisPlan } from "./emphasis.js";
import { applyBigWords } from "./behind.js";
import { burnedInCaptions } from "./sourcecaptions.js";
import { loadProject, projectDir, saveProject } from "./store.js";
import { downloadVideo, fetchInfo } from "./youtube.js";

export const BUSY_STATUSES = ["queued", "downloading", "probing", "preparing", "transcribing", "analyzing"];
export const RENDER_BUSY = ["queued", "rendering"];

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

/** Make the working copy (renamed into place when complete). A failure just means previews use the original. */
async function buildWorkingCopy(project, { onProgress, signal } = {}) {
  const dir = projectDir(project.id);
  const tmp = path.join(dir, `work-${Date.now().toString(36)}.tmp.mp4`);
  try {
    await makeWorkingCopy(path.join(dir, project.source.file), tmp, {
      duration: project.source.duration,
      height: project.source.height,
      hasAudio: project.source.hasAudio,
      hdr: Boolean(project.source.hdr),
      cleanAudio: true,
      onProgress,
      signal,
    });
    await fs.rename(tmp, path.join(dir, WORK_FILE));
    await fs.writeFile(workAudioMarker(project, AUDIO_CLEANUP_VERSION), "");
  } catch (err) {
    await fs.rm(tmp, { force: true });
    if (signal?.aborted) throw err;
    console.error(`[${project.id}] working copy failed; using the original:`, err.message.split("\n").pop());
  }
}

// Projects imported before working copies existed get one in the background, one at a time.
const workQueue = [];
let workBusy = false;

const workAudioCurrent = (project) => !project.source?.hasAudio || existsSync(workAudioMarker(project, AUDIO_CLEANUP_VERSION));

export function ensureWorkingCopy(project) {
  if (!project.source?.file || (hasWorkingCopy(project) && workAudioCurrent(project)) || workQueue.includes(project.id)) return;
  workQueue.push(project.id);
  pumpWorkQueue();
}

async function pumpWorkQueue() {
  if (workBusy) return;
  workBusy = true;
  while (workQueue.length) {
    const project = await loadProject(workQueue.shift()).catch(() => null);
    if (project?.status === "ready" && !hasWorkingCopy(project)) {
      const started = Date.now();
      await buildWorkingCopy(project);
      console.log(`[${project.id}] working copy ready in ${Math.round((Date.now() - started) / 1000)}s`);
      precomputeFocus(project);
    } else if (project?.status === "ready" && !workAudioCurrent(project)) {
      await recleanWorkingCopy(project);
    }
  }
  workBusy = false;
}

/** A working copy made with an older cleanup chain gets its sound redone (picture copied, so it takes seconds). */
async function recleanWorkingCopy(project) {
  const dir = projectDir(project.id);
  const tmp = path.join(dir, `work-${Date.now().toString(36)}.tmp.mp4`);
  try {
    await recleanWorkingAudio(path.join(dir, project.source.file), path.join(dir, WORK_FILE), tmp);
    await fs.rename(tmp, path.join(dir, WORK_FILE));
    await fs.writeFile(workAudioMarker(project, AUDIO_CLEANUP_VERSION), "");
    console.log(`[${project.id}] working copy sound updated to cleanup v${AUDIO_CLEANUP_VERSION}`);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    console.error(`[${project.id}] sound cleanup update failed; keeping the old sound:`, err.message.split("\n").pop());
  }
}

/**
 * Where the subject is across a clip, as clip-relative [{ t, x }] (x 0–1 of the source width). Cached per clip
 * range; `compute: false` only reads the cache (for previews, which mustn't wait on tracking).
 */
export async function clipFocus(project, clip, { signal, compute = true } = {}) {
  // "-s1": paths made since framing learned to follow whoever is talking (lib/speaker.js).
  const file = path.join(projectDir(project.id), "focus", `${clip.id}-${Math.round(clip.start * 100)}-${Math.round(clip.end * 100)}-s1.json`);
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    // not tracked yet
  }
  if (!compute || !(project.source.width > project.source.height)) return null;
  // Previews and renders asking for the same clip at once share one tracking run.
  if (focusJobs.has(file)) return focusJobs.get(file);
  const job = (async () => {
    let focus = [];
    try {
      // Two or more people on screen: follow whoever is talking, cutting between them. Otherwise glide with the
      // main subject.
      const speakers = project.source.hasAudio
        ? await trackSpeakers(workingFile(project), path.join(projectDir(project.id), project.source.file), clip.start, clip.end, { signal })
        : null;
      if (speakers?.length) focus = speakers.map(({ t, x, cut }) => (cut ? { t, x, cut } : { t, x }));
      else {
        const track = await trackSubject(workingFile(project), clip.start, clip.end, { step: 1, signal });
        focus = track.map((p) => ({ t: Math.round((p.t - clip.start) * 1000) / 1000, x: p.x }));
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      console.error(`[${project.id}/${clip.id}] subject tracking failed:`, err.message.split("\n")[0]);
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(focus));
    return focus;
  })().finally(() => focusJobs.delete(file));
  focusJobs.set(file, job);
  return job;
}

const focusJobs = new Map(); // cache file → in-flight tracking
let focusChain = Promise.resolve();

/** Track every clip in the background, one project at a time, so previews come up already framed. */
export function precomputeFocus(project) {
  focusChain = focusChain.then(async () => {
    for (const clip of project.clips || []) await clipFocus(project, clip).catch(() => {});
  });
  return focusChain;
}

/** Background prep for an existing project: its working copy (then tracking), or tracking right away. */
export function warmProject(project) {
  if (!project.source?.file) return;
  if (hasWorkingCopy(project)) precomputeFocus(project);
  ensureWorkingCopy(project);
}

/** Redo a project's captions with a bigger speech model. Clips, titles and edits stay as they are. */
export async function retranscribeProject(projectId, quality) {
  const dir = projectDir(projectId);
  const scratch = path.join(dir, "captions-redo");
  try {
    const project = await loadProject(projectId);
    await fs.rm(scratch, { recursive: true, force: true });
    await fs.mkdir(scratch, { recursive: true });
    const words = await transcribe(workingFile(project), scratch, { language: project.options.language, quality });
    if (words.length < 3) throw new Error("No speech was found.");
    await fs.writeFile(path.join(dir, "words.json"), JSON.stringify(words));
    // Re-read so anything saved while transcribing (renders, edits) is kept.
    const latest = await loadProject(projectId);
    latest.options = { ...latest.options, captionQuality: quality };
    await saveProject(Object.assign(latest, { segments: segmentWords(words), captions: { status: "done", quality, words: words.length, at: new Date().toISOString() } }));
  } catch (err) {
    console.error(`[${projectId}] redoing captions failed:`, err.message);
    const latest = await loadProject(projectId).catch(() => null);
    if (latest) await saveProject(Object.assign(latest, { captions: { status: "error", quality, error: err.message.split("\n").pop().slice(0, 300) } }));
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

/** Do what the creator picked at upload: make the Dope edit, or give every clip their chosen style and format. */
/** Plan a full-video edit and render it as soon as the plan is ready. */
export function startLongEdit(project, design) {
  if (project.long?.status === "planning") throw new Error("This full-video edit is already being planned.");
  if (project.status !== "ready" && project.status !== "analyzing") throw new Error("Wait for this video to finish processing.");
  const run = planLongEdit(project, design)
    .then((long) => long.status === "ready" && queueLongRender(project))
    .catch((err) => console.error(`[${project.id}/long]`, err.message));
  return run;
}

async function applyIntent(project) {
  const intent = project.options?.intent;
  if (!intent) return;
  try {
    if (intent.mode === "long" && !project.long) {
      // Planning reads the whole talk with Claude; it runs alongside, so the next upload doesn't wait on it.
      startLongEdit(project, intent.design);
    } else if (intent.mode === "edit" && !(project.edits || []).length) {
      await createHfEdit(project, { design: intent.design, trackId: intent.trackId });
    } else if (intent.mode === "clips" && intent.design) {
      for (const clip of project.clips || []) clip.design ??= { ...intent.design };
      await saveProject(project);
    }
  } catch (err) {
    console.error(`[${project.id}] couldn't apply the upload choice:`, err.message);
  }
}

// Videos being processed right now (download → transcript → picks), so the creator can stop one.
const processing = new Map(); // projectId → AbortController

/**
 * Stop a video's processing: the download (or whatever stage it's in) is killed and the project is left "stopped",
 * ready to try again or delete. A video still waiting its turn is stopped before it starts.
 */
export function stopProcessing(project) {
  const controller = processing.get(project.id);
  if (controller) controller.abort();
  else if (BUSY_STATUSES.includes(project.status)) {
    Object.assign(project, { status: "stopped", message: "Stopped before it started", stopRequested: true });
    saveProject(project);
  }
  return project;
}

export async function processProject(project) {
  const dir = projectDir(project.id);
  if (project.stopRequested) {
    delete project.stopRequested;
    return;
  }
  const controller = new AbortController();
  const { signal } = controller;
  processing.set(project.id, controller);
  // Once stopped, late progress messages from a dying stage must not overwrite the stopped state.
  const update = (patch) => (signal.aborted ? Promise.resolve(project) : saveProject(Object.assign(project, patch)));

  try {
    // Linked videos (YouTube etc.) are downloaded first.
    if (project.source.url && !project.source.file) {
      await update({ status: "downloading", message: "Fetching video details…", error: null });
      const info = await fetchInfo(project.source.url, { signal });
      Object.assign(project.source, { info });
      await update({ name: info.title, message: "Downloading… 0%" });
      const onProgress = throttled((pct) => update({ message: `Downloading… ${pct}%` }), 700);
      project.source.file = await downloadVideo(project.source.url, dir, { onProgress, signal });
    }
    signal.throwIfAborted();
    const src = path.join(dir, project.source.file);

    await update({ status: "probing", message: "Reading video…", error: null });
    Object.assign(project.source, await probe(src));
    await extractPoster(src, path.join(dir, "poster.jpg"), Math.min(2, project.source.duration / 2)).catch(() => {});

    // A light copy for fast previews, analysis and tracking, with cleaned-up dialogue.
    await update({ status: "preparing", message: "Making a fast working copy… 0%" });
    await buildWorkingCopy(project, { signal, onProgress: throttled((f) => update({ message: `Making a fast working copy… ${Math.round(f * 100)}%` }), 1000) });
    signal.throwIfAborted();

    let words = [];
    if (project.source.hasAudio) {
      await update({ status: "transcribing", message: "Transcribing speech…" });
      const progress = throttled((line) => update({ message: `Transcribing… ${line.slice(0, 90)}` }));
      words = await transcribe(workingFile(project), dir, { language: project.options.language, quality: project.options.captionQuality, onProgress: progress, signal });
      // Pin every word to where it's actually spoken (WhisperX), so cuts and captions land on the sound. The
      // speech model's own timings are kept alongside; if alignment fails they're used as they are.
      if (words.length >= 10 && alignerAvailable()) {
        await fs.writeFile(path.join(dir, "words.whisper.json"), JSON.stringify(words));
        await update({ message: "Pinning word timings… 0%" });
        const onProgress = throttled((f) => update({ message: `Pinning word timings… ${Math.round(f * 100)}%` }), 1500);
        signal.throwIfAborted();
        words = await alignWords(workingFile(project), words, { language: project.options.language, onProgress, signal }).catch((err) => {
          if (signal.aborted) throw err;
          console.error(`[${project.id}] word alignment skipped:`, err.message.split("\n").pop());
          return words;
        });
      }
    }
    signal.throwIfAborted();
    await fs.writeFile(path.join(dir, "words.json"), JSON.stringify(words));
    const segments = segmentWords(words);

    // Music videos, car footage, b-roll: nothing to caption, but still great material for edits.
    if (words.length < 10) {
      await update({
        status: "ready",
        message: "No speech found — perfect material for Dope edits",
        segments,
        clips: [],
        analysis: packAnalysis(
          {
            mode: "none",
            summary: "There's little or no talking in this video, so there are no talking clips. Use Dope edits to cut its best-looking moments to music.",
          },
          segments,
        ),
      });
      await applyIntent(project);
      return;
    }

    // Picking left to Claude in a chat: stop once there's a transcript to read.
    if (project.options?.autoPick === false) {
      await update({ status: "ready", message: "Transcribed — ready for Claude to pick clips", segments, clips: [], analysis: packAnalysis({ mode: "manual", summary: "" }, segments) });
      return;
    }

    const { duration, width, height } = project.source;
    const { minSec, maxSec } = clipLengths(duration);
    // More good clips from longer videos: openshorts measured that creators who got 1–3 clips rarely came back,
    // while 4–9 kept them — so a long podcast yields 6–10 picks, a short video 3–4.
    const minClips = Math.min(6, Math.max(2, Math.round(duration / 600) + 2));
    const maxClips = Math.min(10, Math.max(3, Math.round(duration / 240)));

    await update({ status: "analyzing", message: "Finding the most viral moments with Claude…", segments });
    const request = { segments, duration, width, height, notes: project.options.notes, materials: await materialBlocks(project), minSec, maxSec, minClips, maxClips };
    let analysis;
    try {
      analysis = await analyze(request);
    } catch (err) {
      // Out of credits, bad key, outage: still deliver usable clips and say why they're demo picks.
      console.error(`[${project.id}] Claude analysis failed; using demo picks:`, err.message);
      analysis = { ...(await analyze({ ...request, demo: true })), warning: describeClaudeError(err) };
    }
    signal.throwIfAborted();
    const clips = resolveClips(analysis.clips, segments, duration, { maxClips });

    await update({
      status: "ready",
      message: clips.length ? `Found ${clips.length} clips and ${analysis.titles.length} title ideas` : "No standout talking clips — try Dope edits",
      analysis: packAnalysis(analysis, segments),
      clips,
    });
    await applyIntent(project);
    precomputeFocus(project);
    // Imported to be ready for review (a watched channel's new upload): render the best clips now.
    const autoRender = Number(project.options?.autoRender) || 0;
    if (autoRender > 0) {
      for (const clip of [...clips].sort((a, b) => (a.rank || 99) - (b.rank || 99)).slice(0, autoRender)) {
        try {
          clip.design ??= normalizeDesign({ style: project.options?.intent?.design?.style });
          queueRender(project, clip.id, { design: clip.design });
        } catch (err) {
          console.error(`[${project.id}/${clip.id}] auto-render`, err.message);
        }
      }
    }
  } catch (err) {
    if (signal.aborted) {
      // A half-finished download leaves .part files behind; a stopped video starts clean if it's tried again.
      if (project.source.url && !project.source.file) {
        for (const name of await fs.readdir(dir).catch(() => [])) if (/^source\./.test(name)) await fs.rm(path.join(dir, name), { force: true });
        delete project.source.file;
      }
      await saveProject(Object.assign(project, { status: "stopped", message: "Stopped", error: null }));
      return;
    }
    console.error(`[${project.id}]`, err);
    await update({ status: "error", message: "Processing failed", error: err.message });
  } finally {
    processing.delete(project.id);
  }
}

// ---------------------------------------------------------------------------
// Render queue. Renders are CPU/GPU heavy, so they run one at a time; any job
// can be stopped, whether it's still waiting or already rendering. A job renders
// either a clip (project.clips) or an edit (project.edits); both keep state in `item.render`.

const queue = [];
const jobs = new Map(); // "<projectId>/<itemId>" → job
let working = false;

const jobKey = (projectId, itemId) => `${projectId}/${itemId}`;

const findItem = (project, itemId) =>
  project.clips?.find((c) => c.id === itemId) || project.edits?.find((e) => e.id === itemId) || (itemId === "long" ? project.long : null) || null;

/** The last finished render of a clip or edit, if any — kept so a stopped or failed re-render doesn't lose it. */
export function finishedRender(item) {
  if (item.render?.status === "done") return item.render;
  return item.render?.previous || null;
}

export function isRendering(project, itemId) {
  return jobs.has(jobKey(project.id, itemId));
}

function enqueue(project, item, kind, design) {
  if (isRendering(project, item.id)) throw new Error("This is already rendering.");
  const job = { id: crypto.randomUUID(), key: jobKey(project.id, item.id), kind, project, item, design, controller: new AbortController() };
  const finished = finishedRender(item);
  const previous = finished ? { ...finished, previous: undefined } : null;

  jobs.set(job.key, job);
  item.render = { jobId: job.id, status: "queued", progress: 0, style: design.style || design.vibe, aspect: design.aspect, message: "Waiting for render slot…", previous };
  saveProject(project);
  queue.push(job);
  pump();
  return item;
}

export function queueRender(project, clipId, { design } = {}) {
  const clip = project.clips?.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Unknown clip ${clipId}`);
  return enqueue(project, clip, "clip", normalizeDesign(design));
}

export function queueEditRender(project, editId) {
  const edit = project.edits?.find((e) => e.id === editId);
  if (!edit) throw new Error("Edit not found");
  // Merged-engine edits keep their planning state in edits/; the server checks the plan is ready first.
  if (edit.engine !== "dope" && edit.status !== "ready") throw new Error("This edit is still being put together.");
  return enqueue(project, edit, "edit", edit.engine === "hf" ? normalizeHfDesign(edit.design) : normalizeEditDesign(edit.design));
}

/** Render the full-video edit (lib/longedit.js) once its plan is ready. */
export function queueLongRender(project) {
  if (project.long?.status !== "ready") throw new Error("The full-video edit isn't planned yet.");
  return enqueue(project, project.long, "long", { style: project.long.design.format, aspect: "16:9" });
}

export function cancelRender(project, itemId) {
  const job = jobs.get(jobKey(project.id, itemId));
  if (!job) return false;
  jobs.delete(job.key);
  const waiting = queue.indexOf(job);
  if (waiting !== -1) queue.splice(waiting, 1);
  job.controller.abort();

  const previous = job.item.render?.previous;
  job.item.render = previous
    ? { ...previous, message: "Re-render stopped — kept the previous version" }
    : { status: "cancelled", progress: 0, style: job.design.style || job.design.vibe, aspect: job.design.aspect, message: "Render stopped" };
  saveProject(job.project);
  return true;
}

export function cancelAllRenders(project) {
  const items = [...(project.clips || []), ...(project.edits || []), ...(project.long ? [project.long] : [])];
  return items.filter((item) => cancelRender(project, item.id)).length;
}

export { findItem };

async function pump() {
  if (working) return;
  working = true;
  while (queue.length) {
    const job = queue.shift();
    await runJob(job);
    if (jobs.get(job.key) === job) jobs.delete(job.key);
  }
  working = false;
}

async function runLongJob(job) {
  const { project, item } = job;
  const { signal } = job.controller;
  const setRender = (patch) => {
    if (signal.aborted || item.render?.jobId !== job.id) return;
    item.render = { ...item.render, ...patch };
    return saveProject(project);
  };
  try {
    await setRender({ status: "rendering", progress: 0, message: "Cutting the video…" });
    const result = await renderLongEdit(project, { signal, setRender: throttledPatch(setRender) });
    await setRender({ status: "done", progress: 100, ...result, renderedAt: new Date().toISOString(), previous: undefined });
  } catch (err) {
    if (signal.aborted) return;
    console.error(`[${project.id}/long]`, err);
    const previous = item.render?.previous;
    await setRender(previous ? { ...previous, message: `Render failed — kept the previous version (${err.message.slice(0, 120)})` } : { status: "error", progress: 0, message: "Render failed", error: err.message.slice(0, 300) });
  }
}

/** Progress patches at most twice a second; the last one always lands. */
function throttledPatch(fn) {
  let last = 0;
  return (patch) => {
    const now = Date.now();
    if (now - last < 500 && patch.progress !== 100) return;
    last = now;
    return fn(patch);
  };
}

async function runJob(job) {
  const { project, item } = job;
  const { signal } = job.controller;
  if (signal.aborted) return;

  if (job.kind === "long") return runLongJob(job);

  const dir = projectDir(project.id);
  const compositionDir = path.join(dir, "compositions", item.id);
  const variant = `${job.kind === "edit" ? job.design.vibe || job.design.style : job.design.style}-${job.design.aspect.replace(":", "x")}`;
  const outName = `${item.id}-${variant}.mp4`;
  // Render into a per-job folder (HyperFrames keeps its work files next to the output) and move the
  // finished file into renders/, so stopping never clobbers a finished render or leaves junk behind.
  const outDir = path.join(compositionDir, `out-${job.id}`);
  const partial = path.join(outDir, outName);

  // Once stopped (or superseded by a newer job) this job must not touch the item's state.
  const setRender = (patch) => {
    if (signal.aborted || item.render?.jobId !== job.id) return;
    item.render = { ...item.render, ...patch };
    return saveProject(project);
  };

  try {
    await setRender({ status: "rendering", progress: 0, message: job.kind === "edit" ? "Cutting shots…" : "Cutting source segment…" });
    await fs.rm(compositionDir, { recursive: true, force: true });
    await fs.mkdir(path.join(compositionDir, "assets"), { recursive: true });
    await fs.mkdir(outDir, { recursive: true });
    await fs.mkdir(path.join(dir, "renders"), { recursive: true });

    // Clips go through review before they're called done: render, look at the result, repair what can be fixed
    // automatically and render again (at most twice more). Edits render once.
    const MAX_REPAIRS = 2;
    const tried = new Set();
    let review = null;
    let qa = null;
    let started = Date.now();
    for (let round = 0; ; round++) {
      await fs.rm(compositionDir, { recursive: true, force: true });
      await fs.mkdir(path.join(compositionDir, "assets"), { recursive: true });
      await fs.mkdir(outDir, { recursive: true });
      let planned = null; // how long the cut is supposed to run, for the check after the render
      let prepared = null;
      if (job.kind === "edit" && item.engine === "dope") await prepareDopeRender({ item, compositionDir, signal, setRender });
      else if (job.kind === "edit" && item.engine === "hf") await prepareHfEdit(job, compositionDir, setRender);
      else if (job.kind === "edit") await prepareEdit(job, compositionDir, setRender);
      else {
        prepared = await prepareClip(job, compositionDir);
        planned = prepared.planned;
      }
      if (job.kind === "edit") planned = Number(item.plan?.duration) || Number(item.duration) || null;
      signal.throwIfAborted();

      const pass = round ? ` (review fix ${round})` : "";
      await setRender({ message: `Rendering with HyperFrames…${pass}` });
      const onProgress = throttled((pct, line) => setRender(pct === null ? { message: line.slice(0, 100) } : { progress: pct, message: `Rendering… ${pct}%${pass}` }), 500);
      started = Date.now();
      await renderComposition(compositionDir, partial, { onProgress, signal });
      signal.throwIfAborted();
      // The whole mix to -14 LUFS / -1 dBTP when it drifted (picture copied, only the sound redone).
      await masterLoudness(partial, { signal }).catch((err) => {
        if (signal.aborted) throw err;
        console.error(`[${project.id}/${item.id}] loudness master`, err.message);
      });

      // Look at the finished file before calling it done: black picture, a frozen frame, no sound or the wrong
      // length all mean something went wrong that the renderer reported as success.
      await setRender({ message: `Checking the render…${pass}` });
      qa = await checkRender(partial, { expect: planned, signal, holdEnd: job.kind === "edit" ? 0 : MUSIC_TAIL.sec }).catch((err) => {
        console.error(`[${project.id}/${item.id}] render check`, err.message);
        return null;
      });
      if (job.kind === "edit") break;

      review = await reviewClip({
        file: partial,
        plan: prepared.plan,
        words: prepared.words,
        clip: item,
        compositionDir,
        signal,
        onStage: (message) => setRender({ message: `${message}${pass}` }),
      }).catch((err) => {
        if (signal.aborted) throw err;
        console.error(`[${project.id}/${item.id}] review`, err.message);
        return null;
      });
      if (qa && !qa.ok) review = review && { ...review, pass: false, issues: [...review.issues, ...qa.problems.map((p) => ({ severity: p.level === "error" ? "critical" : "minor", kind: "render_check", source: "qa", note: p.text }))] };
      if (!review || review.pass || round >= MAX_REPAIRS) break;
      const fixes = repairsFor(review, prepared.plan, item, job.design);
      const key = fixes && JSON.stringify(fixes);
      // The creator's own timeline edit is final: review it and report, but never rewrite it.
      if (!fixes || tried.has(key) || prepared.plan.fromEditor) break;
      tried.add(key);
      // Apply the fixes to the clip itself, so the preview and every later render get them too.
      item.protect = fixes.protect;
      item.softJoins = fixes.softJoins;
      if (fixes.wordFixes) item.wordFixes = fixes.wordFixes;
      if (fixes.musicLevel !== job.design.musicLevel) {
        job.design = { ...job.design, musicLevel: fixes.musicLevel };
        item.design = { ...(item.design || {}), musicLevel: fixes.musicLevel };
      }
      item.reviewHistory = [...(item.reviewHistory || []).slice(-4), { at: new Date().toISOString(), score: review.score, issues: review.issues.length, fixes }];
      await setRender({ message: `Review found ${review.issues.length} issue${review.issues.length === 1 ? "" : "s"} (score ${review.score}) — fixing and rendering again…` });
    }

    const outFile = path.join(dir, "renders", outName);
    await fs.rename(partial, outFile);
    await fs.rm(outDir, { recursive: true, force: true });

    const verdict = review ? (review.recommended ? "Ready to post" : review.pass ? "Passed review" : "Needs your review") : null;
    await setRender({
      status: "done",
      progress: 100,
      message: verdict ? `${verdict} · score ${review.score}${review.issues.length ? ` · ${review.issues.length} note${review.issues.length === 1 ? "" : "s"}` : ""}` : describeQa(qa) || `Rendered in ${Math.round((Date.now() - started) / 1000)}s`,
      file: `renders/${outName}`,
      duration: qa?.duration ?? null,
      qa: qa ? { ok: qa.ok, problems: qa.problems } : null,
      review: review ? { score: review.score, pass: review.pass, recommended: review.recommended, issues: review.issues.slice(0, 20), scores: review.scores, reviewedAt: review.reviewedAt, rounds: tried.size } : null,
      renderedAt: new Date().toISOString(),
      previous: undefined,
    });
  } catch (err) {
    // A stopped render takes a few seconds to exit, so clean its folder up after it's gone.
    const cleanup = () => fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    if (signal.aborted) {
      setTimeout(cleanup, 5000);
      return;
    }
    await cleanup();
    console.error(`[${project.id}/${item.id}]`, err);
    await setRender({ status: "error", message: "Render failed", error: err.message });
  }
}

async function prepareClip(job, compositionDir) {
  const { project, item: clip } = job;
  let { design } = job;
  const { signal } = job.controller;
  const dir = projectDir(project.id);
  const words = correctWords(JSON.parse(await fs.readFile(path.join(dir, "words.json"), "utf8")));
  // The sound's real pauses, so dead air inside a word's timing gets cut too (measured once, a few seconds).
  const silences = await findSilences(project, { signal }).catch(() => []);
  // How loud the cleaned voice is every 10 ms, so every cut lands in a quiet instant (measured once, ~2 s).
  const levels = await measureLevels(project, { signal }).catch(() => null);
  // What's already in the footage: its own jump cuts (no zooms added on top) and text cards or freezes (cut out).
  const edited = await sourceCuts(project, clip.start, clip.end, { signal }).catch(() => null);
  // A clip the creator edited in the timeline editor renders exactly as they left it; otherwise the engine plans it.
  const doc = await readSavedDocument(project.id, clip.id);
  const plan = doc ? documentPlan(doc) : planClip(clip, words, design, { analysis: project.analysis, silences, levels, stills: edited?.stills });
  if (plan.fromEditor) {
    design = normalizeDesign({
      ...design,
      ...(plan.design || {}),
      aspect: plan.aspect || design.aspect,
      ...(plan.music ? { musicLevel: plan.music.level, musicBed: plan.music.sound || "none" } : {}),
      ...(plan.title ? { showTitle: Boolean(plan.title.content?.trim()), ...(plan.title.preset ? { titleStyle: plan.title.preset } : {}) } : { showTitle: false }),
    });
  }

  // Picture from the original (sharpest crop), sound from the cleaned working copy — one file per kept piece.
  const src = path.join(dir, project.source.file);
  const audioSrc = cleanAudioFile(project);
  const track = plan.fromEditor ? (plan.music?.sound ? await getTrack(plan.music.sound) : null) : await clipMusic(clip, design, { projectId: project.id });
  // Podcast clips with a bed end on a few music-only seconds: the last frame holds while the song comes up.
  const tail = track && design.style === "podcast" ? MUSIC_TAIL.sec : 0;
  const parts = [];
  for (const [i, part] of plan.parts.entries()) {
    const file = `part-${i}.mp4`;
    const hold = i === plan.parts.length - 1 ? tail : 0;
    await cutSegment(src, path.join(compositionDir, "assets", file), part.start, part.end, { signal, audioSrc, fadeEdges: true, fadeSec: clip.softJoins ? 0.08 : 0.03, holdEnd: hold, hdr: Boolean(project.source.hdr) });
    signal.throwIfAborted();
    parts.push({ t: part.t, dur: part.dur + hold, hold, src: `assets/${file}`, mediaStart: 0 });
  }

  let music = null;
  if (track) {
    // One finished bed file, exactly the clip's length: loudness-matched, looped with crossfades, flat at the music
    // level under the talking and up to the ending's level only once the words are done (lib/bed.js).
    const name = "bed.m4a";
    const D = plan.duration + tail;
    const level = normalizeDesign(design).musicLevel;
    await mixMusicBed(path.join(SOUNDS_DIR, track.file), path.join(compositionDir, "assets", name), {
      duration: D,
      level,
      // One level the whole way through, ending included: the creator wants the bed low and never turning up.
      tail: null,
      signal,
    });
    music = { src: `assets/${name}`, duration: D, volume: 1, premixed: true };
  }

  // Footage that already carries captions doesn't get a second set from us (the creator's rule).
  if (!plan.fromEditor && design.captions !== false) {
    const found = await burnedInCaptions(project, clip.start, clip.end, { signal }).catch(() => ({ has: false }));
    if (found.has) {
      design = normalizeDesign({ ...design, captions: false });
      clip.sourceCaptions = { has: true, note: found.note, at: new Date().toISOString() };
      clip.design = { ...(clip.design || {}), captions: false };
      saveProject(project);
      console.log(`[${project.id}/${clip.id}] footage already has captions — ours are off (${found.note})`);
    } else if (clip.sourceCaptions) {
      delete clip.sourceCaptions;
    }
  }

  // The power words that pop big and the key-point cards (lib/emphasis.js), chosen for the words this cut plays.
  // Kept on the clip, and asked for again only when the cut's words change.
  if (normalizeDesign(design).pops && (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)) {
    const said = plan.words.map((w) => w.text).join(" ").slice(0, 2000);
    const current = clip.emphasisPlan;
    if (!current || current.version !== EMPHASIS_VERSION || current.words !== said) {
      const fresh = await emphasisPlan({ clip, words: plan.words }).catch((err) => (console.error(`[${project.id}/${clip.id}] emphasis`, err.message), null));
      if (fresh) {
        clip.emphasisPlan = fresh;
        saveProject(project);
      }
    }
  }

  const focus = await clipFocus(project, clip, { signal });
  // Where faces sit, so full-screen captions can stay off them (Podcast Frame puts captions below the video).
  const faces = design.style === "podcast" ? null : await faceBand(project, clip.start, clip.end, { signal }).catch(() => null);
  await buildComposition(compositionDir, {
    faceBand: faces,
    sourceEdited: Boolean(edited?.busy),
    clip: { ...clip, title: formatMoneyText(plan.title?.content ?? clip.title), highlight: plan.title ? plan.title.highlight : clip.highlight },
    words,
    source: project.source,
    design,
    focus: mapFocus(focus, clip, plan.parts),
    timeline: { duration: plan.duration + tail, parts, words: plan.words, tail },
    music,
  });
  // The creator muted the original audio in the editor: the render has no voice either.
  if (plan.fromEditor && plan.muteVoice) {
    const file = path.join(compositionDir, "index.html");
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(/<audio id="pa\d+"[^>]*><\/audio>/g, ""));
  }
  // Slides, phone recordings and big captions placed in the editor (Video Editor session, editor/director/).
  if (plan.fromEditor) await applyEditorLayers(project, doc, compositionDir);
  // Every other clip gets its important lines as big glowing words behind the speaker (lib/behind.js).
  else if (normalizeDesign(design).pops && clip.emphasisPlan) {
    await applyBigWords({ project, plan, emphasisPlan: clip.emphasisPlan, design: normalizeDesign(design), compositionDir, signal }).catch((err) => {
      if (signal?.aborted) throw err;
      console.error(`[${project.id}/${clip.id}] big words`, err.message);
    });
  }
  return { planned: plan.duration + tail, plan, words };
}

/** HyperFrames-style edits: full-size segments for the plan, the music, and the composition. */
async function prepareHfEdit(job, compositionDir, setRender) {
  const { project, item: edit, design } = job;
  const { signal } = job.controller;
  if (!edit.plan) throw new Error("This edit doesn't have a cut to render yet.");
  // Remembered on the render so the card can say when later changes have made it out of date.
  await setRender({ planVersion: edit.planVersion || 0, designKey: JSON.stringify(design) });
  const src = path.join(projectDir(project.id), project.source.file);
  const segments = edit.plan.segments;
  for (const s of segments) {
    const end = Math.min(project.source.duration, s.mediaStart + s.dur * s.rate + 1);
    await cutSegment(src, path.join(compositionDir, "assets", `seg-${s.index}.mp4`), s.mediaStart, end, { signal, audioSrc: cleanAudioFile(project), keepFps: s.rate < 1 });
    signal.throwIfAborted();
    await setRender({ message: `Cutting shots… ${s.index + 1}/${segments.length}` });
  }
  let music = null;
  const track = edit.trackId ? await getTrack(edit.trackId) : null;
  if (track) {
    const name = `music${path.extname(track.file)}`;
    await fs.copyFile(path.join(SOUNDS_DIR, track.file), path.join(compositionDir, "assets", name));
    music = { src: `assets/${name}`, start: edit.plan.musicStart || 0 };
  }
  await writeHfEditComposition(compositionDir, {
    plan: edit.plan,
    design,
    music,
    videoSrcFor: (s) => `assets/seg-${s.index}.mp4`,
    mediaStartFor: () => 0,
  });
}

async function prepareEdit(job, compositionDir, setRender) {
  const { project, item: edit, design } = job;
  const { signal } = job.controller;
  const src = path.join(projectDir(project.id), project.source.file);
  const timeline = planTimeline({ shots: edit.shots, cuts: edit.cuts, duration: edit.duration, vibe: design.vibe });

  for (const item of timeline) {
    const end = Math.min(project.source.duration, item.mediaStart + item.sourceLength + 0.15);
    await cutSegment(src, path.join(compositionDir, "assets", `shot-${item.index}.mp4`), item.mediaStart, end, { signal });
    signal.throwIfAborted();
    await setRender({ message: `Cutting shots… ${item.index + 1}/${timeline.length}` });
  }

  let music = null;
  const track = edit.trackId ? await getTrack(edit.trackId) : null;
  if (track) {
    const name = `music${path.extname(track.file)}`;
    await fs.copyFile(path.join(SOUNDS_DIR, track.file), path.join(compositionDir, "assets", name));
    music = { src: `assets/${name}` };
  }

  await writeEditComposition(compositionDir, {
    timeline,
    duration: edit.duration,
    beats: edit.beats,
    music,
    design,
    videoSrcFor: (item) => `assets/shot-${item.index}.mp4`,
    mediaStartFor: () => 0,
  });
}
