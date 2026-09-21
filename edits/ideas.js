// Style ideas: the creator's references (notes, example edits, screenshots) modeled into recipes the director
// follows, feedback on finished edits, and STYLE.md — the edit taste distilled from all of it.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { FFMPEG, ROOT, run } from "../lib/tools.js";
import { analyzeSource } from "./analyze.js";
import { analyzeMusic } from "./beats.js";
import { hasClaudeKey } from "./director.js";
import { EFFECTS, LOOKS, SPEEDS, TEXT_STYLES, TRANSITIONS } from "./looks.js";
import { DATA_DIR } from "./store.js";

const MODEL = "claude-opus-5";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIBRARY = path.join(HERE, "ideas.json");
const STYLE = path.join(HERE, "STYLE.md");
export const IDEAS_MEDIA = path.join(DATA_DIR, "ideas");

const ids = (o) => Object.keys(o);
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Library file: edits/ideas.json → { ideas: [...], feedback: [...] }

async function load() {
  try {
    const data = JSON.parse(await fs.readFile(LIBRARY, "utf8"));
    return { ideas: data.ideas || [], feedback: data.feedback || [] };
  } catch (err) {
    if (err.code === "ENOENT") return { ideas: [], feedback: [] };
    throw err; // a hand edit broke the JSON; never overwrite it
  }
}

let chain = Promise.resolve();
function mutate(fn) {
  const next = chain.then(async () => {
    const lib = await load();
    const result = await fn(lib);
    const tmp = `${LIBRARY}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(lib, null, 2)}\n`);
    await fs.rename(tmp, LIBRARY);
    return result;
  });
  chain = next.catch(() => {});
  return next;
}

export const listIdeas = async () => (await load()).ideas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
export const listFeedback = async () => (await load()).feedback;
export async function readStyle() {
  return fs.readFile(STYLE, "utf8").catch(() => "");
}

const IMAGE_RE = /\.(jpe?g|png|webp|gif|heic|avif|bmp|tiff?)$/i;
const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

/** files: [{ path, originalname }] from multer. Moves them into the idea's media folder and starts modeling. */
export async function addIdea({ title, notes, url, files = [] }) {
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const dir = path.join(IDEAS_MEDIA, id);
  await fs.mkdir(dir, { recursive: true });
  const media = [];
  for (const [k, f] of files.entries()) {
    const ext = path.extname(f.originalname).toLowerCase();
    const type = VIDEO_RE.test(ext) ? "video" : IMAGE_RE.test(ext) ? "image" : null;
    if (!type) {
      await fs.rm(f.path, { force: true });
      continue;
    }
    const file = `${type}-${k + 1}${ext}`;
    await fs.rename(f.path, path.join(dir, file));
    media.push({ file, type, name: f.originalname });
  }
  if (!clean(notes) && !clean(url) && !media.length) throw new Error("Add a note, a link, or a reference video or image.");

  const idea = {
    id,
    title: clean(title).slice(0, 80) || (media[0] ? media[0].name.replace(/\.[^.]+$/, "") : clean(notes).split(" ").slice(0, 5).join(" ")),
    notes: String(notes || "").trim().slice(0, 4000),
    url: clean(url).slice(0, 500) || null,
    media,
    status: "modeling",
    error: null,
    stats: null,
    recipe: null,
    createdAt: new Date().toISOString(),
  };
  await mutate((lib) => lib.ideas.push(idea));
  queueModel(id);
  return idea;
}

export async function updateIdea(id, { title, notes, url }) {
  const idea = await mutate((lib) => {
    const found = lib.ideas.find((x) => x.id === id);
    if (!found) throw new Error("Idea not found");
    if (typeof title === "string" && clean(title)) found.title = clean(title).slice(0, 80);
    if (typeof url === "string") found.url = clean(url).slice(0, 500) || null;
    if (typeof notes === "string" && notes.trim() !== found.notes) {
      found.notes = notes.trim().slice(0, 4000);
      found.status = "modeling";
    }
    return found;
  });
  if (idea.status === "modeling") queueModel(id);
  return idea;
}

export async function remodelIdea(id) {
  const idea = await mutate((lib) => {
    const found = lib.ideas.find((x) => x.id === id);
    if (!found) throw new Error("Idea not found");
    found.status = "modeling";
    found.error = null;
    return found;
  });
  queueModel(id);
  return idea;
}

