// Big glowing words behind the speaker on every clip, not just ones edited on the timeline. The important lines
// lib/emphasis.js picked become "emphasis" clips on a stand-in editor document; the Video Editor session's director
// (editor/director/) cuts the speaker out for just those seconds and lays the words between the footage and the
// cutout, the same way it does for a hand-edited clip.
import { placeEmphasis } from "./emphasis.js";
import { trackerBinary } from "./subject.js";
import { workingFile } from "./work.js";
import { run } from "./tools.js";
// The editor's modules import the render pipeline themselves, so they're loaded when first needed, not up front.
const director = () => Promise.all([import("../editor/director/matte.js"), import("../editor/director/render.js")]);

const r2 = (n) => Math.round(n * 100) / 100;
const MATTE_WAIT_MS = 8 * 60_000;

/** The stand-in document: the cut's pieces as video clips and the big words as emphasis clips. */
export function bigWordsDocument(plan, emphasisPlan, design) {
  const videos = plan.parts.map((p, i) => ({ id: `v${i + 1}`, type: "video", start: p.t, duration: p.dur, sourceStart: p.start, sourceEnd: p.end, speed: 1 }));
  const talkEnd = plan.duration;
  const { pops } = placeEmphasis(plan.words, emphasisPlan, talkEnd);
  const emphasis = [];
  for (const [i, p] of pops.entries()) {
    const start = r2(Math.max(0, p.s - 0.08));
    // A cutout only lines up inside one piece of footage, so the words leave when that piece ends.
    const piece = videos.find((v) => start >= v.start - 1e-3 && start < v.start + v.duration);
    if (!piece) continue;
    const end = Math.min(piece.start + piece.duration, Math.max(p.e + 0.35, start + 1.5), talkEnd - 0.2);
    if (end - start < 0.9) continue;
    emphasis.push({ id: `e${i + 1}`, type: "emphasis", start, duration: r2(end - start), text: p.text });
  }
  return {
    aspect: design.aspect,
    design,
    tracks: [
      { id: "emphasis", kind: "emphasis", name: "Big captions", hidden: false, locked: false, clips: emphasis },
      { id: "video", kind: "video", name: "Video", hidden: false, locked: false, clips: videos },
    ],
  };
}

/**
 * Add the big words behind the speaker to a composition lib/pipeline.js just built. Waits for the cutouts (made one
 * at a time, cached per stretch of footage); a word whose cutout fails still shows, in front instead of behind.
 * @returns the number of big words placed
 */
/**
 * Whether a person is on screen through a stretch of the source: Apple Vision looks at a frame every 0.4 s. A title
 * card or graphic already in the footage has nobody to put the words behind, and a second line of text on top of it
 * reads as a mess.
 */
async function personOnScreen(project, from, to, signal) {
  const bin = await trackerBinary();
  if (!bin) return true;
  const out = await run(bin, [workingFile(project), String(from), String(to), "0.4"], { signal }).catch(() => "");
  const samples = out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  if (!samples.length) return true;
  const seen = samples.filter((s) => (s.faces || []).some((f) => f[4] >= 0.5)).length;
  return seen / samples.length >= 0.75;
}

export async function applyBigWords({ project, plan, emphasisPlan, design, compositionDir, signal, onStage }) {
  if (!emphasisPlan) return 0;
  const doc = bigWordsDocument(plan, emphasisPlan, design);
  const video = doc.tracks[1].clips;
  const kept = [];
  for (const c of doc.tracks[0].clips) {
    const piece = video.find((v) => c.start >= v.start - 1e-3 && c.start < v.start + v.duration);
    const from = piece.sourceStart + (c.start - piece.start);
    if (await personOnScreen(project, from, from + c.duration, signal)) kept.push(c);
  }
  doc.tracks[0].clips = kept;
  const count = doc.tracks[0].clips.length;
  if (!count) return 0;
  const [{ attachMattes, ensureMattes }, { applyEditorLayers }] = await director();
  onStage?.(`Cutting you out for ${count} big word${count === 1 ? "" : "s"}…`);
  const started = Date.now();
  for (;;) {
    signal?.throwIfAborted();
    const status = Object.values(ensureMattes(project, doc));
    if (!status.some((s) => s.state === "queued" || s.state === "running")) break;
    if (Date.now() - started > MATTE_WAIT_MS) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const ready = attachMattes(project, doc).size;
  if (ready < count) console.error(`[${project.id}] big words: ${count - ready} cutout(s) missing; those words show in front`);
  await applyEditorLayers(project, doc, compositionDir);
  return count;
}
