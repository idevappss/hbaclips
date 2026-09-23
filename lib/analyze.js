// Picks viral titles and the best 3–6 clips from a transcript using Claude.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { titleGuidance } from "../titles/index.js";
import { tasteGuidance } from "./study.js";
import { formatMoneyText } from "./money.js";
import { performanceGuidance } from "./performance.js";
import { clipTasteGuidance } from "./cliptaste.js";
import { audienceGuidance } from "./audience.js";

const MODEL = "claude-opus-5";

// What makes a short worth posting, weighted. The clip's score is these ratings, not a gut number, so two
// clips picked on different days are measured the same way.
export const CLIP_FACTORS = {
  hook: { weight: 20, hint: "the first 3 seconds stop the scroll on their own" },
  payoff: { weight: 18, hint: "it delivers on that opening — a point, a number, a turn" },
  standalone: { weight: 18, hint: "it makes sense to someone who saw nothing else" },
  context: { weight: 14, hint: "the setup it needs is inside the clip, not before it" },
  boundaries: { weight: 14, hint: "starts and ends on a complete thought, no dangling half-sentence" },
  distinct: { weight: 8, hint: "says something the other clips don't" },
  visual: { weight: 8, hint: "there is something to watch, not just audio" },
};

const RatingsSchema = z.object(
  Object.fromEntries(Object.entries(CLIP_FACTORS).map(([key, f]) => [key, z.number().describe(`0–4: ${f.hint}`)])),
);

/** The weighted 0–100 score for a clip's factor ratings (each 0–4). Null when the ratings are missing. */
export function ratedScore(ratings) {
  if (!ratings) return null;
  let total = 0;
  for (const [key, f] of Object.entries(CLIP_FACTORS)) {
    const r = Number(ratings[key]);
    if (!Number.isFinite(r)) return null;
    total += (Math.min(4, Math.max(0, r)) / 4) * f.weight;
  }
  return Math.round(total);
}

const AnalysisSchema = z.object({
  summary: z.string().describe("1–2 sentences on what the video is about"),
  titles: z.array(
    z.object({
      title: z.string(),
      angle: z.string().describe("e.g. curiosity gap, bold claim, contrarian, how-to, story, list, emotional"),
      score: z.number().describe("viral potential 1–100"),
      why: z.string(),
    }),
  ),
  youtube_titles: z.array(
    z.object({
      title: z.string(),
      score: z.number().describe("click-through potential 1–100"),
      why: z.string(),
    }),
  ),
  hooks: z.array(
    z.object({
      hook: z.string().describe("scroll-stopping opening line, max 15 words"),
      type: z.string().describe("e.g. question, bold claim, stat, story open, contrarian, warning"),
      score: z.number().describe("1–100"),
      why: z.string(),
    }),
  ),
  key_messages: z.array(
    z.object({
      segment: z.number().describe("index of the transcript segment where it's said"),
      quote: z.string().describe("the insight in the speaker's own words, lightly cleaned up"),
      takeaway: z.string().describe("one line on why it's valuable"),
      score: z.number().describe("1–100"),
    }),
  ),
  clips: z.array(
    z.object({
      start_segment: z.number().describe("index of the first transcript segment in the clip"),
      end_segment: z.number().describe("index of the last transcript segment in the clip (inclusive)"),
      cut_segments: z.array(z.number()).describe("segment indexes inside the range to leave out: rambles, restarts, repeats, asides"),
      hook_segment: z.number().describe("index of the segment the clip should OPEN on when the best hook line is said outside the range (before or after it); -1 when the clip's own first segment is the hook"),
      on_screen_title: z.string().describe("hook headline burned into the video, max 8 words"),
      title_highlight: z.string().describe("the single most powerful word from on_screen_title"),
      post_title: z.string(),
      post_caption: z.string(),
      hashtags: z.array(z.string()),
      payoff: z.string().describe("what the viewer gets by the end of the clip, in one sentence"),
      ratings: RatingsSchema,
      taste_match: z.number().describe("0–4: how closely this clip matches the clips the creator hearted (<creator_clip_taste>); 2 when there is no taste to go on"),
      virality_score: z.number().describe("1–100"),
      hook_reason: z.string(),
      emphasis_words: z.array(z.string()),
    }),
  ),
});

