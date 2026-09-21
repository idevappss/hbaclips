// Title taste: the titles the creator loves, a style guide distilled from them, and a generator
// that writes new titles in that voice. titleGuidance() is the prompt block the clip analysis uses.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";

const MODEL = "claude-opus-5";
const DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(DIR, "..");
const LIBRARY = path.join(DIR, "favorites.json");
const STYLE = path.join(DIR, "STYLE.md");

/**
 * hook = on-screen clip headline, opener = line said or shown in the first two seconds,
 * post = title that leads the caption, youtube = YouTube title, idea = general title idea.
 */
export const KINDS = ["hook", "opener", "post", "youtube", "idea"];

const MAX_LIKED = 200;
const MAX_AVOID = 25;

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

export function hasClaudeKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

// ---------------------------------------------------------------------------
// Library: titles/favorites.json → { liked: [...], avoid: [...] }

export async function loadLibrary() {
  try {
    const data = JSON.parse(await fs.readFile(LIBRARY, "utf8"));
    return { liked: data.liked || [], avoid: data.avoid || [] };
  } catch (err) {
    if (err.code === "ENOENT") return { liked: [], avoid: [] };
    throw err; // a hand-edit broke the JSON — never overwrite it
  }
}

let writeChain = Promise.resolve();

/** Read-modify-write the library. Writes are serialized and atomic. */
function mutate(fn) {
  const next = writeChain.then(async () => {
    const lib = await loadLibrary();
    const result = fn(lib);
    const tmp = `${LIBRARY}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(lib, null, 2)}\n`);
    await fs.rename(tmp, LIBRARY);
    return result;
  });
  writeChain = next.catch(() => {});
  return next;
}

function entry({ title, kind, note, editedFrom, source }) {
  const t = clean(title).slice(0, 200);
  if (!t) throw new Error("Title is empty.");
  if (kind && !KINDS.includes(kind)) throw new Error(`kind must be one of: ${KINDS.join(", ")}`);
  return { title: t, kind, note: clean(note) || undefined, editedFrom: clean(editedFrom) || undefined, source, addedAt: new Date().toISOString() };
}

/** Put a title on one list and take it off both (so liking a rejected title un-rejects it). */
function save(list, input) {
  const item = entry(input);
  return mutate((lib) => {
    lib.liked = lib.liked.filter((x) => !same(x.title, item.title));
    lib.avoid = lib.avoid.filter((x) => !same(x.title, item.title));
    lib[list].push(item);
    return item;
  });
}

export const like = (input) => save("liked", input);
export const avoid = (input) => save("avoid", input);

export function remove(title) {
  const t = clean(title);
  return mutate((lib) => {
    const before = lib.liked.length + lib.avoid.length;
    lib.liked = lib.liked.filter((x) => !same(x.title, t));
    lib.avoid = lib.avoid.filter((x) => !same(x.title, t));
    return before - lib.liked.length - lib.avoid.length;
  });
}

/** A hand-edited title is the strongest signal there is: keep the rewrite and what it replaced. */
export function recordEdit({ before, after, kind = "hook", source = "edit" }) {
  if (!clean(after) || same(clean(before), clean(after))) return Promise.resolve(null);
  return like({ title: after, kind, editedFrom: before, source });
}

// ---------------------------------------------------------------------------
// Prompt block

