// Who the clips are for, in the creator's own material. Workshop decks, Zoom calls with clients, sales pages — each
// one is read once and distilled into a brief: what the business does, who's watching, the questions they keep
// asking, the objections, the proof and the words they use. That brief goes into every picking prompt, so clips are
// chosen for the moments that answer a real question this audience asked.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ROOT } from "./tools.js";

const FILE = path.join(ROOT, "data", "audience.json");
const MODEL = "claude-opus-5";
const MAX_CHARS = 400_000; // one source, trimmed before it goes to Claude

let db = null;
let writes = Promise.resolve();

async function load() {
  if (!db) {
    try {
      db = JSON.parse(await fs.readFile(FILE, "utf8"));
    } catch {
      db = { brief: null, sources: [] };
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
    .catch((err) => console.error("Saving the audience brief failed:", err.message));
  return writes;
}

const clean = (s) => String(s).replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

/** Readable text from a .vtt/.srt subtitle file: cues and timestamps out, repeated speaker labels collapsed. */
export function textFromSubtitles(raw) {
  const lines = String(raw).split("\n");
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t === "WEBVTT" || /^\d+$/.test(t) || /-->/.test(t) || /^NOTE\b/.test(t)) continue;
    if (out.at(-1) === t) continue; // subtitle files repeat a line across cues
    out.push(t);
  }
  return clean(out.join("\n"));
}

/** Readable text from a .docx (its document.xml, paragraph by paragraph). */
export async function textFromDocx(file) {
  const buf = await fs.readFile(file);
  // A .docx is a zip; pull word/document.xml out of it without a zip library.
  const entries = [];
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString();
    const method = buf.readUInt16LE(i + 8);
    let size = buf.readUInt32LE(i + 18);
    const start = i + 30 + nameLen + extraLen;
    if (name !== "word/document.xml") continue;
    // Streamed zips write size 0 here; take everything up to the next entry instead.
    if (!size) {
      const next = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), start);
      size = (next === -1 ? buf.length : next) - start;
    }
    const raw = buf.slice(start, start + size);
    entries.push(method === 8 ? zlib.inflateRawSync(raw) : raw);
    break;
  }
  if (!entries.length) throw new Error("Couldn't read that Word file.");
  const xml = entries[0].toString("utf8");
  const text = xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:tab[^>]*\/>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return clean(text);
}

/** Text from any source the creator hands over: subtitles, Word, or plain text/markdown. */
export async function readSource(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".docx") return textFromDocx(file);
  const raw = await fs.readFile(file, "utf8");
  return ext === ".vtt" || ext === ".srt" ? textFromSubtitles(raw) : clean(raw);
}

const BriefSchema = z.object({
  who_we_are: z.string().describe("2–3 sentences: the business, who runs it, what it sells"),
  audience: z.string().describe("2–3 sentences: exactly who the content is for, where they are in their business, what they want"),
  questions: z.array(z.object({
    question: z.string().describe("a question this audience actually asks, in their words"),
    why: z.string().describe("the fear or goal behind it, one line"),
  })).describe("10–25, the ones asked most or that clearly matter most"),
  pains: z.array(z.string()).describe("6–12 specific things keeping them stuck, in their words"),
  objections: z.array(z.string()).describe("4–10 reasons they hesitate or say it won't work for them"),
  proof: z.array(z.string()).describe("4–12 results, numbers or client stories worth repeating in clips"),
  vocabulary: z.array(z.string()).describe("8–20 words and phrases this world uses (name the funnels, metrics, models)"),
  angles: z.array(z.string()).describe("6–12 content angles that would land with this audience"),
});

const SYSTEM = `You read a creator's own material — workshop recordings, client calls, decks, sales pages — and write the brief a short-form editor needs to pick clips this audience will stop for.

Work only from what's in the material. Quote the audience's own words for questions, pains and objections. Be concrete: name the numbers, funnels, models and results that are actually mentioned. Skip anything internal (team chatter, tech setup, scheduling) — only what serves the audience.`;

/** Read one source and fold it into the brief. */
export async function ingestSource({ name, text, note = "" }) {
  await load();
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw new Error("Add your Claude key to read this.");
  const body = String(text || "").slice(0, MAX_CHARS);
  if (body.length < 200) throw new Error("There's not enough in that file to learn from.");
  const previous = db.brief ? `The brief so far — keep what still holds, correct what this source contradicts, and add what's new:\n${JSON.stringify(db.brief, null, 1)}\n\n` : "";
  const stream = new Anthropic().beta.messages.stream({
    model: MODEL,
    max_tokens: 24000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: betaZodOutputFormat(BriefSchema) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: `${previous}New source: ${name}${note ? ` (${note})` : ""}\n\n<source>\n${body}\n</source>\n\nWrite the brief.` }],
  });
  const message = await stream.finalMessage();
  if (!message.parsed_output) throw new Error("Claude's read came back incomplete. Try again.");
  db.brief = { ...message.parsed_output, updatedAt: new Date().toISOString() };
  db.sources = [...(db.sources || []).filter((s) => s.name !== name), { name, note, chars: body.length, at: new Date().toISOString() }].slice(-20);
  await persist();
  return db.brief;
}

export async function getAudience() {
  await load();
  return { brief: db.brief, sources: db.sources || [] };
}

export async function clearAudience() {
  await load();
  db = { brief: null, sources: [] };
  await persist();
  return db;
}

/** The picking-prompt block: who this is for and what they keep asking. Empty until a source has been read. */
export async function audienceGuidance() {
  await load();
  const b = db.brief;
  if (!b) return "";
  const list = (xs, n) => (xs || []).slice(0, n).map((x) => `- ${x}`).join("\n");
  return `<who_this_is_for>
${b.who_we_are}

The viewer: ${b.audience}

These are the questions this audience actually asks, from the creator's own calls and workshops. A clip that answers one of them plainly — in the speaker's words, with the specifics — beats a clip that is merely interesting. Favour those moments, and open on the question when the speaker states it.
${(b.questions || []).slice(0, 20).map((q) => `- "${q.question}" — ${q.why}`).join("\n")}

What keeps them stuck (say it the way they feel it):
${list(b.pains, 10)}

Why they hesitate (a clip that answers one of these converts):
${list(b.objections, 8)}

Proof worth repeating when the speaker says it:
${list(b.proof, 10)}

Their vocabulary — use these words, don't invent new ones: ${(b.vocabulary || []).slice(0, 20).join(", ")}

Angles that land:
${list(b.angles, 10)}
</who_this_is_for>`;
}