const SYSTEM = `You are a short-form video strategist and editor who has cut thousands of clips for TikTok, Instagram Reels, and YouTube Shorts. You find the moments in long-form videos that stop the scroll, you cut away everything that doesn't earn its place, and you write titles people want to click — without promising anything the content doesn't deliver.

The creator's audience is healthcare professionals — doctors, chiropractors, physical therapists — and the brand is growing into lifestyle, because lifestyle content sells in any niche. Value both: sharp clinical or business-of-practice insight, and strong lifestyle and personal moments (money, freedom, mindset, day-in-the-life, relationships, the life the work pays for). A great lifestyle moment is as much a clip as a great lesson; keep everything credible to a healthcare audience.

This is a premium brand. Every title, headline and caption you write reads like it came from a respected expert, not a hype page:
- Confident, specific and calm. A clear statement or a sharp question beats shouting.
- Title Case or sentence case. Never ALL-CAPS words, never emoji, never more than one punctuation mark in a row ("!!", "?!").
- No clickbait formulas ("You won't believe", "This will change your life", "Wait for it", "Watch till the end"), no slang filler ("insane", "crazy", "literally"), no hype adjectives.
- Numbers, names and real outcomes are welcome when the video actually says them.
- Hashtags are specific to the topic and audience. Never #fyp, #viral, #foryou, #trending or #explore.
- No profanity or slurs anywhere you write, even when the speaker uses them — not even censored ("f***").
- Money is always written with a dollar sign and short units: "$1", "$20k", "$100k/month", "$1.5M/year" — never "20 K", "100k a month" or "twenty thousand dollars".`;

export function hasClaudeKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/**
 * @returns {{ mode: "claude"|"demo", summary: string, titles: object[], clips: object[] }}
 *          clips reference transcript segments; call resolveClips() to turn them into time ranges.
 */
/** A user-facing explanation of why a Claude call failed. */
export function describeClaudeError(err) {
  const msg = err?.error?.error?.message || err?.message || String(err);
  if (/credit balance/i.test(msg)) {
    return "Your Anthropic account is out of API credits, so these are demo picks. Add credits at console.anthropic.com (Plans & Billing), then hit Refresh.";
  }
  if (err?.status === 401 || /api[ -]?key|authentication/i.test(msg)) {
    return "Claude rejected the API key in .env, so these are demo picks. Check ANTHROPIC_API_KEY and restart the app.";
  }
  return `Claude couldn't analyze this video (${msg.slice(0, 160)}), so these are demo picks.`;
}

/** How long clips should run: 30–40 seconds from a long video (never over a minute), shorter from a short one. */
export function clipLengths(duration) {
  return { minSec: Math.min(28, Math.max(8, duration * 0.3)), maxSec: Math.min(42, Math.max(15, duration * 0.5)) };
}

