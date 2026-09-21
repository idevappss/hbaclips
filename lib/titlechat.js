// A chat for brainstorming titles from the creator's own ideas: they describe a video, a topic or a rough title,
// Claude answers in their voice with a short reply and a list of titles they can save with one tap. Uses the
// title taste the TITLES module has learned (titles/index.js titleGuidance) and the brand's premium rules.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { titleGuidance } from "../titles/index.js";
import { hasProfanity } from "./profanity.js";

const MODEL = "claude-opus-5";
const KINDS = ["hook", "post", "youtube", "idea"];

const ReplySchema = z.object({
  reply: z.string().describe("1–3 sentences to the creator: what you went for, or a question if their idea needs one detail to title well"),
  titles: z.array(
    z.object({
      title: z.string(),
      kind: z.enum(KINDS).describe("hook = burned into a clip (max 8 words); post = Reels/TikTok post title; youtube = YouTube video title; idea = a content idea as a title"),
      why: z.string().describe("one short sentence"),
    }),
  ),
});

const SYSTEM = `You're the title partner for a premium creator brand. Its core audience is healthcare professionals — doctors, chiropractors, physical therapists — and it's expanding into lifestyle, because lifestyle sells in any niche: money, freedom, mindset, day-in-the-life, the life the work pays for. Titles should land with both, and stay credible to a healthcare audience. The creator comes to you with ideas: a video they filmed, a topic, a story, a rough title, or a title they want sharpened. You give them titles that make the right person stop and click.

How you write:
- Premium and specific. Confident statements, sharp questions, real numbers and outcomes when the idea gives them. Calm, never shouting.
- Title Case or sentence case. No emoji, no ALL-CAPS words, no stacked punctuation, no profanity (not even censored).
- Money always has a dollar sign and short units: "$1", "$20k", "$100k/month", "$1.5M/year".
- Favor the creator's format: a hook that grabs doctors, chiropractors and physical therapists (a big truth, their own question, or a call-out), a problem, then the solution.
- No clickbait formulas ("You won't believe", "This changes everything", "Watch till the end") and no hype adjectives ("insane", "crazy", "literally").
- Never promise more than the idea delivers. If the idea is thin, say what one detail would make it land, and still give your best titles.
- Match the format: hooks max 8 words; post titles under 70 characters; YouTube titles under 70 characters with a clear payoff and the words people search for.
- Mix angles (a lesson, a number, a contrarian take, a story, a question) unless they ask for one. Give 6–10 titles per turn unless asked for a different number.
- When they react ("shorter", "more like the second one", "less salesy"), revise from that — keep what they liked.`;

/**
 * @param messages  the conversation so far: [{ role: "user" | "assistant", content: string }], newest last
 * @param kind      optional format to focus on (hook | post | youtube | idea)
 * @returns {{ reply: string, titles: [{ title, kind, why }] }}
 */
export async function titleChat({ messages, kind = null }) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw new Error("Add ANTHROPIC_API_KEY to .env to use the title chat.");
  const turns = (Array.isArray(messages) ? messages : [])
    .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-16)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!turns.length || turns.at(-1).role !== "user") throw new Error("Type an idea to get titles for.");
  if (turns[0].role !== "user") turns.shift();
  if (KINDS.includes(kind)) turns[turns.length - 1] = { role: "user", content: `${turns.at(-1).content}\n\n(Focus on ${kind} titles.)` };

  const response = await new Anthropic().beta.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: betaZodOutputFormat(ReplySchema) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [SYSTEM, await titleGuidance()].filter(Boolean).join("\n\n"),
    messages: turns,
  });
  if (response.stop_reason === "refusal") throw new Error("Claude couldn't help with that one. Try describing the idea another way.");
  if (!response.parsed_output) throw new Error("The titles came back incomplete. Try again.");
  const { reply, titles } = response.parsed_output;
  // The premium rules are checked, not just asked for.
  const premium = (t) => !hasProfanity(t) && !/\p{Extended_Pictographic}/u.test(t) && !/[!?]{2,}/.test(t);
  return { reply, titles: titles.filter((t) => t.title?.trim() && premium(t.title)).slice(0, 12) };
}