export async function deleteIdea(id) {
  if (!/^[a-z0-9]+-[a-f0-9]{6}$/.test(id)) throw new Error("Idea not found");
  await mutate((lib) => {
    lib.ideas = lib.ideas.filter((x) => x.id !== id);
  });
  await fs.rm(path.join(IDEAS_MEDIA, id), { recursive: true, force: true });
  queueDistill();
}

/** A rating on a finished edit ("fire" | "good" | "meh"), with an optional note and what the edit used. */
export async function recordFeedback({ editId, version, rating, note, plan }) {
  if (!["fire", "good", "meh"].includes(rating)) throw new Error("rating must be fire, good or meh");
  const used = plan
    ? {
        look: plan.look,
        textStyle: plan.textStyle,
        bpm: plan.music?.bpm ?? null,
        avgShot: +(plan.length / plan.shots.length).toFixed(2),
        transitions: tally(plan.shots.slice(1).map((s) => s.transition.type)),
        effects: tally(plan.shots.flatMap((s) => s.effects)),
        speeds: tally(plan.shots.map((s) => s.speed).filter((s) => s !== "normal")),
      }
    : null;
  const entry = { editId, version, rating, note: String(note || "").trim().slice(0, 1000), used, at: new Date().toISOString() };
  await mutate((lib) => {
    lib.feedback = lib.feedback.filter((f) => !(f.editId === editId && f.version === version));
    lib.feedback.push(entry);
    lib.feedback = lib.feedback.slice(-80);
  });
  queueDistill();
  return entry;
}