export async function analyze({ segments, duration, width, height, notes, focus, materials = [], minSec, maxSec, minClips, maxClips, demo = false }) {
  if (demo || !hasClaudeKey()) {
    return { mode: "demo", ...demoAnalysis({ segments, minSec, maxSec, maxClips }) };
  }

  const orientation = width >= height ? "landscape" : "portrait";
  const transcript = segments
    .map((s) => `[#${s.index} | ${s.start.toFixed(1)}–${s.end.toFixed(1)}s] ${s.text}`)
    .join("\n");

  const prompt = `Plan viral short-form content from this video.

Video: ${duration.toFixed(1)} seconds, ${orientation}.
${notes ? `Creator notes: ${notes}\n` : ""}${focus ? `\n<focus>\n${focus}\n</focus>\n` : ""}${materials.length ? "\nThe creator attached pictures and/or PDFs (above) that go with this video — slides, an offer, notes. Use them for context: spell names, numbers, offers and terms the way they appear there, and let them sharpen titles and hooks. Clips still come only from what is said in the transcript.\n" : ""}
Transcript segments, formatted as [#index | start–end seconds] text:
<transcript>
${transcript}
</transcript>

Deliver:
1. summary — what the video is about.
2. titles — 10 short-form post titles for content from this video, ranked by viral potential. Mix angles. Keep each under 70 characters and in the speaker's language.
3. youtube_titles — 10 YouTube titles for the full video: under 70 characters, a clear payoff plus curiosity, and the words this audience actually searches for.
4. hooks — 10 scroll-stopping opening lines a creator could say or put on screen in the first two seconds (max 15 words), grounded in what the video actually says.
5. key_messages — the 8–12 most valuable, quotable moments: the insight in the speaker's own words, the segment index where it's said, and a one-line takeaway.
6. clips — the ${minClips}–${maxClips} strongest standalone moments, ordered strongest first. A short list of real ones beats a padded list: return fewer than ${maxClips}, even just one, when the video doesn't have more.
   - A clip is the range start_segment..end_segment. Aim for ${Math.round(minSec)}–${Math.round(maxSec)} seconds of what's left after cut_segments, and never more than 55. Pick the range itself to be no longer than ${Math.round(maxSec * 1.5)} seconds (end time of end_segment minus start time of start_segment): cuts trim a clip, they don't rescue a long one. Add up the durations before you answer. Clips must not overlap.
   - cut_segments: tighten the clip the way a senior editor would. List the segment indexes inside the range that don't earn their place — a ramble or tangent, a false start the speaker restarts, a point made twice, a throat-clearing opener ("so yeah, anyway"), a detail that doesn't serve the payoff. Keep every segment the payoff depends on, and keep the result reading as one continuous thought when played back. Never cut the first or last segment of the range. An empty list is right when the clip is already tight.
   - Every clip follows the creator's format: HOOK → PROBLEM → SOLUTION.
     HOOK (first 3 seconds): a line that stops a doctor, chiropractor or physical therapist — a big truth or promise ("It's easier than ever to get to six figures a month"), the question they're already asking themselves, or a direct call-out ("If you're a chiropractor still doing X…").
     PROBLEM: why they're not there yet, in plain terms ("the reason you're not there is you're running the wrong system").
     SOLUTION: what to do, said to them ("if you're a doctor, PT or chiropractor, you need to…"), ending on the payoff.
     A clip that is only a story or only an opinion with no solution rates low on payoff.
   - It has to work with zero context and end on a payoff, never mid-thought. If the moment is an answer, start on the question.
   - hook_segment: if the strongest hook for this clip is said somewhere else in the video (often the opening minutes, where the speaker frames the whole talk), give that segment's index and the clip will open on it before its own range. It must be one complete, self-contained sentence of at most 8 seconds that sets up THIS clip's problem and solution. Use -1 when the clip's first segment already is that hook.
   - Never open on a word that leans on what came before ("that", "it", "this", "so", "and", "but", "because", "yeah", "he/she/they") unless the clip truly stands alone anyway.
   - payoff: one sentence on what the viewer walks away with. If you can't write one, it isn't a clip.
   - When the good line is a punchline or a conclusion, start the clip early enough to include the setup that makes it land, and end after the reaction rather than on the last word.
   - Curse words and slurs never reach the viewer. Put every segment with one in cut_segments; if the moment only works with the profanity in it, pick a different moment.
   - The 2-second test: would a doctor, chiropractor or PT scrolling past stop in the first 2 seconds, with no idea who the speaker is? If not, move the start to a stronger line or skip the moment.
   - No two clips may make the same point, even in different words. Spread the picks across the whole video, not just its opening.
   - Retakes: when the speaker says the same thing twice because they restarted, first make sure it really is a retake and not a deliberate repeat. Keep the one complete version (usually the later take) and cut the abandoned one, but keep any setup from the earlier take that the later one doesn't repeat. Never stitch half a sentence from one take onto half from another.
   - Small words like "so", "like", "right" at a sentence start: cut them only when they're pure padding; when in doubt, keep them — the tightening pass handles hesitations.
   - Interviews: if a clip is someone's answer, keep the question that makes it make sense.
   - One clip, one idea. Never use cut_segments to join the end of one topic onto the start of another (the ad-agency story onto the application funnel); if a range covers two topics, keep the stronger one and end the clip where it lands.
   - Every cut must leave complete sentences on both sides: the kept segment before a cut ends a sentence and the one after starts one. If a segment holds half of a sentence you need, keep it or move the cut.
   - Nothing may point outside the clip: "the six I mentioned", "like I said", "the next one", "that funnel", a name never introduced. Cut the reference or pick a different range.
   - End on the payoff sentence itself — the takeaway said plainly — not on numbers trailing off, a new list starting, or a call to subscribe.
   - Lines that guarantee the viewer an outcome ("I guarantee your business will…") go in cut_segments when the clip survives without them; the creator's own results said as results are fine.
   - Throw a candidate out before scoring it if any of these is true: it opens mid-sentence; it only makes sense if you heard something earlier in the video; it sets something up and never resolves it; it leans on a visual the viewer can't see; or another, stronger clip already makes the same point.
   - ratings — rate the survivors 0–4 on each factor, where 0 = absent, 1 = weak, 2 = serviceable, 3 = strong, 4 = exceptional:
${Object.entries(CLIP_FACTORS).map(([key, f]) => `     ${key}: ${f.hint}`).join("\n")}
     Rate what is actually there. 4 means you'd show it as an example of that factor; most real clips sit at 2 or 3, and a moment that plays like ordinary conversation cannot rate above 2 on hook.
   - virality_score (1–100): how it would do if posted today. Use the whole range — most clips from a normal video land between 40 and 70, and only a moment a stranger would send to a friend belongs above 85. If the answer to "would someone stop scrolling in the first 2 seconds?" is no, cap it at 55.
   - on_screen_title is the headline burned into the video: max 8 words, premium voice, and it must carry the value this clip gives a practice owner — the number, the move, the mistake or the rule ("One hire pays for itself in one conversion", "Stripe holds your money for 90 days", "$300 to get a patient, $3,000 back"). Say it in their world: patients, practice, cash, hiring, ads, referrals, insurance, the treatment room. A mood line, a scene, or a quote that means nothing without the clip is wrong, however good it sounds ("4 AM, Alone With My Thoughts" is a failed title; "The hour before the clinic opens is the whole business" is the same moment, told for them). Never open on "this", "that", "it" or a name the viewer doesn't know. When the moment is mindset or lifestyle, name the business outcome it buys. title_highlight is its single strongest word.
   - post_title, post_caption (1–3 sentences ending with a clear, understated call to action) and hashtags (3–5, no spaces) are ready-to-paste posting copy, written to the same audience as the headline.
   - emphasis_words: 3–8 words actually spoken in the clip that carry the meaning.
   - hook_reason: one sentence on why this moment will perform.
   - taste_match: 0–4 against the creator's hearted clips — the kind of opening, angle, structure and energy they loved. 2 when there is no taste to go on.`;

  const client = new Anthropic();
  // Streamed, like the long edit and audience reads: a non-streamed call is capped near 20k output tokens,
  // and adaptive thinking on a full transcript regularly spends more than that before the clips are written —
  // which truncated the JSON mid-clip and sent the whole video to demo picks.
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: betaZodOutputFormat(AnalysisSchema) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // The creator's title taste (titles/, owned by the TITLES session) and the videos they study (active profile).
    // Both are empty until the creator has given feedback.
    // Plus what has actually performed on the creator's accounts once there are posted clips with results, and the
    // clips they hearted or passed on before rendering (lib/cliptaste.js).
    // Plus who the clips are for, learned from the creator's own workshops and client calls (lib/audience.js).
    system: [SYSTEM, await audienceGuidance(), await titleGuidance(), await tasteGuidance(), await clipTasteGuidance(), await performanceGuidance()].filter(Boolean).join("\n\n"),
    messages: [{ role: "user", content: materials.length ? [...materials, { type: "text", text: prompt }] : prompt }],
  });
  const response = await stream.finalMessage();

  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined to analyze this video${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : "."}`);
  }
  if (response.stop_reason === "max_tokens" || !response.parsed_output) {
    throw new Error("Claude's analysis came back incomplete. Try again.");
  }
  return { mode: "claude", ...response.parsed_output };
}

/** The title/hook/message side of an analysis, shaped for project.analysis. */
export function packAnalysis(a, segments) {
  const last = segments.length - 1;
  const at = (index) => segments[Math.min(last, Math.max(0, Math.round(index)))];
  const score = (n) => Math.round(Math.min(100, Math.max(1, Number(n) || 0)));
  return {
    mode: a.mode,
    summary: a.summary,
    warning: a.warning || null,
    titles: (a.titles || []).map((t) => ({ ...t, score: score(t.score) })),
    youtubeTitles: (a.youtube_titles || []).map((t) => ({ ...t, score: score(t.score) })),
    hooks: (a.hooks || []).map((h) => ({ ...h, score: score(h.score) })),
    messages: (a.key_messages || []).map((m) => ({ quote: m.quote, takeaway: m.takeaway, score: score(m.score), start: at(m.segment)?.start ?? 0 })),
    analyzedAt: new Date().toISOString(),
  };
}

/** Convert segment-indexed clips into non-overlapping time ranges snapped to speech. */
export function resolveClips(rawClips, segments, duration, { maxClips }) {
  const clips = [];
  const last = segments.length - 1;
  // Strongest first by the rubric, so the ranking doesn't depend on the order they came back in.
  const graded = [...rawClips]
    .map((c) => {
      const rated = ratedScore(c.ratings);
      const gut = Math.round(Math.min(100, Math.max(1, Number(c.virality_score) || 0)));
      // The rubric carries the ranking; the gut call still moves it a little.
      // Clips like the ones the creator hearted move up; 2 (no taste yet, or neutral) leaves the score alone.
      const taste = Number.isFinite(c.taste_match) ? (Math.min(4, Math.max(0, c.taste_match)) - 2) * 3 : 0;
      return { ...c, score: Math.round(Math.min(100, Math.max(1, (rated === null ? gut : rated * 0.65 + gut * 0.35) + taste))) };
    })
    .sort((a, b) => b.score - a.score);
  // Clips still well over a minute after their cuts would lose their ending to the length cap, and a clip
  // without its payoff isn't worth posting — so they're only used when nothing else fit.
  for (const allowLong of [false, true]) {
    if (allowLong && clips.length) break;
    for (const c of graded) {
      let a = Math.min(last, Math.max(0, Math.round(c.start_segment)));
      let b = Math.min(last, Math.max(0, Math.round(c.end_segment)));
      if (b < a) [a, b] = [b, a];
      // A clip can't open mid-thought ("Because now…", "Then in the moonshot group…", "That's why…"): step past
      // leaning openers while the clip keeps at least 20 seconds, unless a hook from elsewhere opens it anyway.
      const leans = (i) => /^\s*(because|cause|then|and|but|so|or|which|that's why|that is why|as some|also|plus|like i said|anyway)\b/i.test(segments[i].text);
      if (!(Number(c.hook_segment) >= 0)) while (a < b && leans(a) && segments[b].end - segments[a + 1].start >= 20) a++;
      // A little air either side, but never reaching into the sentence before or the one after.
      const start = Math.max(0, segments[a].start - 0.15, (segments[a - 1]?.end ?? -1) + 0.02);
      const end = Math.min(duration, segments[b].end + 0.45, (segments[b + 1]?.start ?? Infinity) - 0.05);
      if (end - start < 3 || clips.some((o) => start < o.end && end > o.start)) continue;
      const parts = keptParts(c.cut_segments, a, b, segments, start, end);
      const kept = parts ? parts.reduce((sum, p) => sum + (p.end - p.start), 0) : end - start;
      if (kept > 72 && !allowLong) continue;
      clips.push({
        id: `clip-${clips.length + 1}`,
        rank: clips.length + 1,
        start: +start.toFixed(3),
        end: +end.toFixed(3),
        ...(parts ? { parts } : {}),
        title: formatMoneyText(c.on_screen_title.trim()),
        highlight: (c.title_highlight || "").trim(),
        postTitle: formatMoneyText(c.post_title.trim()),
        caption: c.post_caption.trim(),
        hashtags: c.hashtags.map((h) => `#${h.replace(/^#+/, "").replace(/\s+/g, "")}`).filter((h) => h.length > 1),
        score: c.score,
        ratings: c.ratings || null,
        tasteMatch: Number.isFinite(c.taste_match) ? c.taste_match : null,
        reason: c.hook_reason,
      payoff: c.payoff || null,
      ...hookFrom(c.hook_segment, a, b, segments),
        emphasis: c.emphasis_words,
      });
      if (clips.length >= maxClips) break;
    }
  }
  return clips;
}

