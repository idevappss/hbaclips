// Timeline editor (Timeline session): the "Preview & Edit" workspace for one clip. Owns editor/ and data/editor/.
// Mounted by server.js at /api/editor; the page itself is editor/public/, opened by app.js at #/edit/<project>/<clip>.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import express from "express";
import multer from "multer";
import { ASPECTS, FONTS, STYLES, buildCompositionHtml } from "../lib/compose.js";
import { mapFocus } from "../lib/clipplan.js";
import { clipFocus } from "../lib/pipeline.js";
import { SOUNDS_DIR, getTrack, listTracks } from "../lib/sounds.js";
import { loadProject as loadFromStore, projectDir } from "../lib/store.js";
import { WORK_FILE, hasWorkingCopy, workingFile } from "../lib/work.js";
import { clipDesign, compositionInputs, documentDuration, normalizeDocument, seedDocument } from "./document.js";
import { DATA_DIR, PEAK_RATE, peaksFor, thumbFor } from "./media.js";
import { acceptsFile, addAsset, assetFilePath, assetUrl, assetsDir, getAsset, listAssets, removeAsset } from "./director/assets.js";
import { injectLayers } from "./director/layers.js";
import { attachMattes, ensureMattes, matteUrl, mattesDir } from "./director/matte.js";
import { applyCues, planDirector } from "./director/plan.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ID = /^[\w-]{1,60}$/;

/** A project's clip by id. "full" is the whole recording, for long-form edits built in the editor. */
export function findClip(project, clipId) {
  if (clipId === "full") {
    const duration = project.source?.duration || 0;
    return { id: "full", rank: 0, title: project.name || project.source?.info?.title || "Full video", start: 0, end: duration, score: null, design: { ...(project.clips?.[0]?.design || {}), aspect: (project.source?.width || 16) >= (project.source?.height || 9) ? "16:9" : "9:16", showTitle: false } };
  }
  return project.clips?.find((c) => c.id === clipId) || null;
}

const docFile = (projectId, clipId) => path.join(DATA_DIR, projectId, `${clipId}.json`);