/** Teaches Claude the creator's taste. Empty string until there's something to teach. */
export async function titleGuidance() {
  const [rawStyle, lib] = await Promise.all([fs.readFile(STYLE, "utf8").catch(() => ""), loadLibrary()]);
  const style = rawStyle.replace(/<!--[\s\S]*?-->/g, "").trim();
  const liked = lib.liked.slice(-MAX_LIKED);
  const loved = liked.filter((x) => !x.editedFrom);
  const rewrites = liked.filter((x) => x.editedFrom);
  const rejected = lib.avoid.slice(-MAX_AVOID);
  if (!style && !liked.length && !rejected.length) return "";

  const line = (x) => `- ${x.title}${x.kind ? ` [${x.kind}]` : ""}${x.note ? ` — ${x.note}` : ""}`;
  const parts = [
    `<title_taste>
The creator has a specific taste in titles. Match it in everything you write: on-screen clip hooks, opening lines, post titles, YouTube titles and title ideas. Learn the patterns (voice, rhythm, word choice, structure, capitalization, punctuation, length) and write new ones in that voice about THIS video. Taste carries across formats, but each format keeps its own length and job. Never copy an example or borrow its specifics. Tags: [hook] on-screen clip headline, [opener] opening line, [post] post title, [youtube] YouTube title, [idea] title idea.`,
  ];
  if (style) parts.push(`<style_guide>\n${style}\n</style_guide>`);
  if (loved.length) {
    // Grouped by format: taste carries across them, but length and job don't.
    const groups = [...KINDS, null]
      .map((k) => [k, loved.filter((x) => (k ? x.kind === k : !KINDS.includes(x.kind)))])
      .filter(([, xs]) => xs.length)
      .map(([k, xs]) => `${k || "unlabelled"}:\n${xs.map((x) => `- ${x.title}${x.note ? ` — ${x.note}` : ""}`).join("\n")}`);
    parts.push(`<titles_they_love>\n${groups.join("\n\n")}\n</titles_they_love>`);
  }
  if (rewrites.length) {
    parts.push(`<their_rewrites>\nTitles they rewrote by hand. The gap between the two is exactly what they want:\n${rewrites.map((x) => `- "${x.editedFrom}" → "${x.title}"`).join("\n")}\n</their_rewrites>`);
  }
  if (rejected.length) parts.push(`<titles_they_rejected>\n${rejected.map(line).join("\n")}\n</titles_they_rejected>`);
  parts.push("</title_taste>");
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Generator

const TitlesSchema = z.object({
  titles: z.array(
    z.object({
      title: z.string(),
      angle: z.string().describe("e.g. curiosity gap, bold claim, contrarian, story, list, emotional"),
      why: z.string().describe("one short sentence"),
    }),
  ),
});

const SYSTEM = `You write titles for short-form vertical clips (TikTok, Reels, Shorts). Your titles stop the scroll and sound like the creator, not a marketer, and they never promise something the clip doesn't deliver.`;

const LIMITS = {
  hook: "max 8 words, since it's burned into the video over the speaker",
  opener: "max 15 words, said or shown in the first two seconds",
  post: "under 70 characters, since it leads the post caption",
  youtube: "under 70 characters, with a clear payoff and the words people actually search for",
  idea: "under 70 characters",
};

/** Fresh titles for one clip, in the creator's voice, best first. */
export async function generateTitles({ transcript, kind = "hook", count = 10, notes = "" }) {
  if (!hasClaudeKey()) throw new Error("Add ANTHROPIC_API_KEY to .env to generate titles.");
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of: ${KINDS.join(", ")}`);
  if (!clean(transcript)) throw new Error("This clip has no transcript to title.");

  // Streamed: a long transcript plus adaptive thinking can run past the non-streaming ceiling, and a truncated
  // structured response looks like a broken key rather than a token limit.
  const stream = new Anthropic().beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: betaZodOutputFormat(TitlesSchema) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [SYSTEM, await titleGuidance()].filter(Boolean).join("\n\n"),
    messages: [
      {
        role: "user",
        content: `Write ${count} ${kind} titles for this clip, best first. Each one ${LIMITS[kind]}. Vary the angle.${notes ? `\nCreator notes: ${notes}` : ""}

<clip_transcript>
${transcript}
</clip_transcript>`,
      },
    ],
  });
  const response = await stream.finalMessage();

  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined to title this clip${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : "."}`);
  }
  if (response.stop_reason === "max_tokens" || !response.parsed_output) {
    throw new Error("Claude's titles came back incomplete. Try again.");
  }
  return response.parsed_output.titles.slice(0, count);
}

/** The words spoken in a clip, taken from its project's transcript. */
export async function clipTranscript(projectId, clipId) {
  if (!/^[a-z0-9]+-[a-f0-9]{6}$/.test(projectId)) throw new Error("Project not found");
  let project;
  try {
    project = JSON.parse(await fs.readFile(path.join(ROOT, "projects", projectId, "project.json"), "utf8"));
  } catch {
    throw new Error("Project not found");
  }
  const clip = project.clips?.find((c) => c.id === clipId);
  if (!clip) throw new Error("Clip not found");
  // Clip edges are padded a little past speech, so count a sentence only when its middle is inside the clip.
  const text = (project.segments || [])
    .filter((s) => (s.start + s.end) / 2 >= clip.start && (s.start + s.end) / 2 <= clip.end)
    .map((s) => s.text)
    .join(" ");
  return { project, clip, text };
}

// ---------------------------------------------------------------------------
// HTTP API, mounted at /api/titles

export const router = express.Router();

const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req.body ?? {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

router.get("/", handle(() => loadLibrary()));
router.post("/liked", handle((b) => like({ title: b.title, kind: b.kind, note: b.note, source: b.source || "app" })));
router.post("/avoid", handle((b) => avoid({ title: b.title, kind: b.kind, note: b.note, source: b.source || "app" })));
router.post("/remove", handle(async (b) => ({ removed: await remove(b.title) })));
router.post(
  "/generate",
  handle(async (b) => {
    const transcript = b.transcript || (await clipTranscript(String(b.projectId), String(b.clipId))).text;
    const count = Math.min(20, Math.max(1, Math.round(Number(b.count)) || 10));
    return { titles: await generateTitles({ transcript, kind: b.kind || "hook", count, notes: b.notes }) };
  }),
);
