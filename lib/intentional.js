// Intentional reels: instead of hunting good moments in footage that already exists, this works the other way round
// — it reads everything the system knows (the audience brief from HBA's workshops, client calls and SOPs, the reels
// the creator studies, which clips they hearted, what actually performed, and every clip already made) and writes
// the questions to put to Dr Odell on camera, each one attached to the reel it would become.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ROOT } from "./tools.js";
import { listProjects, loadProject } from "./store.js";
import { audienceGuidance, getAudience } from "./audience.js";
import { clipTasteGuidance } from "./cliptaste.js";
import { performanceGuidance } from "./performance.js";
import { tasteGuidance } from "./study.js";
import { titleGuidance } from "../titles/index.js";
import { resolveChannel, channelFeed } from "./youtubewatch.js";

const FILE = path.join(ROOT, "data", "intentional.json");
const MODEL = "claude-opus-5-5";
export const STATUSES = ["new", "asked", "filmed", "skipped"];

// Questions written outside the app (by the Intentional Reels chat) land here and are merged on the next load.
const PENDING = path.join(ROOT, "data", "intentional-pending.json");

let db = null;
let loadedAt = 0;
let writes = Promise.resolve();
let generating = null;

async function mtime(file) {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

async function load() {
  // Re-read when the file changed on disk since we last loaded or saved it, so outside edits aren't clobbered.
  if (!db || (await mtime(FILE)) > loadedAt) {
    try {
      db = JSON.parse(await fs.readFile(FILE, "utf8"));
    } catch {
      db = { questions: [], lastRunAt: null };
    }
    loadedAt = await mtime(FILE);
  }
  try {
    const pending = JSON.parse(await fs.readFile(PENDING, "utf8"));
    const seen = new Set(db.questions.map((q) => q.question));
    db.questions = [...(pending.questions || []).filter((q) => !seen.has(q.question)), ...db.questions];
    await fs.rm(PENDING);
    await persist();
  } catch {}
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
      loadedAt = await mtime(FILE);
    })
    .catch((err) => console.error("Saving intentional reels failed:", err.message));
  return writes;
}

const Schema = z.object({
  questions: z.array(
    z.object({
      question: z.string().describe("the question to ask Dr Odell on camera, in plain spoken English, the way a good interviewer would put it"),
      follow_up: z.string().describe("one follow-up to ask if the first answer stays general — push for the number, the name, the story"),
      answers: z.string().describe("the client question or fear this reel answers, quoted from the audience brief where possible"),
      angle: z.string().describe("what makes the reel land: the reframe, the math, the story or the call-out"),
      hook: z.string().describe("the opening line the reel would use, max 15 words, in Dr Odell's voice"),
      title: z.string().describe("the on-screen headline the finished reel would carry, max 8 words"),
      who: z.string().describe("who this is for: the kind of practice owner and where they are"),
      priority: z.number().describe("1-100, how badly this audience needs it right now"),
    }),
  ),
});

const SYSTEM = `You plan the reels a creator should deliberately film, for Dr Odell Miller of HBA (Healthcare Business Academy). He teaches healthcare practice owners — chiropractors, physical therapists, med spa and clinic owners — how to grow past $50–100k/month, and sells a 90-day mastermind off a free strategy call.

You are not looking for clips in footage. You are writing the questions someone should ask him on camera so the answers become reels worth posting.

A good question:
- lands on something this audience actually asked or is stuck on right now — use their words
- can only be answered by him: his numbers, his clients' results, the mistake he made, the call he took
- pulls a specific answer, not a speech: one story, one number, one move
- turns into a reel under 40 seconds with a hook in the first 3 seconds
- does not repeat a reel the creator already has

Premium voice: no clickbait, no hype, no emoji. Money with $ and short units ($20k, $100k/month).`;

const hasKey = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

/** What the creator has already posted publicly, so the questions open new ground instead of repeating the feed. */
async function postedLately(handle = "@OdellMiller") {
  try {
    const channel = await resolveChannel(handle);
    const feed = await channelFeed(channel.id);
    return feed.slice(0, 20).map((v) => `- ${v.title}`);
  } catch {
    return [];
  }
}

/** Who he is, in his own words: shared/ODELL_VOICE.md, kept by hand and fed to every batch. */
async function voiceBank() {
  try {
    const text = await fs.readFile(path.join(ROOT, "shared", "ODELL_VOICE.md"), "utf8");
    return `<the_creator>\n${text.slice(0, 20000)}\n</the_creator>`;
  } catch {
    return "";
  }
}