function tally(list) {
  const out = {};
  for (const x of list) out[x] = (out[x] || 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------
// Modeling an idea into a recipe

const RecipeSchema = z.object({
  name: z.string().describe("catchy 2–4 word name for this style"),
  vibe: z.string().describe("one sentence on how it feels"),
  energy: z.enum(["chill", "medium", "hype"]),
  beats_per_shot: z.number().describe("typical shot length in beats, 0.5–8"),
  pacing: z.string().describe("how cut rhythm behaves over the edit"),
  transitions: z.array(z.object({ type: z.enum(ids(TRANSITIONS)), weight: z.number().describe("1–10, how often it's used") })),
  effects: z.array(z.object({ type: z.enum(ids(EFFECTS)), weight: z.number() })),
  speeds: z.array(z.object({ type: z.enum(ids(SPEEDS)), weight: z.number() })),
  look: z.enum(ids(LOOKS)),
  look_intensity: z.number().describe("0.3–1"),
  grade_notes: z.string(),
  text_style: z.enum([...ids(TEXT_STYLES), "none"]),
  text_usage: z.string().describe("when and how on-screen text appears"),
  accent: z.string().describe("accent color RRGGBB"),
  music: z.string().describe("genre, tempo and mood of music that fits"),
  structure: z.string().describe("how the edit is arranged over time"),
  rules: z.array(z.string()).describe("3–8 concrete, reusable editing rules that capture this style"),
});

async function toJpeg(file) {
  const out = `${file}.claude.jpg`;
  await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-frames:v", "1", "-vf", "scale='min(1568,iw)':-2", "-q:v", "3", out]);
  return out;
}

async function measureVideo(file, dir) {
  const a = await analyzeSource(file, dir, { letter: "R", maxSheets: 1 });
  const avg = (key) => +(a.moments.reduce((s, m) => s + m[key], 0) / Math.max(1, a.moments.length)).toFixed(2);
  let bpm = null;
  let period = 0.5;
  if (a.hasAudio) {
    const music = await analyzeMusic(file).catch(() => null);
    if (music?.beats.length > 8) {
      bpm = music.bpm;
      period = music.period;
    }
  }
  const avgShot = a.duration / (a.cuts + 1);
  return {
    duration: +a.duration.toFixed(1),
    orientation: a.orientation,
    fps: a.fps,
    cuts: a.cuts,
    cutsPerSecond: +(a.cuts / a.duration).toFixed(2),
    avgShotSeconds: +avgShot.toFixed(2),
    bpm,
    beatsPerShot: +(avgShot / period).toFixed(1),
    motion: avg("motion"),
    brightness: avg("bright"),
    saturation: avg("sat"),
    sheet: a.sheets[0] ? path.join(dir, a.sheets[0].file) : null,
  };
}

async function modelIdea(id) {
  const idea = (await load()).ideas.find((x) => x.id === id);
  if (!idea) return;
  const dir = path.join(IDEAS_MEDIA, id);
  try {
    const videos = [];
    for (const [k, m] of idea.media.filter((x) => x.type === "video").entries()) {
      videos.push({ name: m.name, ...(await measureVideo(path.join(dir, m.file), path.join(dir, `analysis-${k + 1}`))) });
    }
    const images = idea.media.filter((x) => x.type === "image").slice(0, 8);
    const stats = videos.map(({ sheet, ...rest }) => rest);

    let recipe = hasClaudeKey()
      ? await claudeRecipe(idea, videos, images, dir).catch((err) => {
          console.error(`[idea ${id}] Claude unavailable, modeling from keywords and measurements:`, err.message);
          return { ...heuristicRecipe(idea, stats), notice: `${claudeProblem(err)}, so this recipe comes from your notes and the measurements. Re-model once that's fixed.` };
        })
      : heuristicRecipe(idea, stats);

    await mutate((lib) => {
      const found = lib.ideas.find((x) => x.id === id);
      if (found) Object.assign(found, { status: "ready", error: null, stats, recipe, modeledAt: new Date().toISOString() });
    });
    queueDistill();
  } catch (err) {
    console.error(`[idea ${id}]`, err);
    await mutate((lib) => {
      const found = lib.ideas.find((x) => x.id === id);
      if (found) Object.assign(found, { status: "error", error: err.message });
    });
  }
}

/** Claude looks at the measurements, contact sheets and images and writes the recipe. */
async function claudeRecipe(idea, videos, images, dir) {
  const content = [];
  for (const v of videos) {
    content.push({ type: "text", text: `Reference edit "${v.name}" measured: ${JSON.stringify({ ...v, sheet: undefined })}` });
    if (v.sheet) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await fs.readFile(v.sheet)).toString("base64") } });
  }
  for (const img of images) {
    const jpg = await toJpeg(path.join(dir, img.file)).catch(() => null);
    if (!jpg) continue;
    content.push({ type: "text", text: `Reference image "${img.name}":` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await fs.readFile(jpg)).toString("base64") } });
    await fs.rm(jpg, { force: true });
  }
  content.push({
    type: "text",
    text: `The creator saved this as a style idea for their "dope edits" (music-synced short-form montages).
Title: ${idea.title}
${idea.notes ? `Their notes: ${idea.notes}\n` : ""}${idea.url ? `Link they saved: ${idea.url} (you can't open it; use the title and notes)\n` : ""}
Model it as a reusable recipe our editor can apply to new footage. Stay faithful to what the references and notes actually show: if a reference edit cuts every ${videos[0]?.beatsPerShot ?? "N"} beats, say so. Map what you see onto this vocabulary (pick the closest items):
Looks: ${JSON.stringify(Object.fromEntries(Object.entries(LOOKS).map(([k, v]) => [k, v.description])))}
Transitions: ${JSON.stringify(Object.fromEntries(Object.entries(TRANSITIONS).map(([k, v]) => [k, v.description])))}
Effects: ${JSON.stringify(EFFECTS)}
Speeds: ${JSON.stringify(SPEEDS)}
Text styles: ${JSON.stringify(Object.fromEntries(Object.entries(TEXT_STYLES).map(([k, v]) => [k, v.label])))}`,
  });
  const response = await new Anthropic().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: betaZodOutputFormat(RecipeSchema) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: "You are a senior short-form video editor who reverse-engineers editing styles into precise, reusable recipes.",
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined to model this idea.");
  if (!response.parsed_output) throw new Error("The recipe came back incomplete. Try again.");
  const r = response.parsed_output;
  return {
    name: r.name, vibe: r.vibe, energy: r.energy, beatsPerShot: r.beats_per_shot, pacing: r.pacing,
    transitions: r.transitions, effects: r.effects, speeds: r.speeds,
    look: r.look, lookIntensity: r.look_intensity, gradeNotes: r.grade_notes,
    text: { style: r.text_style, usage: r.text_usage }, accent: r.accent.replace("#", "").toUpperCase(),
    music: r.music, structure: r.structure, rules: r.rules, mode: "claude",
  };
}

const KEYWORDS = {
  transitions: [
    [/whip|swipe|pan\b/, ["whip-left", "whip-up"]], [/flash|strobe/, ["flash"]], [/glitch|digital|datamosh/, ["glitch"]],
    [/zoom (trans|through)|zoom-?in trans/, ["zoom"]], [/dissolve|cross ?fade|smooth/, ["dissolve"]], [/blur/, ["blur"]],
    [/slide/, ["slide"]], [/dip|black/, ["dip-black"]], [/iris|circle/, ["circle"]],
  ],
  effects: [
    [/shake|impact/, ["shake"]], [/rgb|chromatic|aberration|glitch/, ["rgb"]], [/strobe|pulse/, ["strobe"]], [/trail|echo|ghost/, ["echo"]],
    [/letterbox|cinematic bars|bars/, ["letterbox"]], [/punch|zoom/, ["punch"]], [/beat zoom|zoom on (every|each) beat/, ["beat-zoom"]],
    [/ken burns|push in|slow zoom/, ["push"]], [/handheld|rumble/, ["rumble"]], [/invert|negative/, ["invert"]], [/flash/, ["flash"]],
  ],
  speeds: [[/ramp|velocity/, ["ramp"]], [/slow ?-?mo|slow motion/, ["slow", "ramp"]], [/reverse|rewind/, ["reverse"]], [/stutter/, ["stutter"]], [/freeze/, ["freeze"]], [/speed ?up|fast/, ["fast"]]],
  looks: [
    [/teal|orange|blockbuster/, "teal-orange"], [/noir|black and white|b&w|b\/w|monochrome/, "noir"], [/vintage|retro|vhs|old film|90s|80s/, "warm-vintage"],
    [/neon|night|club|cyber/, "neon-night"], [/golden|sunset|summer/, "golden-hour"], [/dream|pastel|soft|airy/, "dream-haze"],
    [/gritty|grunge|raw|street/, "gritty"], [/bleach|desat/, "bleach"], [/cold|blue|winter|crisp/, "cold-crisp"], [/film|moody|matte|cinematic/, "moody-film"],
  ],
};

function heuristicRecipe(idea, stats) {
  const text = `${idea.title} ${idea.notes} ${idea.url || ""}`.toLowerCase();
  const pick = (table) => {
    const out = {};
    for (const [re, items] of table) if (re.test(text)) for (const it of items) out[it] = (out[it] || 0) + 5;
    return Object.entries(out).map(([type, weight]) => ({ type, weight }));
  };
  const v = stats[0];
  const hype = /hype|hard|aggressive|phonk|drill|trap|intense|fast|crazy|energy/.test(text) || (v && v.cutsPerSecond > 1.2);
  const chill = /chill|calm|lofi|lo-fi|smooth|aesthetic|slow|vibe/.test(text) || (v && v.cutsPerSecond < 0.35);
  const transitions = pick(KEYWORDS.transitions);
  transitions.unshift({ type: "cut", weight: hype ? 10 : 6 });
  let look = KEYWORDS.looks.find(([re]) => re.test(text))?.[1];
  if (!look && v) look = v.saturation < 0.1 ? "noir" : v.saturation < 0.2 ? "moody-film" : v.saturation > 0.45 ? "natural" : "teal-orange";
  const textStyle = /impact|slam|big text|bold text/.test(text) ? "slam" : /neon/.test(text) ? "neon" : /minimal|clean/.test(text) ? "minimal" : /caption|subtitle/.test(text) ? "clean" : "none";
  return {
    name: idea.title,
    vibe: idea.notes ? idea.notes.split(/[.!\n]/)[0].slice(0, 140) : "Modeled from a reference.",
    energy: hype ? "hype" : chill ? "chill" : "medium",
    beatsPerShot: v ? Math.min(8, Math.max(0.5, v.beatsPerShot)) : hype ? 1.5 : chill ? 4 : 2,
    pacing: v ? `Reference cuts about every ${v.avgShotSeconds}s (${v.cutsPerSecond} cuts/sec${v.bpm ? ` at ${v.bpm} BPM` : ""}).` : "",
    transitions,
    effects: pick(KEYWORDS.effects),
    speeds: pick(KEYWORDS.speeds),
    look: look || "natural",
    lookIntensity: 0.85,
    gradeNotes: "",
    text: { style: textStyle, usage: "" },
    accent: null,
    music: "",
    structure: "",
    rules: idea.notes ? idea.notes.split(/\n|(?<=[.!])\s+/).map((s) => s.trim()).filter((s) => s.length > 6).slice(0, 8) : [],
    mode: "keywords",
  };
}

let modelChain = Promise.resolve();
function queueModel(id) {
  modelChain = modelChain.then(() => modelIdea(id)).catch((err) => console.error("Idea modeling failed:", err));
}

// ---------------------------------------------------------------------------
// STYLE.md — the taste across every idea and rating

let distillTimer = null;
function queueDistill() {
  clearTimeout(distillTimer);
  distillTimer = setTimeout(() => distillStyle().catch((err) => console.error("Style refresh failed:", err)), 1500);
}

export async function distillStyle() {
  const { ideas, feedback } = await load();
  const ready = ideas.filter((i) => i.recipe);
  if (!ready.length && !feedback.length) {
    // Nothing left to learn from (e.g. the last idea was deleted): don't keep a guide built from it.
    await fs.rm(STYLE, { force: true });
    return "";
  }

  let body;
  if (hasClaudeKey()) {
    const response = await new Anthropic().messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: "You distill a video creator's editing taste into a tight, practical style guide an editor follows on every new edit.",
      messages: [
        {
          role: "user",
          content: `Write STYLE.md for this creator's "dope edits". Markdown, under 450 words: a one-paragraph summary of their taste, then sections for Pacing, Transitions, Effects & speed, Color, Text, Music & sound, and Avoid. Be concrete (beats per shot, which transitions, how often). Weigh ratings: "fire" edits show what to do more of, "meh" edits what to stop. Only state what the evidence supports.

<style_ideas>
${JSON.stringify(ready.map((i) => ({ title: i.title, notes: i.notes, stats: i.stats, recipe: i.recipe })), null, 1)}
</style_ideas>

<ratings_on_finished_edits>
${JSON.stringify(feedback.slice(-40), null, 1)}
</ratings_on_finished_edits>`,
        },
      ],
    }).catch((err) => {
      console.error("Style guide: Claude unavailable, using the template:", err.message);
      return null;
    });
    body = response?.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() || null;
  }
  body ??= templateStyle(ready, feedback);
  const out = `<!-- Distilled automatically from edits/ideas.json (style ideas + ratings). Hand edits are kept until the next refresh. -->\n${body}\n`;
  await fs.writeFile(STYLE, out);
  return out;
}

function topOf(recipes, key, n = 5) {
  const totals = {};
  for (const r of recipes) for (const { type, weight } of r[key] || []) totals[type] = (totals[type] || 0) + weight;
  return Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, n).map(([t]) => t);
}

function templateStyle(ready, feedback) {
  const recipes = ready.map((i) => i.recipe);
  const looks = tally(recipes.map((r) => r.look));
  const bps = recipes.map((r) => r.beatsPerShot).filter(Boolean);
  const loved = feedback.filter((f) => f.rating === "fire");
  const meh = feedback.filter((f) => f.rating === "meh");
  const lines = [
    "# Edit style",
    "",
    `${recipes.length} style idea${recipes.length === 1 ? "" : "s"}, ${feedback.length} rated edit${feedback.length === 1 ? "" : "s"}.`,
    "",
    "## Pacing",
    bps.length ? `- About ${(bps.reduce((a, b) => a + b, 0) / bps.length).toFixed(1)} beats per shot.` : "- No reference timing yet.",
    ...recipes.map((r) => r.pacing).filter(Boolean).map((p) => `- ${p}`),
    "",
    "## Transitions",
    `- Favorites: ${topOf(recipes, "transitions").join(", ") || "hard cuts"}.`,
    "",
    "## Effects & speed",
    `- Effects: ${topOf(recipes, "effects").join(", ") || "none yet"}.`,
    `- Speed: ${topOf(recipes, "speeds").join(", ") || "real time"}.`,
    "",
    "## Color",
    `- Looks: ${Object.entries(looks).sort((a, b) => b[1] - a[1]).map(([l]) => LOOKS[l]?.label || l).join(", ") || "natural"}.`,
    "",
    "## Rules from their ideas",
    ...[...new Set(recipes.flatMap((r) => r.rules || []))].slice(0, 14).map((r) => `- ${r}`),
  ];
  if (loved.length) lines.push("", "## Loved", ...loved.slice(-8).map((f) => `- ${f.note || "(no note)"} — ${f.used?.look || ""}, ${Object.keys(f.used?.transitions || {}).join("/")}`));
  if (meh.length) lines.push("", "## Avoid", ...meh.slice(-8).map((f) => `- ${f.note || "(no note)"} — ${f.used?.look || ""}, ${Object.keys(f.used?.transitions || {}).join("/")}`));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// What the director gets

/**
 * What the creator likes in the videos they study (Clip Studio's Study tab, data/study.json, active profile).
 * Read from disk each time rather than through lib/study.js, which caches per process.
 */
async function studyGuidance() {
  const db = await fs.readFile(path.join(ROOT, "data", "study.json"), "utf8").then(JSON.parse, () => null);
  if (!db?.references?.length) return "";
  const profileId = db.activeProfileId || db.profiles?.[0]?.id;
  const profile = db.profiles?.find((p) => p.id === profileId);
  const refs = db.references.filter((r) => r.profileId === profileId && (r.likes?.length || r.notes)).slice(0, 20);
  if (!refs.length) return "";
  const lines = refs.map((r) => {
    const likes = r.likes?.length ? ` — likes: ${r.likes.join(", ")}` : "";
    const notes = r.notes ? ` — "${String(r.notes).replace(/\s+/g, " ").slice(0, 300)}"` : "";
    return `- ${r.info?.title || "Reference"}${r.info?.uploader ? ` by ${r.info.uploader}` : ""}${likes}${notes}`;
  });
  return `<studied_videos profile="${profile?.name || "Me"}">
Videos this creator studies and admires, with what they like about each. Lean into those qualities, especially Pacing & cuts, Transitions & effects, Color & look, Music & sound and Energy. Never copy a reference's content.
${lines.join("\n")}
</studied_videos>`;
}

/** Prompt block for the director. `ideaIds` narrows to chosen ideas; empty means the whole library. */
export async function styleGuidance(ideaIds = []) {
  const [{ ideas, feedback }, style, studied] = await Promise.all([load(), readStyle(), studyGuidance()]);
  const chosen = ideas.filter((i) => i.recipe && (!ideaIds.length || ideaIds.includes(i.id)));
  const guide = style.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!guide && !chosen.length && !feedback.length) return studied;
  const parts = ["<edit_style>\nThe creator's taste in edits. Follow it closely unless their brief for this edit says otherwise."];
  if (guide) parts.push(`<style_guide>\n${guide}\n</style_guide>`);
  if (chosen.length) {
    parts.push(
      `<${ideaIds.length ? "ideas_picked_for_this_edit" : "style_ideas"}>\n${chosen
        .map((i) => JSON.stringify({ title: i.title, notes: i.notes || undefined, measured: i.stats?.[0], recipe: { ...i.recipe, mode: undefined } }))
        .join("\n")}\n</${ideaIds.length ? "ideas_picked_for_this_edit" : "style_ideas"}>`,
    );
  }
  const rated = feedback.slice(-20);
  if (rated.length) parts.push(`<ratings>\n${rated.map((f) => `- ${f.rating}: ${f.note || "(no note)"} | used ${JSON.stringify(f.used)}`).join("\n")}\n</ratings>`);
  parts.push("</edit_style>");
  if (studied) parts.push(studied);
  return parts.join("\n\n");
}

/** One recipe blended from the chosen ideas (all ideas when none are chosen), for the heuristic director. */
export async function blendedRecipe(ideaIds = []) {
  const { ideas } = await load();
  const recipes = ideas.filter((i) => i.recipe && (!ideaIds.length || ideaIds.includes(i.id))).map((i) => i.recipe);
  if (!recipes.length) return null;
  const merge = (key) => {
    const totals = {};
    for (const r of recipes) for (const { type, weight } of r[key] || []) totals[type] = (totals[type] || 0) + Number(weight || 1);
    return Object.entries(totals).map(([type, weight]) => ({ type, weight }));
  };
  const looks = tally(recipes.map((r) => r.look));
  const texts = tally(recipes.map((r) => r.text?.style).filter((s) => s && s !== "none"));
  const energies = tally(recipes.map((r) => r.energy));
  return {
    energy: Object.entries(energies).sort((a, b) => b[1] - a[1])[0]?.[0],
    beatsPerShot: recipes.reduce((s, r) => s + (r.beatsPerShot || 2), 0) / recipes.length,
    transitions: merge("transitions"),
    effects: merge("effects"),
    speeds: merge("speeds"),
    look: Object.entries(looks).sort((a, b) => b[1] - a[1])[0]?.[0],
    lookIntensity: recipes.reduce((s, r) => s + (r.lookIntensity ?? 0.85), 0) / recipes.length,
    text: { style: Object.entries(texts).sort((a, b) => b[1] - a[1])[0]?.[0] || null },
    accent: recipes.find((r) => r.accent)?.accent || null,
  };
}

/** Put ideas that were mid-modeling when the server stopped back in the queue. */
export async function resumeModeling() {
  for (const idea of (await load()).ideas.filter((i) => i.status === "modeling")) queueModel(idea.id);
}
