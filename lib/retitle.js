// Rewriting a finished clip's words on the page: the burned-in headline and the posting copy, from the words the
// clip actually plays. Used when the titles miss — they read like moods or quotes instead of naming what a practice
// owner gets out of the clip. The picks stay exactly as they are; only the writing changes.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { audienceGuidance } from "./audience.js";
import { titleGuidance } from "../titles/index.js";
import { clipTasteGuidance } from "./cliptaste.js";
import { formatMoneyText } from "./money.js";
import { clipText } from "./cliptaste.js";

const MODEL = "claude-opus-5";

const Schema = z.object({
  on_screen_title: z.string().describe("the headline burned into the video: max 8 words, the value this clip gives a practice owner"),
  title_highlight: z.string().describe("the single strongest word from on_screen_title"),
  post_title: z.string(),
  post_caption: z.string().describe("1–3 sentences to the same audience, ending on a clear, understated call to action"),
  hashtags: z.array(z.string()).describe("3–5, no spaces, no #fyp or #viral"),
  why: z.string().describe("one line: what a practice owner takes away from this clip"),
});

const SYSTEM = `You write the on-screen headline and posting copy for premium short clips aimed at healthcare practice owners — chiropractors, physical therapists, med spa and clinic owners — with some lifestyle content.

The headline carries the value: the number, the move, the mistake or the rule, said in their world (patients, practice, cash, hiring, ads, referrals, insurance, the treatment room). "One hire pays for itself in one conversion" works. "4 AM, Alone With My Thoughts" does not — it's a mood, and it tells a practice owner nothing. When the clip is mindset or lifestyle, name the business outcome it buys.

Premium voice: no emoji, no ALL-CAPS, no clickbait formulas, no hype. Money always with $ and short units ($1, $20k, $100k/month). Never open on "this", "that", "it", or a name the viewer doesn't know. Max 8 words.`;

/** Fresh headline and posting copy for one clip, from the words it plays. */
export async function retitleClip({ project, clip, words, note = "" }) {
  const { transcript } = clipText(clip, words);
  if (!transcript) throw new Error("This clip has no words to write from.");
  const response = await new Anthropic().beta.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: betaZodOutputFormat(Schema) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [SYSTEM, await audienceGuidance(), await titleGuidance(), await clipTasteGuidance()].filter(Boolean).join("\n\n"),
    messages: [
      {
        role: "user",
        content: `Video: ${project.name}
Current headline (the creator wants better): "${clip.title}"
${note ? `What they asked for: ${note}\n` : ""}
<clip_words>
${transcript}
</clip_words>

Write the new headline and posting copy.`,
      },
    ],
  });
  const out = response.parsed_output;
  if (!out) throw new Error("That rewrite came back incomplete. Try again.");
  return {
    title: formatMoneyText(out.on_screen_title.trim()).slice(0, 120),
    highlight: out.title_highlight.trim().slice(0, 40),
    postTitle: formatMoneyText(out.post_title.trim()).slice(0, 160),
    caption: out.post_caption.trim().slice(0, 2000),
    hashtags: out.hashtags.map((h) => `#${String(h).replace(/^#+/, "").replace(/\s+/g, "")}`).filter((h) => h.length > 1).slice(0, 5),
    reason: out.why.trim().slice(0, 300),
  };
}
