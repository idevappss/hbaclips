// Claude looks at the candidate stills, picks the one that sells the video, and writes the words on it.
// Without a key (or credits) the best-scoring still and a headline pulled from the transcript still work.
import fs from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { FFMPEG, run } from "../lib/tools.js";
import { LAYOUT_IDS } from "./compose.js";

const MODEL = "claude-opus-5";
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

export const hasClaudeKey = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const Schema = z.object({
  pick: z.number().int().describe("index of the still to use, from the numbered list"),
  headline: z.string().describe("2–6 words, the promise of the video"),
  word: z.string().describe("the single strongest word from the headline"),
  sub: z.string().describe("0–4 words under the headline, or empty"),
  layout: z.enum(["left", "right", "bottom", "panel", "word"]),
  why: z.string().describe("one short sentence"),
});

const SYSTEM = `You design YouTube thumbnails for a healthcare-business creator whose audience is doctors, chiropractors and physical therapists growing their practice.

A thumbnail earns the click in under a second:
- 2 to 6 words, never a sentence, never the video's full title, and never words already burned into the picture.
- Plain spoken language a busy practice owner would say. No marketing gloss, no clickbait the video can't pay off, no emoji, no hashtags, no end punctuation.
- Curiosity, a number, a stake or a contrast beats a description.
- Pick a still where the speaker's face is clear and the expression carries something. Avoid mid-blink, mid-word mouths, blur, and anything hard to read at phone size.
- Keep the words off the face: choose the layout that puts them where the picture is empty.`;

/** Downscale a still for the model — the layout decision doesn't need 1280px. */
async function preview(file, out, signal) {
  await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", file, "-vf", "scale=640:-2", "-q:v", "4", "-y", out], { signal });
  return fs.readFile(out, { encoding: "base64" });
}

function fallback({ cands, name, text }) {
  const sentence = clean(text).split(/(?<=[.!?])\s+/).map(clean).filter((s) => s.split(" ").length >= 4)[0] || clean(name);
  const words = sentence.replace(/[.,!?;:]+$/, "").split(" ").slice(0, 5);
  const headline = words.join(" ") || "Watch this";
  return {
    pick: 0,
    headline,
    word: [...words].sort((a, b) => b.length - a.length)[0] || headline,
    sub: "",
    layout: null,
    why: "Claude wasn't available, so this is the best-scoring frame with a line from the video.",
    demo: true,
    frame: cands[0],
  };
}

/**
 * Pick the still and write the words.
 * cands: scored candidates (frames.js). text: what's been transcribed so far. name: the project's name.
 * → { pick, headline, word, sub, layout, why, frame, demo? }
 */
export async function headlineFor({ cands, text = "", name = "", notes = "", taste = "", signal, tmpDir }) {
  const shortlist = cands.slice(0, 8);
  if (!hasClaudeKey() || !shortlist.length) return fallback({ cands: shortlist.length ? shortlist : cands, name, text });

  const images = await Promise.all(
    shortlist.map(async (c, i) => ({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: await preview(c.file, `${tmpDir}/preview-${i}.jpg`, signal) },
    })),
  );
  const content = [];
  shortlist.forEach((c, i) => {
    content.push({ type: "text", text: `Still ${i} — ${Math.floor(c.at / 60)}:${String(Math.floor(c.at % 60)).padStart(2, "0")} in${c.face ? `, face ${c.face.x < 0.42 ? "on the left" : c.face.x > 0.58 ? "on the right" : "centred"}` : ", no face found"}` });
    content.push(images[i]);
  });
  content.push({
    type: "text",
    text: `Video: ${clean(name) || "untitled"}${notes ? `\nCreator notes: ${clean(notes)}` : ""}

<transcript>
${clean(text).slice(0, 12000) || "(still transcribing — go by the pictures)"}
</transcript>

Pick the still that makes someone stop, and write the words for it.`,
  });

  try {
    const stream = new Anthropic().beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: betaZodOutputFormat(Schema) },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [SYSTEM, taste].filter(Boolean).join("\n\n"),
      messages: [{ role: "user", content }],
    }, { signal });
    const response = await stream.finalMessage();
    const out = response.parsed_output;
    if (!out) throw new Error("Claude's answer came back incomplete.");
    const pick = Math.min(Math.max(0, Math.round(out.pick) || 0), shortlist.length - 1);
    return {
      pick,
      headline: clean(out.headline).replace(/[.!]+$/, ""),
      word: clean(out.word),
      sub: clean(out.sub),
      layout: LAYOUT_IDS.has(out.layout) ? out.layout : null,
      why: clean(out.why),
      frame: shortlist[pick],
    };
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    const guess = fallback({ cands: shortlist, name, text });
    return { ...guess, why: `Claude couldn't write this one (${err.message.split("\n")[0]}), so it's the best frame with a line from the video.` };
  }
}
