// The AI director: reads what the creator says (the timeline's own caption words, so every time is already on the
// edit's clock), looks at their slides and screen recordings, and decides where each one appears and how, plus
// the few lines that earn a big emphasis caption. The result is plain timeline clips the creator can still move.
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { describeClaudeError, hasClaudeKey } from "../../lib/analyze.js";
import { FFMPEG, ROOT, run } from "../../lib/tools.js";
import { documentDuration } from "../document.js";
import { assetBriefs } from "./assets.js";

const MODEL = "claude-opus-5";
const STYLE_FILE = path.join(ROOT, "shared", "EDITOR_STYLE.md");
const r2 = (n) => Math.round(n * 100) / 100;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mmss = (t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${(t % 60).toFixed(1).padStart(4, "0")}`;

const Box = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).describe("Region of the slide image to zoom into, in % of the image (0–100). Omit to show the whole slide.");
const CueSchema = z.object({
  concept: z.string().describe("One sentence: the editing idea for this video."),
  cues: z.array(
    z.object({
      type: z.enum(["slide", "screen", "broll", "emphasis"]),
      start: z.number().describe("Seconds on the edit timeline"),
      end: z.number(),
      asset: z.string().optional().describe("Asset id (slide / screen / broll)"),
      page: z.number().optional().describe("Slide page number (slide)"),
      layout: z.enum(["full", "split", "pip", "card"]).optional().describe("slide: full = slide fills the frame, speaker in a corner bubble; split = speaker pushed to one side, slide on the other; card = floating card over the speaker. screen: split. broll: full"),
      side: z.enum(["left", "right"]).optional().describe("Which side the slide / phone goes on"),
      sourceStart: z.number().optional().describe("screen / broll: second of the recording to start from"),
      focus: Box.optional(),
      text: z.string().optional().describe("emphasis: the 2–6 words shown big, exactly as spoken (fix capitalization only)"),
      why: z.string(),
    }),
  ),
});

const SYSTEM = `You are the senior editor for a premium creator brand (doctors, chiropractors and physical therapists growing a business and a lifestyle brand). You turn a talking-head recording plus the creator's slides and phone screen recordings into a thought-out edit, the way the best YouTube education channels do it.

You decide, from what is said and exactly when:
- slide: a slide appears when the speaker starts talking about what's on it, and leaves when they move on. Choose the page whose content matches the words. Dense document pages: set focus to the section being discussed so it's readable on a phone.
- screen: when the speaker shows or describes something on their phone or an app ("let me show you", "on my phone", "this app", "here's the dashboard"), the speaker is pushed to one side and the screen recording plays on the other. Pick sourceStart so the relevant part of the recording plays.
- broll: a landscape recording that illustrates what's said, shown full frame for a few seconds.
- emphasis: the handful of lines that are the point of a section (a number, an outcome, a hard truth). They appear as huge glowing words behind the speaker. Scarce: roughly one per 20–30 seconds at most, never during a slide or screen cue, 2–6 words, the speaker's exact words.

Rules:
- Only use assets and pages that exist. Never invent content.
- Cue times must sit inside the words that justify them: start on the first word of the idea (a beat early is fine), end when the idea ends.
- slide and screen cues last 3–14 seconds (screen recordings may run up to 25), never overlap each other, and leave at least 1.5 seconds of plain speaker between them so the edit breathes.
- Not every slide has to be used; a slide that matches nothing said stays out.
- Premium voice: no emoji, no ALL CAPS, no hype.`;

/** Caption words on the edit timeline, grouped into short timed lines for the prompt. */
function transcriptLines(doc) {
  const words = doc.tracks
    .filter((t) => t.kind === "caption" && !t.hidden)
    .flatMap((t) => t.clips)
    .flatMap((c) => c.words.map((w) => ({ text: w.text, s: c.start + w.s, e: c.start + w.e })))
    .sort((a, b) => a.s - b.s);
  const lines = [];
  let line = null;
  for (const w of words) {
    if (!line || w.s - line.e > 0.7 || line.words.length >= 14 || /[.?!]$/.test(line.words.at(-1))) {
      line = { s: w.s, e: w.e, words: [] };
      lines.push(line);
    }
    line.words.push(w.text);
    line.e = w.e;
  }
  return { words, lines: lines.map((l) => `[${mmss(l.s)}–${mmss(l.e)}] ${l.words.join(" ")}`) };
}

async function imageBlock(file, cacheDir, name) {
  const out = path.join(cacheDir, `${name}.jpg`);
  if (!existsSync(out)) {
    await fs.mkdir(cacheDir, { recursive: true });
    await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", file, "-vf", "scale='if(gt(iw,ih),min(900,iw),-2)':'if(gt(iw,ih),-2,min(900,ih))'", "-q:v", "6", out]);
  }
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await fs.readFile(out)).toString("base64") } };
}

/**
 * Plan the overlays for a document.
 * @returns {{ mode: "claude"|"demo", concept, notice?, cues[] }}  cues validated against the document and assets
 */
export async function planDirector(doc, { projectId, want = { slides: true, screens: true, emphasis: true }, note = "" } = {}) {
  const assets = await assetBriefs(projectId);
  const { words, lines } = transcriptLines(doc);
  if (!words.length) throw new Error("This edit has no captions to read, so the director can't tell what's being said.");
  const D = documentDuration(doc);

  let result;
  if (hasClaudeKey()) {
    try {
      result = { mode: "claude", ...(await askClaude({ doc, assets, lines, D, want, note, projectId })) };
    } catch (err) {
      console.error("Director:", err);
      result = { mode: "demo", notice: describeClaudeError(err).replace("these are demo picks", "this is a simple automatic plan"), ...demoPlan({ words, assets, D, want }) };
    }
  } else {
    result = { mode: "demo", notice: "No Claude key is set, so this is a simple automatic plan.", ...demoPlan({ words, assets, D, want }) };
  }
  result.cues = validateCues(result.cues, { assets, words, D, want });
  return result;
}

async function askClaude({ assets, lines, D, want, note, projectId }) {
  const style = await fs.readFile(STYLE_FILE, "utf8").catch(() => "");
  const cache = path.join(ROOT, "data", "editor", projectId, "assets", ".director");
  const content = [];
  const text = (t) => content.push({ type: "text", text: t });

  text(`Edit length: ${D.toFixed(1)} s.\nWanted: ${Object.entries(want).filter(([, v]) => v).map(([k]) => k).join(", ") || "nothing"}.${note ? `\nCreator's note: ${note}` : ""}\n\nTranscript on the edit timeline:\n${lines.join("\n")}`);
  let images = 0;
  for (const a of assets) {
    if (a.slides?.length && want.slides) {
      text(`\nSlide deck "${a.name}" (asset ${a.id}), ${a.slides.length} pages:${a.slides.map((s) => (s.text ? `\n  page ${s.page}: ${s.text.slice(0, 400)}` : "")).join("")}`);
      for (const s of (a.slideImages || []).slice(0, 40)) {
        if (images >= 90) break;
        text(`asset ${a.id} page ${s.page}:`);
        content.push(await imageBlock(s.path, cache, `${a.id}-p${s.page}`));
        images++;
      }
    }
    if (a.kind === "video" && (a.role === "screen" ? want.screens : want.slides || want.screens)) {
      text(`\n${a.role === "screen" ? "Phone screen recording" : "B-roll video"} "${a.name}" (asset ${a.id}), ${a.duration?.toFixed(1)} s, ${a.orientation}. Frames:`);
      for (const f of a.frames || []) {
        if (images >= 90) break;
        text(`at ${f.at.toFixed(1)} s:`);
        content.push(await imageBlock(f.path, cache, `${a.id}-f${f.at}`));
        images++;
      }
    }
  }
  if (!assets.length) text("\nNo slides or recordings were uploaded: plan emphasis cues only.");

  const client = new Anthropic();
  // Streamed: a long video's transcript plus adaptive thinking runs well past the ceiling a plain call allows, and
  // a truncated answer comes back looking like a broken key (lib/longedit.js uses the same pattern).
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: betaZodOutputFormat(CueSchema) },
    system: SYSTEM + (style ? `\n\nThe creator's reference edits were studied; follow this style guide where it applies:\n\n${style.slice(0, 24000)}` : ""),
    messages: [{ role: "user", content }],
  });
  const response = await stream.finalMessage();
  if (!response.parsed_output) throw new Error(response.stop_reason === "max_tokens" ? "The plan ran too long" : "No plan came back");
  return response.parsed_output;
}

