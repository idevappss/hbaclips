// What should hit the screen in a clip beyond the captions: a few power words that pop big on their own when
// they're said (the money, the number, the one word the point turns on). Claude chooses them from the words the clip
// actually plays; the composer places them on those words. Kept on the clip as clip.emphasisPlan.
// No key-point cards (the white "Quarterly in Miami" boxes): the creator doesn't want them, so none are asked for or
// placed, and older plans that still carry callouts are ignored.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { formatMoneyText } from "./money.js";

const MODEL = "claude-opus-5";
export const EMPHASIS_VERSION = 3;

const PlanSchema = z.object({
  pops: z.array(z.object({
    phrase: z.string().describe("1–4 consecutive words copied exactly from clip_words: the key words of an important line"),
    display: z.string().describe("how it shows on screen, 1–4 words in natural sentence case (not Title Case): money as $20k or $100k/month, numbers as digits"),
  })),
});

const SYSTEM = `You design the on-screen text for premium short-form clips for a creator who teaches doctors, chiropractors and physical therapists to grow their practices (expanding into lifestyle). Captions already run under every word; you choose what goes BIG on top of them so the clip stands out without looking cheap.

pops — the important moments, shown as huge glowing words behind the speaker the moment they're said: 2 to 4 per clip. Whenever something important is said, its key words go big — the money or number ("$100k/month", "six figures"), the charged word the point turns on ("money", "system", "authority", "obsessed"), or the 2–4 words of the line that matters most ("the wrong system", "sell with authority"). Space them through the clip, at least 5 seconds apart, never two in the same sentence. Skip filler, names nobody knows, and ordinary words.`;

const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}$]/gu, "");

/** Ask Claude for a clip's pops, from the words it plays. */
export async function emphasisPlan({ clip, words }) {
  const text = words.map((w) => w.text).join(" ");
  const response = await new Anthropic().beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "low", format: betaZodOutputFormat(PlanSchema) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: `On-screen title: "${clip.title || ""}"\n\n<clip_words>\n${text}\n</clip_words>\n\nChoose the pops.` }],
  });
  const out = response.parsed_output;
  if (!out) return null;
  return {
    version: EMPHASIS_VERSION,
    pops: out.pops.slice(0, 6).map((p) => ({ phrase: p.phrase, display: formatMoneyText(p.display.trim()) })),
    words: text.slice(0, 2000),
    at: new Date().toISOString(),
  };
}

/** Where a phrase is said in the clip's words (on its own timeline): [first, last] word index, or null. */
function findPhrase(words, phrase, from = 0) {
  const want = String(phrase).split(/\s+/).map(norm).filter(Boolean);
  if (!want.length) return null;
  const said = words.map((w) => norm(w.text));
  for (let i = from; i <= said.length - want.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) {
      // Money gets reformatted in captions ("20k" → "$20k"), so a number matches with or without its $ and unit.
      const a = said[i + k];
      const b = want[k];
      if (a !== b && a.replace(/^\$/, "") !== b.replace(/^\$/, "")) { ok = false; break; }
    }
    if (ok) return [i, i + want.length - 1];
  }
  return null;
}

/**
 * Pops placed on the clip's timeline: { pops: [{ s, e, text, words: [i…] }], callouts: [] }. Pops keep 4 s apart and
 * clear of the first second. `callouts` is always empty (key-point cards are off for good).
 */
export function placeEmphasis(words, plan, duration) {
  if (!plan || !words?.length) return { pops: [], callouts: [] };
  const pops = [];
  for (const p of plan.pops || []) {
    const at = findPhrase(words, p.phrase);
    if (!at) continue;
    const s = words[at[0]].s;
    const e = Math.max(words[at[1]].e, s + 0.35);
    if (s < 0.8 || e > duration - 0.6) continue;
    if (pops.some((q) => Math.abs(q.s - s) < 4)) continue;
    pops.push({ s, e: Math.min(duration - 0.3, e + 0.5), text: p.display || p.phrase, words: Array.from({ length: at[1] - at[0] + 1 }, (_, k) => at[0] + k) });
  }
  pops.sort((a, b) => a.s - b.s);
  return { pops, callouts: [] };
}