/**
 * The clip's opening line when Claude picked one from elsewhere in the video: { hook: { start, end } }, or nothing
 * when it's the clip's own first segment, inside its range, or too long to be a hook.
 */
function hookFrom(index, a, b, segments) {
  const i = Math.round(Number(index));
  if (!Number.isInteger(i) || i < 0 || i >= segments.length || (i >= a && i <= b)) return {};
  const seg = segments[i];
  if (seg.end - seg.start > 8.5 || seg.end - seg.start < 1.2) return {};
  const start = Math.max(0, seg.start - 0.05, (segments[i - 1]?.end ?? -1) + 0.02);
  const end = Math.min(seg.end + 0.15, (segments[i + 1]?.start ?? Infinity) - 0.05);
  return { hook: { start: +start.toFixed(3), end: +end.toFixed(3) } };
}

/**
 * The stretches of a clip left after its cut segments come out: [{ start, end }] in source seconds, or null when
 * nothing is cut. The first and last segments always stay, so the clip still opens and lands where it was picked.
 */
function keptParts(cuts, a, b, segments, start, end) {
  const drop = new Set((cuts || []).map((i) => Math.round(Number(i))).filter((i) => i > a && i < b));
  if (!drop.size) return null;
  const parts = [];
  let run = null;
  for (let i = a; i <= b; i++) {
    if (drop.has(i)) {
      run = null;
      continue;
    }
    // A run starts just before its first word (or at the clip's own start) and ends just after its last.
    const from = i === a ? start : Math.max(segments[i].start - 0.08, segments[i - 1].end + 0.02);
    const to = i === b ? end : Math.min(segments[i].end + 0.12, segments[i + 1].start - 0.05);
    if (run && !drop.has(i - 1)) run.end = to;
    else parts.push((run = { start: from, end: to }));
  }
  const r3 = (n) => Math.round(n * 1000) / 1000;
  return parts.map((p) => ({ start: r3(p.start), end: r3(p.end) }));
}