/** Without Claude: slide text matched to what's said, phone recordings where the speaker says "show", emphasis on numbers. */
function demoPlan({ words, assets, D, want }) {
  const cues = [];
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9$% ]/g, " ");
  const windows = [];
  for (let i = 0; i < words.length; i += 12) windows.push({ s: words[i].s, e: words[Math.min(words.length - 1, i + 24)].e, text: norm(words.slice(i, i + 24).map((w) => w.text).join(" ")) });
  if (want.slides) {
    for (const a of assets.filter((x) => x.slides)) {
      for (const s of a.slides) {
        const keys = new Set(norm(s.text || "").split(/\s+/).filter((k) => k.length > 4));
        if (keys.size < 2) continue;
        const best = windows.map((w) => ({ w, score: w.text.split(/\s+/).filter((k) => keys.has(k)).length })).sort((x, y) => y.score - x.score)[0];
        if (best?.score >= 3) cues.push({ type: "slide", asset: a.id, page: s.page, start: best.w.s, end: Math.min(best.w.s + 7, best.w.e), layout: "split", side: "right", why: "Slide words match what's said" });
      }
    }
  }
  if (want.screens) {
    for (const a of assets.filter((x) => x.role === "screen")) {
      const hit = windows.find((w) => /\b(show you|my phone|this app|look at this|on screen|dashboard)\b/.test(w.text));
      if (hit) cues.push({ type: "screen", asset: a.id, start: hit.s, end: Math.min(hit.s + Math.min(12, a.duration || 12), D), sourceStart: 0, layout: "split", side: "right", why: "Speaker says they're showing something" });
    }
  }
  if (want.emphasis) {
    let last = -30;
    for (let i = 0; i < words.length; i++) {
      if (!/\d|\$/.test(words[i].text) || words[i].s - last < 25) continue;
      const span = words.slice(Math.max(0, i - 1), i + 3);
      cues.push({ type: "emphasis", start: span[0].s, end: span.at(-1).e + 0.6, text: span.map((w) => w.text).join(" "), why: "A number worth landing" });
      last = words[i].s;
    }
  }
  return { concept: "Slides where their words come up, phone demos side by side, and the key numbers made big.", cues };
}

