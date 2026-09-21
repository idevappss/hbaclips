// The timeline editor's document: one clip described as tracks of timed clips (see editor/README.md).
// Seeded from the engine's own plan (lib/clipplan.js), so a clip opens in the editor exactly as it previews and
// renders today, and turned back into composition inputs, so the editor never renders anything itself.
import fs from "node:fs/promises";
import path from "node:path";
import { ASPECTS, groupCaptions, houseLevel, normalizeDesign } from "../lib/compose.js";
import { clipMusic, planClip } from "../lib/clipplan.js";
import { correctWords } from "../lib/corrections.js";
import { readSilences } from "../lib/silence.js";
import { getTrack } from "../lib/sounds.js";
import { projectDir } from "../lib/store.js";

export const VERSION = 1;
const r3 = (n) => Math.round(n * 1000) / 1000;
const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The design a clip is saved with, filled in (same rule as server.js clipDesign/designFrom). */
export const clipDesign = (clip) => normalizeDesign(clip.design || { style: clip.render?.style, cropX: clip.render?.cropX });

const wordsCache = new Map();
export async function projectWords(project) {
  const file = path.join(projectDir(project.id), "words.json");
  const { mtimeMs } = await fs.stat(file);
  const hit = wordsCache.get(project.id);
  if (hit?.mtimeMs === mtimeMs) return hit.words;
  const words = correctWords(JSON.parse(await fs.readFile(file, "utf8")));
  wordsCache.set(project.id, { mtimeMs, words });
  return words;
}

/** A fresh document for a clip, from the same plan its preview and render use. */
export async function seedDocument(project, clip) {
  const design = clipDesign(clip);
  const words = await projectWords(project);
  const plan = planClip(clip, words, design, { analysis: project.analysis, silences: await readSilences(project) });
  const D = plan.duration;

  const video = plan.parts.map((p, i) => ({ id: `v${i + 1}`, type: "video", start: p.t, duration: p.dur, sourceStart: r3(p.start), sourceEnd: r3(p.end), speed: 1, link: `l${i + 1}` }));
  const voice = plan.parts.map((p, i) => ({ id: `a${i + 1}`, type: "audio", start: p.t, duration: p.dur, sourceStart: r3(p.start), sourceEnd: r3(p.end), speed: 1, volume: 1, link: `l${i + 1}` }));

  const spoken = plan.words.filter((w) => norm(w.text));
  const captions = groupCaptions(spoken, D, { maxWords: design.maxWords }).map((g, i) => ({
    id: `c${i + 1}`,
    type: "caption",
    start: g.in,
    duration: r3(g.out - g.in),
    words: g.words.map((w) => ({ text: w.text, s: r3(Math.max(0, w.s - g.in)), e: r3(Math.max(0, w.e - g.in)) })),
  }));

  const titles = design.showTitle && clip.title
    ? [{ id: "t1", type: "text", start: 0, duration: design.titleOut > 0 ? Math.min(D, design.titleOut) : D, content: clip.title, highlight: clip.highlight || "", style: { preset: design.titleStyle } }]
    : [];

  const track = await clipMusic(clip, design, { projectId: project.id });
  const music = track
    ? [{ id: "m1", type: "audio", start: 0, duration: D, sourceStart: 0, sourceEnd: r3(Math.min(track.duration || D, D)), speed: 1, volume: design.musicLevel, sound: track.id, name: track.name, loop: true }]
    : [];

  return {
    version: VERSION,
    projectId: project.id,
    clipId: clip.id,
    rev: 0,
    seededAt: new Date().toISOString(),
    aspect: design.aspect,
    fps: 30,
    design,
    tracks: [
      { id: "titles", kind: "text", name: "Titles", hidden: false, locked: false, clips: titles },
      // Footage that already has captions burned in starts with ours hidden (lib/sourcecaptions.js); unhide the
      // track to bring them back.
      { id: "captions", kind: "caption", name: "Captions", hidden: design.captions === false, locked: false, clips: captions },
      { id: "video", kind: "video", name: "Video", hidden: false, locked: false, clips: video },
      { id: "voice", kind: "audio", role: "voice", name: "Original audio", hidden: false, locked: false, muted: false, clips: voice },
      { id: "music", kind: "audio", role: "music", name: "Background music", hidden: false, locked: false, muted: false, clips: music },
    ],
  };
}

const KINDS = { text: "text", caption: "caption", video: "video", audio: "audio", overlay: "overlay", emphasis: "emphasis" };
const LAYOUTS = ["full", "split", "pip", "card"];
const str = (v, max) => String(v ?? "").slice(0, max);
const id = (v) => str(v, 40).replace(/[^\w-]/g, "") || null;
const num = (v, lo, hi, fallback = lo) => (Number.isFinite(Number(v)) ? clamp(r3(Number(v)), lo, hi) : fallback);

