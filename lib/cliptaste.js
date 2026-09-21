// The creator's clip taste. Every ♥ or ✕ on a picked clip (before it's rendered) is kept with what the clip actually
// is — its opening words, what it says, its payoff, its ratings — and Claude reads the whole library to write down
// what the creator likes and passes on, in plain terms. That profile and the clearest examples go into every picking
// prompt, so the next video's clips lean toward what was liked; "More like this" searches a video for more clips in
// the same vein. Scheduling a clip counts as a like too. Idea after the Titles module's taste training (titles/).
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ROOT } from "./tools.js";

const FILE = path.join(ROOT, "data", "clip-taste.json");
const MODEL = "claude-opus-5";
const MAX_ENTRIES = 400;
const LEARN_AFTER_MS = 15_000; // a burst of hearts is learned from once, after the last one

let db = null;
let writes = Promise.resolve();

async function load() {
  if (!db) {
    try {
      db = JSON.parse(await fs.readFile(FILE, "utf8"));
    } catch {
      db = { entries: [], profile: null };
    }
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
    .catch((err) => console.error("Saving clip taste failed:", err.message));
  return writes;
}

const clean = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** What a clip says, in order: the words it keeps (its hook first when it opens on one). */
export function clipText(clip, words) {
  if (!Array.isArray(words) || !Number.isFinite(clip.start)) return { opening: null, transcript: null };
  const ranges = [...(clip.hook ? [clip.hook] : []), ...(clip.parts?.length ? clip.parts : [{ start: clip.start, end: clip.end }])];
  const said = ranges.flatMap((r) => words.filter((w) => w.start >= r.start - 0.05 && w.end <= r.end + 0.05).map((w) => w.text));
  return { opening: clean(said.slice(0, 18).join(" "), 200) || null, transcript: clean(said.join(" "), 900) || null };
}

/**
 * Record a verdict on a clip. verdict: "like" | "pass" | null (null takes a verdict back).
 * source: "heart" (the creator's button) or "scheduled" (they queued it to post — a like without saying so).
 */
export async function recordClipFeedback({ project, clip, words, verdict, reason = "", source = "heart" }) {
  await load();
  const key = `${project.id}/${clip.id}`;
  const existing = db.entries.find((e) => e.key === key);
  // A clip the creator hearted or passed on by hand keeps that verdict when it's later scheduled.
  if (source === "scheduled" && existing?.source === "heart") return existing;
  db.entries = db.entries.filter((e) => e.key !== key);
  if (verdict !== "like" && verdict !== "pass") {
    await persist();
    scheduleLearning();
    return null;
  }
  const { opening, transcript } = clipText(clip, words);
  const entry = {
    key,
    verdict,
    source,
    reason: clean(reason, 300),
    at: new Date().toISOString(),
    projectId: project.id,
    clipId: clip.id,
    projectName: clean(project.name, 120),
    title: clean(clip.title, 120),
    opening,
    transcript,
    payoff: clean(clip.payoff, 300) || null,
    why: clean(clip.reason, 300) || null,
    ratings: clip.ratings || null,
    score: clip.score ?? null,
    // What plays: the kept stretches (and a pulled-in hook) when the clip has cuts, else its range.
    duration: Number.isFinite(clip.end) ? +((clip.parts?.length ? clip.parts.reduce((t, r) => t + r.end - r.start, 0) : clip.end - clip.start) + (clip.hook ? clip.hook.end - clip.hook.start : 0)).toFixed(1) : null,
    hookFromElsewhere: Boolean(clip.hook),
  };
  db.entries = [entry, ...db.entries].slice(0, MAX_ENTRIES);
  await persist();
  scheduleLearning();
  return entry;
}

// ---------- learning ----------

const ProfileSchema = z.object({
  summary: z.string().describe("2–3 sentences, said to the editor: the kind of clip this creator wants"),
  loves: z.array(z.string()).describe("3–7 specific patterns in the liked clips: the kind of opening, topic angle, structure, tone, length"),
  avoids: z.array(z.string()).describe("0–6 specific patterns in the passed clips (empty if there are none)"),
  openings: z.string().describe("one sentence on the opening lines they respond to, with a short example in their words"),
  confidence: z.enum(["early", "forming", "clear"]).describe("early under 5 verdicts or mixed signals; clear when the pattern repeats"),
});

let learnTimer = null;
let pending = false;
let learning = null;

function scheduleLearning() {
  clearTimeout(learnTimer);
  pending = true;
  learnTimer = setTimeout(() => learnTaste().catch((err) => console.error("[clip taste] learning failed:", err.message)), LEARN_AFTER_MS);
  learnTimer.unref?.();
}

const describe = (e) =>
  `- ${e.verdict === "like" ? "LIKED" : "PASSED"}${e.source === "scheduled" ? " (scheduled to post)" : ""}: "${e.title}" | ${e.duration ?? "?"}s${e.hookFromElsewhere ? " | opens on a hook pulled from elsewhere in the video" : ""}
  opens: "${e.opening || "?"}"
  says: "${e.transcript || "?"}"
  payoff: ${e.payoff || "?"}${e.reason ? `\n  creator's note: ${e.reason}` : ""}`;

/** Read every verdict and rewrite the taste profile. Needs a Claude key and at least two verdicts. */
export async function learnTaste() {
  clearTimeout(learnTimer);
  pending = false;
  learning ??= (async () => {
    await load();
    const entries = db.entries.slice(0, 80);
    const likes = entries.filter((e) => e.verdict === "like").length;
    // Every verdict taken back: nothing left to go on.
    if (!likes && db.profile) {
      db.profile = null;
      await persist();
    }
    if (entries.length < 2 || !likes || !(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)) return db.profile;
    const client = new Anthropic();
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 6000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: betaZodOutputFormat(ProfileSchema) },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system:
        "You study a creator's reactions to short-form clips an editor cut from their long videos, and write down their taste so the editor can find more clips they'll love. The creator makes premium content for doctors, chiropractors and physical therapists, expanding into lifestyle. Be specific and concrete — name the kind of opening line, the angle, the structure, the energy — never generic advice like 'engaging content'. Base every point on the clips; where likes and passes differ, that difference is the most useful thing to write down.",
      messages: [{ role: "user", content: `The creator's verdicts, newest first:\n\n${entries.map(describe).join("\n\n")}\n\nWrite their clip taste profile.` }],
    });
    if (!response.parsed_output) return db.profile;
    db.profile = { ...response.parsed_output, likes, passes: entries.length - likes, updatedAt: new Date().toISOString() };
    await persist();
    return db.profile;
  })().finally(() => (learning = null));
  return learning;
}