async function readDoc(projectId, clipId) {
  try {
    return JSON.parse(await fs.readFile(docFile(projectId, clipId), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

const writes = new Map();
function writeDoc(doc) {
  const file = docFile(doc.projectId, doc.clipId);
  const prev = writes.get(file) || Promise.resolve();
  const next = prev.then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(doc));
    await fs.rename(tmp, file);
  });
  writes.set(file, next.catch(() => {}));
  return next;
}

/** What the header, clip switcher and AI score need about the clip and its siblings. */
function clipContext(project, clip) {
  const brief = (c) => ({ id: c.id, rank: c.rank, title: c.title, score: c.score ?? null, start: c.start, end: c.end });
  return {
    project: { id: project.id, name: project.name || project.source?.info?.title || "Project", source: { duration: project.source?.duration, width: project.source?.width, height: project.source?.height, hasAudio: project.source?.hasAudio } },
    clip: { ...brief(clip), highlight: clip.highlight || "", ratings: clip.ratings || null, reason: clip.reason || "", payoff: clip.payoff || "" },
    clips: [brief(findClip(project, "full")), ...[...(project.clips || [])].sort((a, b) => (a.rank || 0) - (b.rank || 0)).map(brief)],
    aspects: ASPECTS,
    styles: Object.entries(STYLES).map(([id, s]) => ({ id, label: s.label, description: s.description, design: s.design })),
    fonts: Object.fromEntries(Object.entries(FONTS).map(([id, f]) => [id, f.label])),
    media: { videoSrc: videoUrl(project), peakRate: PEAK_RATE },
  };
}

/** Public view of an upload for the media panel. */
function publicAsset(projectId, a) {
  const url = (file) => (file ? assetUrl(projectId, a.id, file) : null);
  return {
    id: a.id, kind: a.kind, role: a.role, name: a.name, status: a.status, error: a.error, notice: a.notice || null,
    duration: a.duration, width: a.width, height: a.height,
    poster: url(a.poster), src: url(a.file),
    slides: a.slides?.map((s) => ({ page: s.page, src: url(s.file || s.image), title: s.title || "", text: (s.text || "").slice(0, 160) })),
  };
}

/** How the layer composer finds slides, recordings and cutouts: API URLs for the preview, local files for renders. */
export async function layerResolver(project, doc, { preview = true, stage = null } = {}) {
  const assets = new Map((await listAssets(project.id)).map((a) => [a.id, a]));
  const mattes = attachMattes(project, doc);
  const ref = (assetId, file) => (preview ? assetUrl(project.id, assetId, file) : stage(path.join(assetsDir(project.id), assetId, file), `editor/${assetId}/${file}`));
  return {
    slide(assetId, page) {
      const a = assets.get(assetId);
      const s = a?.status === "ready" ? a.slides?.find((x) => x.page === page) : null;
      if (!s) return null;
      if (s.rebuilt) return { rebuilt: true, title: s.title, bullets: s.bullets, image: s.image ? ref(assetId, s.image) : null, width: 1600, height: 900 };
      return { src: ref(assetId, s.file), width: s.width, height: s.height };
    },
    video(assetId) {
      const a = assets.get(assetId);
      return a?.status === "ready" && a.file ? { src: ref(assetId, a.file), width: a.width, height: a.height } : null;
    },
    matte(clipId) {
      const m = mattes.get(clipId);
      if (!m) return null;
      return { src: preview ? matteUrl(project.id, m.file) : stage(path.join(mattesDir(project.id), m.file), `editor/mattes/${m.file}`), at: m.at, until: m.until };
    },
  };
}

const videoUrl = (project) => `/files/${project.id}/${encodeURIComponent(hasWorkingCopy(project) ? WORK_FILE : project.source.file)}`;

/** @param loadProject  how to read a project (the dev server reads straight from disk; the studio uses its cache) */
export function createEditor({ loadProject = loadFromStore } = {}) {
  const router = express.Router();
  router.use(express.json({ limit: "4mb" }));
  router.use("/ui", express.static(path.join(HERE, "public"), { setHeaders: (res) => res.set("Cache-Control", "no-cache") }));

  const handle = (fn) => async (req, res) => {
    try {
      const { projectId, clipId } = req.params;
      if ((projectId && !ID.test(projectId)) || (clipId && !ID.test(clipId))) return res.status(404).json({ error: "Not found" });
      const project = projectId ? await loadProject(projectId) : null;
      if (projectId && !project) return res.status(404).json({ error: "Project not found" });
      const clip = clipId ? findClip(project, clipId) : null;
      if (clipId && !clip) return res.status(404).json({ error: "Clip not found" });
      const out = await fn(req, res, { project, clip });
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      console.error("Editor:", err);
      if (!res.headersSent) res.status(400).json({ error: err.message });
    }
  };

  const openDoc = async (project, clip) => (await readDoc(project.id, clip.id)) || seedDocument(project, clip);

  // The document for a clip (saved, or freshly seeded from the engine's plan) and everything around it.
  router.get("/projects/:projectId/clips/:clipId", handle(async (_req, _res, { project, clip }) => {
    if (project.status !== "ready") throw new Error("This video is still processing.");
    return { document: await openDoc(project, clip), saved: Boolean(await readDoc(project.id, clip.id)), ...clipContext(project, clip) };
  }));

  // Autosave. Revisions only move forward; an older tab saving over a newer one gets the newer document back.
  router.put("/projects/:projectId/clips/:clipId/document", handle(async (req, res, { project, clip }) => {
    const doc = normalizeDocument(req.body?.document, { project, clip });
    const current = await readDoc(project.id, clip.id);
    if (current && Number.isInteger(req.body?.baseRev) && req.body.baseRev < current.rev) {
      res.status(409).json({ error: "This clip was changed in another tab.", document: current });
      return;
    }
    doc.rev = (current?.rev || 0) + 1;
    doc.savedAt = new Date().toISOString();
    doc.edited = true; // renders follow this document from now on (lib/pipeline.js prepareClip)
    await writeDoc(doc);
    return { rev: doc.rev, savedAt: doc.savedAt, duration: documentDuration(doc) };
  }));

  // Start over from the engine's plan.
  router.delete("/projects/:projectId/clips/:clipId/document", handle(async (_req, _res, { project, clip }) => {
    const current = await readDoc(project.id, clip.id);
    const doc = await seedDocument(project, clip);
    doc.rev = (current?.rev || 0) + 1;
    doc.savedAt = new Date().toISOString();
    doc.edited = false; // back to the engine's own cut, which keeps improving
    await writeDoc(doc);
    return { document: doc };
  }));

  // Live preview of the saved document, through the same composer renders use.
  router.get("/projects/:projectId/clips/:clipId/preview", async (req, res) => {
    try {
      if (!ID.test(req.params.projectId) || !ID.test(req.params.clipId)) return res.status(404).end();
      const project = await loadProject(req.params.projectId);
      const clip = project ? findClip(project, req.params.clipId) : null;
      if (!clip) return res.status(404).type("text").send("Clip not found");
      const doc = await openDoc(project, clip);
      const videoSrc = videoUrl(project);
      const inputs = await compositionInputs(doc, { project, clip, videoSrc });
      const focus = await clipFocus(project, clip, { compute: false }).catch(() => null);
      let { html } = buildCompositionHtml({
        clip: inputs.clip,
        words: inputs.words,
        source: project.source,
        design: inputs.design,
        videoSrc,
        mediaStart: clip.start,
        focus: mapFocus(focus, clip, inputs.parts),
        timeline: inputs.timeline,
        music: inputs.music,
        assetBase: "/studio-assets/",
        runtimeSrc: "/vendor/hyperframe-runtime.js",
      });
      if (inputs.muteVoice) html = html.replace(/<audio id="pa\d+"[^>]*><\/audio>/g, "");
      html = injectLayers(html, doc, await layerResolver(project, doc, { preview: true }));
      res.type("html").set("Cache-Control", "no-store").send(html);
    } catch (err) {
      console.error("Editor preview:", err);
      res.status(500).type("text").send(err.message);
    }
  });

  // Waveform of the whole source (one byte per 1/PEAK_RATE s).
  router.get("/projects/:projectId/peaks", handle(async (_req, res, { project }) => {
    if (!project.source?.hasAudio) return res.status(204).end();
    const peaks = await peaksFor(workingFile(project), path.join(DATA_DIR, project.id, "peaks.bin"));
    res.type("application/octet-stream").set({ "Cache-Control": "private, max-age=3600", "X-Peak-Rate": String(PEAK_RATE) }).send(peaks);
  }));

  router.get("/sounds/:trackId/peaks", handle(async (req, res) => {
    const track = ID.test(req.params.trackId) ? await getTrack(req.params.trackId) : null;
    if (!track) return res.status(404).json({ error: "Sound not found" });
    const peaks = await peaksFor(path.join(SOUNDS_DIR, track.file), path.join(DATA_DIR, "sounds", `${track.id}.bin`));
    res.type("application/octet-stream").set({ "Cache-Control": "private, max-age=86400", "X-Peak-Rate": String(PEAK_RATE) }).send(peaks);
  }));

  // Filmstrip frame at a whole second of the source.
  router.get("/projects/:projectId/thumbs/:sec", handle(async (req, res, { project }) => {
    const sec = Math.max(0, Math.min(Math.floor(project.source?.duration || 0), Math.floor(Number(req.params.sec.replace(/\.jpg$/, "")) || 0)));
    const file = await thumbFor(workingFile(project), path.join(DATA_DIR, project.id, "thumbs"), sec);
    res.set("Cache-Control", "private, max-age=604800, immutable").sendFile(file);
  }));

  // The media panel: this video, the project's poster, and the sound library.
  router.get("/projects/:projectId/media", handle(async (_req, _res, { project }) => {
    const poster = await fs.stat(path.join(projectDir(project.id), "poster.jpg")).then(() => `/files/${project.id}/poster.jpg`).catch(() => null);
    const tracks = await listTracks().catch(() => []);
    return {
      videos: [{ id: "source", name: project.name || project.source?.info?.title || "Source video", duration: project.source?.duration, poster, src: videoUrl(project) }],
      audio: tracks.filter((t) => t.status === "ready").map((t) => ({ id: t.id, name: t.name, duration: t.duration, bpm: t.bpm, hasWords: t.hasWords, src: `/sounds-media/${encodeURIComponent(t.file)}` })),
    };
  }));

  // ---------- director: uploads, the AI plan, cutouts ----------
  const upload = multer({ dest: path.join(os.tmpdir(), "clip-editor-uploads"), limits: { fileSize: 4 * 1024 ** 3, files: 40 } });

  router.get("/projects/:projectId/assets", handle(async (_req, _res, { project }) => ({ assets: (await listAssets(project.id)).map((a) => publicAsset(project.id, a)) })));

  router.post("/projects/:projectId/assets", upload.array("files", 40), handle(async (req, _res, { project }) => {
    const files = req.files || [];
    if (!files.length) throw new Error("Choose at least one file.");
    const added = [];
    for (const f of files) {
      if (!acceptsFile(f.originalname)) {
        await fs.rm(f.path, { force: true });
        continue;
      }
      added.push(await addAsset(project.id, { tmpPath: f.path, originalName: f.originalname, role: req.body?.role }));
    }
    if (!added.length) throw new Error("Use PDF, PowerPoint, image or video files.");
    return { assets: added.map((a) => publicAsset(project.id, a)) };
  }));

  router.patch("/projects/:projectId/assets/:assetId", handle(async (req, _res, { project }) => {
    const asset = await getAsset(project.id, req.params.assetId);
    if (!asset) throw new Error("That upload is gone.");
    const { withRole } = await import("./director/assets.js");
    return { asset: publicAsset(project.id, await withRole(project.id, asset.id, req.body?.role)) };
  }));

  router.delete("/projects/:projectId/assets/:assetId", handle(async (req, _res, { project }) => {
    await removeAsset(project.id, req.params.assetId);
    return { ok: true };
  }));

  router.get("/projects/:projectId/assets/:assetId/files/:file", handle(async (req, res, { project }) => {
    const file = ID.test(req.params.assetId) ? assetFilePath(project.id, req.params.assetId, req.params.file) : null;
    if (!file) return res.status(404).json({ error: "Not found" });
    res.set("Cache-Control", "private, max-age=86400").sendFile(file);
  }));

  router.get("/projects/:projectId/mattes/:file", handle(async (req, res, { project }) => {
    if (!/^[a-f0-9]{16}\.webm$/.test(req.params.file)) return res.status(404).json({ error: "Not found" });
    res.set("Cache-Control", "private, max-age=604800, immutable").sendFile(path.join(mattesDir(project.id), req.params.file));
  }));

  // Plan the edit: returns the document with the director's overlay and emphasis tracks, for the editor to commit.
  router.post("/projects/:projectId/clips/:clipId/director", handle(async (req, _res, { project, clip }) => {
    const doc = await openDoc(project, clip);
    const base = req.body?.document && Array.isArray(req.body.document.tracks) ? normalizeDocument(req.body.document, { project, clip }) : doc;
    // Big captions unless turned off; slides and phone demos only when asked for.
    const want = { slides: req.body?.want?.slides === true, screens: req.body?.want?.screens === true, emphasis: req.body?.want?.emphasis !== false };
    const plan = await planDirector(base, { projectId: project.id, want, note: String(req.body?.note || "").slice(0, 600) });
    const assets = await listAssets(project.id);
    const next = applyCues(structuredClone(base), plan.cues, assets);
    return { mode: plan.mode, concept: plan.concept, notice: plan.notice || null, cues: plan.cues.length, tracks: next.tracks.filter((t) => t.kind === "overlay" || t.kind === "emphasis") };
  }));

  // Cutouts behind emphasis captions: starts any that are missing and reports progress per clip.
  router.get("/projects/:projectId/clips/:clipId/mattes", handle(async (_req, _res, { project, clip }) => {
    const doc = await readDoc(project.id, clip.id);
    return { mattes: doc ? ensureMattes(project, doc) : {} };
  }));

  return { router, clipDesign };
}

export const { router } = createEditor();