/**
 * Put a plan on the timeline: an "Overlays" track and an "Emphasis" track above the titles, replacing whatever
 * the director put there before (the creator can undo). Emphasis stays inside one video piece so its cutout lines up.
 */
export function applyCues(doc, cues, assets) {
  const names = new Map(assets.map((a) => [a.id, a.name]));
  const videos = doc.tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips);
  const overlays = [];
  const emphasis = [];
  let n = 0;
  for (const c of cues) {
    const base = { id: `${c.type === "emphasis" ? "e" : "o"}${++n}`, start: c.start, duration: r2(c.end - c.start), why: c.why };
    if (c.type === "emphasis") {
      const piece = videos.find((v) => c.start >= v.start - 1e-3 && c.start < v.start + v.duration);
      const end = piece ? Math.min(c.end, piece.start + piece.duration) : c.end;
      if (end - c.start < 0.8) continue;
      emphasis.push({ ...base, type: "emphasis", duration: r2(end - c.start), text: c.text });
    } else {
      overlays.push({ ...base, type: "overlay", source: c.type, asset: c.asset, name: names.get(c.asset) || "", layout: c.layout, side: c.side, ...(c.type === "slide" ? { page: c.page, ...(c.focus ? { focus: c.focus } : {}) } : { sourceStart: c.sourceStart || 0 }) });
    }
  }
  const keep = doc.tracks.filter((t) => t.kind !== "overlay" && t.kind !== "emphasis");
  const prior = (kind) => doc.tracks.find((t) => t.kind === kind);
  doc.tracks = [
    { id: "overlays", kind: "overlay", name: "Overlays", hidden: prior("overlay")?.hidden || false, locked: false, clips: overlays },
    { id: "emphasis", kind: "emphasis", name: "Big captions", hidden: prior("emphasis")?.hidden || false, locked: false, clips: emphasis },
    ...keep,
  ];
  return doc;
}