/** Validate a document sent by the editor. Anything malformed is dropped, never trusted. */
export function normalizeDocument(input, { project, clip }) {
  if (!input || typeof input !== "object" || !Array.isArray(input.tracks)) throw new Error("That isn't an editor document.");
  const sourceDuration = project.source?.duration || 3600;
  const seen = new Set();
  const tracks = input.tracks.slice(0, 20).map((t, ti) => {
    const kind = KINDS[t.kind];
    if (!kind) throw new Error(`Track ${ti + 1} has an unknown kind.`);
    const clips = (Array.isArray(t.clips) ? t.clips : []).slice(0, 2000).flatMap((c) => {
      const clipId = id(c.id);
      if (!clipId || seen.has(clipId)) return [];
      seen.add(clipId);
      const base = { id: clipId, type: kind, start: num(c.start, 0, 3600), duration: num(c.duration, 0.05, 3600, 1) };
      if (c.transform && typeof c.transform === "object") base.transform = { x: num(c.transform.x, -100, 200, 50), y: num(c.transform.y, -100, 200, 50), scale: num(c.transform.scale, 0.05, 10, 1), rotation: num(c.transform.rotation, -360, 360, 0) };
      if (c.link) base.link = id(c.link);
      if (kind === "text") return [{ ...base, content: str(c.content, 400), highlight: str(c.highlight, 60), style: c.style && typeof c.style === "object" ? JSON.parse(JSON.stringify(c.style).slice(0, 4000)) : {} }];
      if (kind === "emphasis") return [{ ...base, text: str(c.text, 80), why: str(c.why, 300) }];
      if (kind === "overlay") {
        const source = ["slide", "screen", "broll"].includes(c.source) ? c.source : "slide";
        const o = { ...base, source, asset: id(c.asset), layout: LAYOUTS.includes(c.layout) ? c.layout : source === "broll" ? "full" : "split", side: c.side === "left" ? "left" : "right", name: str(c.name, 120), why: str(c.why, 300) };
        if (source === "slide") o.page = Math.max(1, Math.round(Number(c.page) || 1));
        else o.sourceStart = num(c.sourceStart, 0, 36000);
        if (c.focus && typeof c.focus === "object") o.focus = { x: num(c.focus.x, 0, 100), y: num(c.focus.y, 0, 100), w: num(c.focus.w, 1, 100, 100), h: num(c.focus.h, 1, 100, 100) };
        return o.asset ? [o] : [];
      }
      if (kind === "caption") {
        const words = (Array.isArray(c.words) ? c.words : []).slice(0, 60).map((w) => ({ text: str(w.text, 60), s: num(w.s, 0, 3600), e: num(w.e, 0, 3600) })).filter((w) => w.text.trim());
        return [{ ...base, words }];
      }
      const media = { ...base, sourceStart: num(c.sourceStart, 0, sourceDuration), speed: num(c.speed, 0.25, 4, 1), volume: num(c.volume, 0, 2, 1) };
      media.sourceEnd = num(c.sourceEnd, media.sourceStart, sourceDuration, media.sourceStart + media.duration * media.speed);
      if (c.sound) Object.assign(media, { sound: id(c.sound), name: str(c.name, 120), loop: c.loop !== false });
      return [media];
    });
    return { id: id(t.id) || `track${ti}`, kind, role: t.role === "music" || t.role === "voice" ? t.role : undefined, name: str(t.name, 40) || kind, hidden: Boolean(t.hidden), locked: Boolean(t.locked), muted: Boolean(t.muted), clips };
  });
  return {
    version: VERSION,
    projectId: project.id,
    clipId: clip.id,
    rev: Number.isInteger(input.rev) ? input.rev : 0,
    seededAt: str(input.seededAt, 40),
    aspect: ASPECTS[input.aspect] ? input.aspect : "9:16",
    fps: 30,
    design: normalizeDesign({ ...(input.design || {}), aspect: ASPECTS[input.aspect] ? input.aspect : undefined }),
    tracks,
  };
}

const byStart = (a, b) => a.start - b.start;
const visible = (doc, pred) => doc.tracks.filter((t) => pred(t) && !t.hidden);

/** How long the edit plays: to the end of the last picture (or of anything, when there's no picture). */
export function documentDuration(doc) {
  const ends = (tracks) => tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration));
  const picture = ends(doc.tracks.filter((t) => t.kind === "video"));
  return r3(Math.max(0.5, ...(picture.length ? picture : ends(doc.tracks))));
}

/**
 * Composition inputs for lib/compose.js buildCompositionHtml, from a document. The composer still plays one title
 * and regroups captions itself; the editor-owned composer that honors every clip exactly comes with export.
 */