/** The playbook this tab keeps: what makes a question pull a reel out of him. shared/INTENTIONAL_PLAYBOOK.md. */
async function playbook() {
  try {
    const text = await fs.readFile(path.join(ROOT, "shared", "INTENTIONAL_PLAYBOOK.md"), "utf8");
    return `<question_playbook>\n${text.slice(0, 15000)}\n</question_playbook>`;
  } catch {
    return "";
  }
}

/** Filmed questions are the taste to repeat, skipped ones the taste to avoid. */
function questionTaste() {
  const line = (q) => `- ${q.question} → "${q.title}"`;
  const filmed = db.questions.filter((q) => q.status === "filmed").slice(0, 25).map(line);
  const skipped = db.questions.filter((q) => q.status === "skipped").slice(0, 25).map(line);
  if (!filmed.length && !skipped.length) return "";
  return [
    filmed.length ? `Questions the creator actually filmed — this is the taste, write more at this level:\n${filmed.join("\n")}` : "",
    skipped.length ? `Questions the creator skipped — learn what's wrong with them and don't write their cousins:\n${skipped.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

/** Every clip already made, so the questions cover new ground instead of repeating what's filmed. */
async function alreadyCovered() {
  const titles = [];
  for (const summary of await listProjects()) {
    const project = await loadProject(summary.id);
    for (const clip of project?.clips || []) titles.push(`"${clip.title}" — ${String(clip.payoff || clip.reason || "").slice(0, 120)}`);
  }
  return titles.slice(0, 60);
}

/**
 * Write a fresh batch of questions to ask Dr Odell. Everything the system has learned goes in; what's already been
 * asked or filmed goes in too, so a batch never repeats itself.
 */
export function generateQuestions(opts = {}) {
  generating ||= writeBatch(opts).finally(() => (generating = null));
  return generating;
}

async function writeBatch({ count = 8, note = "" } = {}) {
  await load();
  if (!hasKey()) throw new Error("Add your Claude key to write these questions.");
  const { brief } = await getAudience();
  if (!brief) throw new Error("Feed it a workshop, a client call or an SOP first — it writes the questions from those.");
  const covered = await alreadyCovered();
  const posted = await postedLately();
  const asked = db.questions.map((q) => `- ${q.question} [${q.status}]`).slice(-60);
  const response = await new Anthropic().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: betaZodOutputFormat(Schema) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [SYSTEM, await playbook(), await voiceBank(), await audienceGuidance(), await clipTasteGuidance(), await performanceGuidance(), await tasteGuidance(), await titleGuidance()].filter(Boolean).join("\n\n"),
    messages: [
      {
        role: "user",
        content: `Write ${count} questions to ask Dr Odell on camera.
${note ? `\nWhat the creator wants from this batch: ${note}\n` : ""}
${covered.length ? `Reels already made — don't repeat these:\n${covered.join("\n")}\n` : ""}
${posted.length ? `\nWhat he has posted publicly lately (his own channel) — go deeper than these, don't restate them:\n${posted.join("\n")}\n` : ""}
${questionTaste() ? `\n${questionTaste()}\n` : ""}
${asked.length ? `\nQuestions already on the list (skip anything this close):\n${asked.join("\n")}\n` : ""}
Order them by how badly this audience needs the answer right now.`,
      },
    ],
  });
  const out = response.parsed_output;
  if (!out) throw new Error("That batch came back incomplete. Try again.");
  const batch = new Date().toISOString();
  const fresh = out.questions.map((q) => ({
    id: `q_${crypto.randomBytes(5).toString("hex")}`,
    ...q,
    priority: Math.min(100, Math.max(1, Math.round(q.priority || 50))),
    status: "new",
    batch,
  }));
  db.questions = [...fresh, ...db.questions].slice(0, 300);
  db.lastRunAt = batch;
  await persist();
  return fresh;
}

export async function listQuestions() {
  await load();
  const { brief, sources } = await getAudience();
  return {
    questions: [...db.questions].sort((a, b) => (a.status === "new" ? 0 : 1) - (b.status === "new" ? 0 : 1) || b.priority - a.priority),
    lastRunAt: db.lastRunAt,
    knows: { audience: Boolean(brief), sources: (sources || []).map((s) => s.name) },
  };
}

export async function setStatus(id, status) {
  await load();
  const q = db.questions.find((x) => x.id === id);
  if (!q) throw new Error("Question not found");
  if (!STATUSES.includes(status)) throw new Error("Unknown status");
  q.status = status;
  q.statusAt = new Date().toISOString();
  await persist();
  return q;
}

export async function removeQuestion(id) {
  await load();
  db.questions = db.questions.filter((x) => x.id !== id);
  await persist();
  return { ok: true };
}