/** Keep only cues that point at real things, fit the edit, and don't collide. */
export function validateCues(cues, { assets, words, D, want }) {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const out = [];
  const panels = [];
  const sorted = [...(cues || [])].sort((a, b) => a.start - b.start);
  for (const c of sorted) {
    let start = r2(clamp(c.start, 0, D));
    let end = r2(clamp(c.end, 0, D));
    if (end - start < 0.8) continue;
    if (c.type === "emphasis") {
      if (!want.emphasis || !c.text?.trim()) continue;
      end = Math.min(end, start + 4.5);
      out.push({ type: "emphasis", start, end: r2(end), text: c.text.trim().replace(/[.,;:]+$/, "").slice(0, 60), why: c.why || "" });
      continue;
    }
    const asset = byId.get(c.asset);
    if (!asset) continue;
    if (c.type === "slide") {
      if (!want.slides || !asset.slides?.some((s) => s.page === c.page)) continue;
      end = Math.min(end, start + 16);
    } else {
      if (asset.kind !== "video" || !(c.type === "screen" ? want.screens : want.slides || want.screens)) continue;
      const sourceStart = clamp(c.sourceStart || 0, 0, Math.max(0, (asset.duration || 0) - 1));
      end = Math.min(end, start + Math.min(c.type === "screen" ? 30 : 8, (asset.duration || 8) - sourceStart));
      c.sourceStart = r2(sourceStart);
    }
    if (end - start < 1.5) continue;
    // No two panels at once, and a breath of plain speaker between them.
    const prev = panels.at(-1);
    if (prev && start < prev.end + 1.2) {
      start = r2(prev.end + 1.2);
      if (end - start < 2) continue;
    }
    const cue = { type: c.type, asset: asset.id, start, end: r2(end), why: c.why || "" };
    if (c.type === "slide") Object.assign(cue, { page: c.page, layout: ["full", "split", "pip", "card"].includes(c.layout) ? c.layout : "split", side: c.side === "left" ? "left" : "right", ...(c.focus && c.focus.w > 5 && c.focus.h > 5 ? { focus: { x: clamp(c.focus.x, 0, 95), y: clamp(c.focus.y, 0, 95), w: clamp(c.focus.w, 5, 100), h: clamp(c.focus.h, 5, 100) } } : {}) });
    if (c.type === "screen") Object.assign(cue, { layout: "split", side: c.side === "left" ? "left" : "right", sourceStart: c.sourceStart });
    if (c.type === "broll") Object.assign(cue, { layout: "full", sourceStart: c.sourceStart });
    panels.push(cue);
    out.push(cue);
  }
  // Emphasis never sits on top of a panel, and stays scarce: at least 12 seconds between two of them.
  let lastEmphasis = -Infinity;
  return out
    .filter((c) => c.type !== "emphasis" || !panels.some((p) => c.start < p.end && c.end > p.start))
    .sort((a, b) => a.start - b.start)
    .filter((c) => {
      if (c.type !== "emphasis") return true;
      if (c.start - lastEmphasis < 12) return false;
      lastEmphasis = c.start;
      return true;
    });
}