export async function compositionInputs(doc, { project, clip, videoSrc }) {
  const D = documentDuration(doc);
  const design = normalizeDesign({ ...doc.design, aspect: doc.aspect });

  const parts = visible(doc, (t) => t.kind === "video")
    .flatMap((t) => t.clips)
    .sort(byStart)
    .map((c) => ({ t: r3(c.start), dur: r3(c.duration), src: videoSrc, mediaStart: c.sourceStart, start: c.sourceStart, end: c.sourceEnd }));

  const words = visible(doc, (t) => t.kind === "caption")
    .flatMap((t) => t.clips)
    .sort(byStart)
    .flatMap((c) => c.words.map((w) => ({ text: w.text, s: r3(c.start + w.s), e: r3(Math.min(c.start + c.duration, c.start + w.e)) })))
    .filter((w) => w.s < Math.min(D, 3600));

  const title = visible(doc, (t) => t.kind === "text").flatMap((t) => t.clips).sort(byStart)[0];
  const end = title ? title.start + title.duration : 0;
  Object.assign(design, {
    // Editorial Talk has no headline (lib/compose.js normalizeDesign), even with a title left on the timeline.
    showTitle: design.style !== "talk" && Boolean(title?.content?.trim()),
    titleOut: title && end < D - 1 ? Math.min(60, Math.max(1, Math.round(end))) : 0,
    ...(title?.style?.preset && ["card", "pill", "plain"].includes(title.style.preset) ? { titleStyle: title.style.preset } : {}),
  });

  const musicTrack = visible(doc, (t) => t.kind === "audio" && t.role === "music" && !t.muted)[0];
  const bed = musicTrack?.clips.find((c) => c.sound);
  const sound = bed ? await getTrack(bed.sound) : null;
  const voiceTrack = doc.tracks.find((t) => t.kind === "audio" && t.role === "voice");

  return {
    clip: { ...clip, title: title?.content || clip.title, highlight: title ? title.highlight : clip.highlight },
    words: [],
    design,
    parts,
    timeline: { duration: D, parts, words },
    music: sound ? { src: `/sounds-media/${encodeURIComponent(sound.file)}`, duration: sound.duration, volume: houseLevel(bed.volume) } : null,
    muteVoice: !voiceTrack || voiceTrack.muted || voiceTrack.hidden,
  };
}

/** The creator's saved document for a clip, or null when they haven't edited it in the timeline editor. */
export async function readSavedDocument(projectId, clipId) {
  const { DATA_DIR } = await import("./media.js");
  try {
    const doc = JSON.parse(await fs.readFile(path.join(DATA_DIR, projectId, `${clipId}.json`), "utf8"));
    // Only a document the creator actually edited; "start over" hands the clip back to the engine.
    return doc?.edited && Array.isArray(doc.tracks) ? doc : null;
  } catch {
    return null;
  }
}

/**
 * A saved document as a render plan, in the shape lib/clipplan.js planClip returns, so an edited clip renders and
 * gets reviewed exactly as the creator left it: every video clip where they put it (trims, splits, moves), caption
 * words as they typed them, their title, their music level, a muted voice track staying muted.
 */
export function documentPlan(doc) {
  const shown = (pred) => doc.tracks.filter((t) => pred(t) && !t.hidden).flatMap((t) => t.clips);
  const parts = shown((t) => t.kind === "video")
    .sort(byStart)
    .map((c) => ({ start: r3(c.sourceStart), end: r3(c.sourceEnd ?? c.sourceStart + c.duration), t: r3(c.start), dur: r3(c.duration) }))
    .filter((p) => p.end - p.start >= 0.05);
  const duration = documentDuration(doc);
  const words = shown((t) => t.kind === "caption")
    .sort(byStart)
    .flatMap((c) => c.words.map((w) => ({ text: w.text, s: r3(c.start + w.s), e: r3(Math.min(c.start + c.duration, c.start + w.e)) })))
    .filter((w) => w.s < duration);
  const title = shown((t) => t.kind === "text").sort(byStart)[0] || null;
  const musicTrack = doc.tracks.find((t) => t.kind === "audio" && t.role === "music");
  const bed = musicTrack && !musicTrack.muted && !musicTrack.hidden ? musicTrack.clips.find((c) => c.sound) : null;
  const voiceTrack = doc.tracks.find((t) => t.kind === "audio" && t.role === "voice");
  return {
    parts,
    words,
    duration,
    hook: null,
    stitched: [],
    fromEditor: true,
    title: title ? { content: title.content, highlight: title.highlight, start: title.start, end: title.start + title.duration, preset: title.style?.preset } : null,
    music: bed ? { sound: bed.sound, level: houseLevel(bed.volume) } : musicTrack ? { sound: null, level: 0 } : null,
    muteVoice: !voiceTrack || voiceTrack.muted || voiceTrack.hidden,
    design: doc.design,
    aspect: doc.aspect,
  };
}