// ---------- reading it back ----------

export async function clipTaste() {
  await load();
  const likes = db.entries.filter((e) => e.verdict === "like");
  return { profile: db.profile, likes: likes.length, passes: db.entries.length - likes.length, learning: Boolean(learning) || pending, recent: db.entries.slice(0, 12) };
}

export async function clipVerdicts(projectId) {
  await load();
  return Object.fromEntries(db.entries.filter((e) => e.projectId === projectId).map((e) => [e.clipId, e.verdict]));
}

/** The picking prompt block: the learned profile plus the clearest liked and passed examples. Empty until a verdict. */
export async function clipTasteGuidance() {
  await load();
  if (!db.entries.length) return "";
  const likes = db.entries.filter((e) => e.verdict === "like");
  const hearted = likes.filter((e) => e.source === "heart");
  const examples = [...hearted, ...likes.filter((e) => e.source !== "heart")].slice(0, 8);
  const passes = db.entries.filter((e) => e.verdict === "pass").slice(0, 5);
  const p = db.profile;
  const parts = [
    `<creator_clip_taste>
Before rendering, the creator hearts the picked clips they love and passes on the rest. This is what they actually want — pick more clips like the ones they loved and fewer like the ones they passed on, and rate taste_match honestly against it. It's a taste to match, not a template to copy: find new moments in THIS video that would earn the same reaction.`,
  ];
  if (p) {
    parts.push(`<what_they_like confidence="${p.confidence}" verdicts="${p.likes + p.passes}">
${p.summary}
Loves:
${p.loves.map((x) => `- ${x}`).join("\n")}${p.avoids.length ? `\nPasses on:\n${p.avoids.map((x) => `- ${x}`).join("\n")}` : ""}
Openings: ${p.openings}
</what_they_like>`);
  }
  if (examples.length) parts.push(`<clips_they_loved>\n${examples.map(describe).join("\n\n")}\n</clips_they_loved>`);
  if (passes.length) parts.push(`<clips_they_passed_on>\n${passes.map(describe).join("\n\n")}\n</clips_they_passed_on>`);
  parts.push("</creator_clip_taste>");
  return parts.join("\n\n");
}

/** The extra instruction for "More like this": the liked clip, and the ranges already taken. */
export function moreLikeThisNote(project, clip, words) {
  const { opening, transcript } = clipText(clip, words);
  const taken = (project.clips || []).map((c) => `${c.start.toFixed(1)}–${c.end.toFixed(1)}s`).join(", ");
  return `The creator just hearted this clip from the video and wants MORE like it:
"${clip.title}" (${clip.start.toFixed(1)}–${clip.end.toFixed(1)}s)
opens: "${opening || "?"}"
says: "${transcript || "?"}"
payoff: ${clip.payoff || "?"}

Find the other moments in this video that would earn the same reaction — the same kind of opening, angle, structure and energy — but each making a different point than that clip and than each other. These ranges are already clips; new clips must not overlap them: ${taken || "none"}. Only return moments that genuinely match; fewer is better than padding.`;
}