// ---------------------------------------------------------------------------
// Demo mode: a keyword heuristic so the full pipeline can run without an API key.

const HOOK_RE = /\?|!|\d|\b(you|your|never|always|secret|truth|mistake|nobody|everyone|stop|why|how|best|worst|lie|money|rule|fail|changed|remember)\b/gi;

function demoAnalysis({ segments, minSec, maxSec, maxClips }) {
  const segScore = segments.map((s) => ((s.text.match(HOOK_RE) || []).length * 10) / Math.max(4, s.text.split(" ").length));
  const target = (minSec + maxSec) / 2;
  const windows = [];
  for (let i = 0; i < segments.length; i++) {
    let j = i;
    while (j + 1 < segments.length && segments[j + 1].end - segments[i].start <= maxSec && segments[j].end - segments[i].start < target) j++;
    if (segments[j].end - segments[i].start < minSec) continue;
    const body = segScore.slice(i, j + 1);
    windows.push({ i, j, score: segScore[i] * 2 + body.reduce((x, y) => x + y, 0) / body.length });
  }
  windows.sort((x, y) => y.score - x.score);

  const picked = [];
  for (const w of windows) {
    if (picked.length >= maxClips) break;
    if (!picked.some((p) => !(w.j < p.i || w.i > p.j))) picked.push(w);
  }
  const top = picked[0]?.score || 1;

  const wordCount = (text) => text.split(" ").length;
  const titleCase = (text) =>
    text.replace(/[.,!?;:]+$/, "").split(" ").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  const seen = new Set();
  const firstTime = (text) => {
    const key = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const titles = [...segments]
    .map((s, i) => ({ s, score: segScore[i] }))
    .filter(({ s }) => wordCount(s.text) >= 3 && wordCount(s.text) <= 12)
    .sort((x, y) => y.score - x.score)
    .filter(({ s }) => firstTime(s.text))
    .slice(0, 10)
    .map(({ s, score }, n) => ({
      title: titleCase(s.text),
      angle: s.text.includes("?") ? "curiosity gap" : /\d/.test(s.text) ? "specific number" : "bold claim",
      score: Math.round(90 - n * 3 - (score ? 0 : 10)),
      why: "Demo mode heuristic — add an ANTHROPIC_API_KEY for real title strategy.",
    }));

  const clips = picked.map((w) => {
    const span = segments.slice(w.i, w.j + 1);
    const text = span.map((s) => s.text).join(" ");
    // Prefer the punchiest complete sentence that fits a hook card over a truncated one.
    const short = span.filter((s) => wordCount(s.text) <= 8).sort((x, y) => segScore[y.index] - segScore[x.index])[0];
    const hook = titleCase(short ? short.text : segments[w.i].text.split(" ").slice(0, 6).join(" "));
    const emphasis = [...new Set(text.split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}']/gu, "")).filter((t) => t.length >= 6))]
      .sort((x, y) => y.length - x.length)
      .slice(0, 5);
    return {
      start_segment: w.i,
      end_segment: w.j,
      on_screen_title: hook,
      title_highlight: hook.split(" ").sort((x, y) => y.length - x.length)[0] || "",
      post_title: hook,
      post_caption: `${segments[w.i].text} Follow for more.`,
      hashtags: [],
      virality_score: Math.round(60 + (35 * w.score) / top),
      hook_reason: "Demo mode heuristic: dense with hook words and numbers.",
      emphasis_words: emphasis,
    };
  });

  const ranked = segments.map((s, i) => ({ s, score: segScore[i] })).sort((x, y) => y.score - x.score);
  const demoWhy = "Demo mode heuristic — add an ANTHROPIC_API_KEY for the real thing.";
  const youtube_titles = titles.map((t) => ({ title: t.title, score: t.score - 3, why: demoWhy }));
  const hooks = ranked
    .filter(({ s }) => wordCount(s.text) <= 15 && /\?|\byou\b|\d/i.test(s.text))
    .slice(0, 10)
    .map(({ s }, n) => ({ hook: s.text, type: s.text.includes("?") ? "question" : "bold claim", score: 88 - n * 3, why: demoWhy }));
  const key_messages = ranked
    .filter(({ s }) => wordCount(s.text) >= 10)
    .slice(0, 10)
    .map(({ s }, n) => ({ segment: s.index, quote: s.text, takeaway: demoWhy, score: 86 - n * 3 }));

  return { summary: "Demo mode — clips were chosen by a keyword heuristic, not Claude.", titles, youtube_titles, hooks, key_messages, clips };
}
