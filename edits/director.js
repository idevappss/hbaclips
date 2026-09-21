// The edit director: looks at every source (contact sheets + moment stats + speech), the music's beat map
// and the creator's style ideas, then writes a shot-by-shot plan. Claude when a key is set, a
// beat-aware heuristic otherwise.
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { titleGuidance } from "../titles/index.js";
import { EFFECTS, LOOKS, SPEEDS, TEXT_STYLES, TRANSITIONS, ACCENTS, vocabulary } from "./looks.js";

const MODEL = "claude-opus-5";

export function hasClaudeKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** A short, human reason Claude couldn't do the job (shown next to the fallback result). */
export function claudeProblem(err) {
  const msg = err?.error?.error?.message || err?.message || String(err);
  if (/credit balance/i.test(msg)) return "Claude is out of API credits (console.anthropic.com → Plans & Billing)";
  if (err?.status === 401 || /api[ -]?key|authentication/i.test(msg)) return "Claude rejected the API key in .env";
  if (err?.status === 429 || /rate limit/i.test(msg)) return "Claude is rate-limited right now";
  if (err?.status >= 500 || /overloaded/i.test(msg)) return "Claude is temporarily unavailable";
  return `Claude hit an error (${msg.slice(0, 120)})`;
}

const ids = (o) => Object.keys(o);

const PlanSchema = z.object({
  concept: z.string().describe("1–2 sentences: the idea and arc of this edit"),
  title: z.string().describe("hook text over the opening, max 6 words, or empty string for none"),
  look: z.enum(ids(LOOKS)),
  look_intensity: z.number().describe("0.3–1"),
  text_style: z.enum(ids(TEXT_STYLES)),
  accent: z.string().describe("accent color as RRGGBB hex"),
  music_start: z.number().describe("seconds into the music track where the edit starts; 0 when there is no music"),
  shots: z.array(
    z.object({
      source: z.string().describe("source id letter, e.g. B"),
      moment: z.string().describe("moment id from the source lists, e.g. B7 (for a spoken line between moments, the nearest one)"),
      start: z.number().describe("source second where the used action starts"),
      end: z.number().describe("source second where the action ends; for dialogue, the end of the spoken line"),
      beats: z.number().describe("how many beats the shot holds, 1–8 (dialogue shots hold until the line ends)"),
      audio: z.enum(["music", "source"]).describe("source = hear this clip's own sound (dialogue); music = music bed only"),
      speed: z.enum(ids(SPEEDS)),
      effects: z.array(z.enum(ids(EFFECTS))).describe("0–2 effects"),
      transition: z.enum(ids(TRANSITIONS)).describe("transition INTO this shot (ignored on the first shot)"),
      text: z.string().describe("1–4 word slam burned over this shot, or empty string"),
      focus_x: z.number().describe("0–100: where the subject sits horizontally, for cropping to the output aspect"),
      frame: z.enum(["fill", "fit"]).describe("fill = crop to fill the frame; fit = whole frame over a blurred backdrop (wide shots that can't be cropped)"),
      why: z.string().describe("a few words on why this shot is here"),
    }),
  ),
});

const SYSTEM = `You are an elite short-form video editor known for "dope edits": music-synced montages for TikTok, Reels and Shorts with hard-hitting beat cuts, speed ramps, whip transitions, punchy zooms and a strong color grade. You pick only the best, most visually striking moments, you never leave dead air, and every cut lands on the music. Your edits feel intentional, not random: a hook in the first second, a build, a payoff on the drop, a clean ending.`;

function momentLine(m, s) {
  return `${m.id} ${m.start.toFixed(1)}–${m.end.toFixed(1)}s motion ${m.motion} bright ${m.bright} color ${m.sat}${s.hasAudio ? ` loud ${m.loud}` : ""} score ${m.score}${m.cut ? " (new shot)" : ""}`;
}

async function sourceBlocks(sources) {
  const blocks = [];
  for (const s of sources) {
    const top = new Set([...s.moments].sort((a, b) => b.score - a.score).slice(0, 90).map((m) => m.id));
    for (const sheet of s.sheets) sheet.moments.forEach((id) => top.add(id));
    const listed = s.moments.filter((m) => top.has(m.id));
    blocks.push({
      type: "text",
      text: `<source id="${s.letter}" name="${s.name}">
${s.duration.toFixed(1)}s, ${s.orientation} ${s.width}×${s.height} @ ${s.fps}fps, ${s.hasAudio ? "has sound" : "silent"}, ${s.cuts} internal cuts.
Moments${listed.length < s.moments.length ? ` (best ${listed.length} of ${s.moments.length})` : ""}:
${listed.map((m) => momentLine(m, s)).join("\n")}${s.speech?.length ? `\nSpeech:\n${s.speech.slice(0, 900).map((l) => `[${l.start.toFixed(1)}–${l.end.toFixed(1)}s] ${l.text}`).join("\n")}` : ""}
</source>`,
    });
    for (const sheet of s.sheets) {
      const data = await fs.readFile(path.join(s.workDir, sheet.file)).catch(() => null);
      if (!data) continue;
      blocks.push({ type: "text", text: `Contact sheet for source ${s.letter}: one frame per moment, labeled with moment id and source second.` });
      blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: data.toString("base64") } });
    }
  }
  return blocks;
}

function musicText(music, starts, length) {
  if (!music) return "No music track: shots are timed on a steady 0.5 s pulse (count 1 beat = 0.5 s). Keep the pacing tight.";
  const bars = music.bars.map((b) => `${b.start.toFixed(1)}s:${b.energy}`).join(" ");
  return `Music "${music.name}": ${music.bpm} BPM (a beat every ${music.period}s), ${music.duration.toFixed(1)}s long${music.drop !== null ? `, biggest drop at ${music.drop}s` : ""}.
Energy per bar (bar start: loudness 0–1): ${bars}
Suggested music_start values for a ${length}s edit: ${starts.map((s) => `${s.time}s (score ${s.score}${s.dropAt !== null ? `, drop lands ${s.dropAt}s into the edit` : ""})`).join("; ")}`;
}

/** Claude-directed plan. */
async function claudePlan({ sources, music, starts, options, style }) {
  const beatSec = music?.period || 0.5;
  const totalBeats = Math.round(options.length / beatSec);
  const vocab = vocabulary();
  const multi = sources.length > 1;

  const brief = `Direct a ${options.length}-second ${options.aspect} dope edit.

Creator's brief: ${options.vibe || "(none — make it hit hard)"}
Energy: ${options.energy}. Audio: ${
    {
      music: "music only (all shots audio=music)",
      mix: "music bed, plus a few strong spoken lines with audio=source (the music ducks under them)",
      source: "keep the clips' own sound (audio=source on every shot), no music",
    }[options.audioMode]
  }.
${options.look !== "auto" ? `Use look "${options.look}".` : "Pick the look that fits the footage and brief."} ${options.textStyle !== "auto" ? `Use text_style "${options.textStyle}".` : ""} ${options.title ? `Opening title: "${options.title}".` : "Write a hook title only if it makes the edit stronger."}

${musicText(music, starts, options.length)}

Editing rules:
- Fill the length: shot beats should add up to about ${totalBeats} beats${music ? "" : " of the 0.5 s pulse"}.
- Open on the single most striking visual. The first 1–2 seconds decide whether people keep watching.
- High-energy bars: 1–2 beat shots. Low-energy bars or intros: 2–4 beats. Put the best shot and a punch or flash exactly on the drop.
- Mostly hard cuts on the beat. Save flashy transitions for section changes (every 4–8 shots) so they keep their impact.
- 0–2 effects per shot. Use speed ramps on shots with real motion, not static ones.
${multi ? "- Use every source at least once, and mix them so the edit tells one story.\n" : "- It's one long source: take only the best moments from across the whole thing, in whatever order makes the strongest edit.\n"}- Never use a moment with bright < 0.12 unless the brief wants dark. Don't repeat a moment unless it's a deliberate callback.
- start/end are source seconds inside the chosen moment; you can use part of a moment or run slightly past it. For audio=source shots, start and end must wrap the whole spoken line.
- focus_x: look at the contact sheet and put it where the subject is, so the ${options.aspect} crop keeps them in frame.

Vocabulary:
${JSON.stringify(vocab, null, 1)}`;

  const content = [...(await sourceBlocks(sources)), { type: "text", text: brief }];
  const system = [SYSTEM, style, await titleGuidance()].filter(Boolean).join("\n\n");

  const response = await new Anthropic().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: betaZodOutputFormat(PlanSchema) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined to direct this edit${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : "."}`);
  }
  if (response.stop_reason === "max_tokens" || !response.parsed_output) throw new Error("The edit plan came back incomplete. Try again.");

  const p = response.parsed_output;
  const bySource = Object.fromEntries(sources.map((s) => [s.letter, s]));
  return {
    mode: "claude",
    concept: p.concept,
    title: p.title,
    look: p.look,
    lookIntensity: p.look_intensity,
    textStyle: p.text_style,
    accent: p.accent,
    musicStart: p.music_start,
    shots: p.shots
      .map((s) => ({ ...s, source: (String(s.source || "").trim() || String(s.moment || "").replace(/\d+$/, "")).toUpperCase(), focusX: s.focus_x }))
      .filter((s) => bySource[s.source]),
  };
}

// ---------------------------------------------------------------------------
// Heuristic director (no API key)

function rng(seed) {
  let a = [...String(seed)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const weighted = (items, rand) => {
  const total = items.reduce((s, x) => s + x.weight, 0);
  let r = rand() * total;
  for (const item of items) if ((r -= item.weight) <= 0) return item.type;
  return items.at(-1)?.type;
};

function heuristicPlan({ sources, music, starts, options, recipe, seed }) {
  const rand = rng(seed);
  const hype = options.energy !== "chill";
  const beatSec = music?.period || 0.5;
  const musicStart = starts[0]?.time ?? 0;
  const dropAt = music?.drop !== null && music?.drop !== undefined ? music.drop - musicStart : null;
  const barEnergy = (t) => {
    if (!music) return hype ? 0.8 : 0.4;
    const abs = t + musicStart;
    return music.bars.find((b) => abs >= b.start && abs < b.end)?.energy ?? 0.5;
  };

  const transitions = recipe?.transitions?.length
    ? recipe.transitions
    : hype
      ? [{ type: "cut", weight: 10 }, { type: "whip-up", weight: 2 }, { type: "whip-left", weight: 2 }, { type: "flash", weight: 2 }, { type: "zoom", weight: 1.5 }, { type: "glitch", weight: 1 }]
      : [{ type: "cut", weight: 6 }, { type: "dissolve", weight: 3 }, { type: "blur", weight: 1.5 }, { type: "dip-black", weight: 1 }];
  const effects = recipe?.effects?.length
    ? recipe.effects
    : hype
      ? [{ type: "punch", weight: 3 }, { type: "beat-zoom", weight: 1.5 }, { type: "shake", weight: 1.5 }, { type: "rgb", weight: 1 }, { type: "push", weight: 2 }, { type: "flash", weight: 1 }]
      : [{ type: "push", weight: 3 }, { type: "pull", weight: 2 }, { type: "echo", weight: 1 }];

  // Moment pools per source, best first, dark footage dropped.
  const pools = sources.map((s) => ({
    s,
    queue: [...s.moments].filter((m) => m.bright >= 0.12 && m.end - m.start >= 0.4).sort((a, b) => b.score - a.score + (rand() - 0.5) * 0.12),
  }));
  const used = new Set();
  const take = (preferMotion) => {
    const ranked = pools.filter((p) => p.queue.length).sort((a, b) => (a.uses || 0) - (b.uses || 0) || b.queue[0].score - a.queue[0].score);
    const pool = ranked[0];
    if (!pool) return null;
    let idx = 0;
    if (preferMotion) {
      const best = pool.queue.slice(0, 6).reduce((bi, m, i, arr) => (m.motion > arr[bi].motion ? i : bi), 0);
      idx = best;
    }
    const [m] = pool.queue.splice(idx, 1);
    pool.uses = (pool.uses || 0) + 1;
    used.add(m.id);
    return { m, s: pool.s };
  };

  // Dialogue: strongest short spoken lines when the audio mode wants them.
  const lines = [];
  if (options.audioMode !== "music") {
    for (const s of sources) {
      for (const l of s.speech || []) {
        const words = l.text.split(" ").length;
        const dur = l.end - l.start;
        if (dur < 1.2 || dur > 8 || words < 4) continue;
        const punch = (l.text.match(/[!?]|\b(never|always|secret|nobody|everyone|best|worst|crazy|insane|love|hate|money|real|truth)\b/gi) || []).length;
        lines.push({ s, l, score: punch + words / dur / 4 + rand() * 0.5 });
      }
    }
    lines.sort((a, b) => b.score - a.score);
  }
  const maxLines = options.audioMode === "source" ? Infinity : Math.max(1, Math.round(options.length / 15));

  const shots = [];
  let t = 0;
  let sinceFlashy = 0;
  let lastFlashy = null;
  let spoken = 0;
  while (t < options.length - beatSec * 0.5 && shots.length < 200) {
    const energy = barEnergy(t);
    const isDrop = dropAt !== null && Math.abs(t - dropAt) < beatSec * 0.6;
    const first = shots.length === 0;

    if (lines.length && spoken < maxLines && (options.audioMode === "source" || (!first && !isDrop && energy < 0.75 && rand() < 0.35))) {
      const { s, l } = lines.shift();
      spoken++;
      shots.push({ source: s.letter, moment: null, start: l.start - 0.1, end: l.end + 0.15, beats: 1, audio: "source", speed: "normal", effects: rand() < 0.4 ? ["push"] : [], transition: "cut", text: "", focusX: 50, frame: "fill", why: "strong spoken line" });
      t += Math.ceil((l.end - l.start + 0.25) / beatSec) * beatSec;
      continue;
    }

    const picked = take(energy > 0.7 || isDrop);
    if (!picked) break;
    const { m, s } = picked;
    const beats = isDrop ? 2 : first ? (hype ? 2 : 4) : energy > 0.75 ? (rand() < 0.65 ? 1 : 2) : energy > 0.45 ? 2 : rand() < 0.5 ? 2 : 4;
    const slot = beats * beatSec;

    let transition = first ? "cut" : weighted(transitions, rand);
    // Same flashy transition twice in a row reads as a template.
    if (transition !== "cut" && transition === lastFlashy) transition = weighted(transitions.filter((x) => x.type !== lastFlashy), rand) || "cut";
    if (transition !== "cut" && sinceFlashy < 3) transition = "cut";
    if (isDrop) transition = hype ? "flash" : "dissolve";
    if (dropAt !== null && t < dropAt && t + slot >= dropAt - 0.01 && !isDrop) transition = shots.length ? transition : "cut";
    sinceFlashy = transition === "cut" ? sinceFlashy + 1 : 0;
    if (transition !== "cut") lastFlashy = transition;

    const fx = [];
    if (isDrop) fx.push("punch", "shake");
    else if (rand() < (hype ? 0.55 : 0.35)) fx.push(weighted(effects, rand));
    if (!isDrop && fx.length && rand() < 0.2) fx.push(weighted(effects, rand));

    let speed = "normal";
    if (m.motion > 0.35 && slot >= beatSec * 2 && rand() < (recipe?.speeds?.length ? 0.35 : 0.22)) {
      speed = recipe?.speeds?.length ? weighted(recipe.speeds, rand) : weighted([{ type: "ramp", weight: 3 }, { type: "slow", weight: s.fps >= 50 ? 2 : 0.5 }, { type: "stutter", weight: hype ? 1 : 0 }], rand);
    }

    shots.push({
      source: s.letter,
      moment: m.id,
      start: m.start + Math.min(0.3, (m.end - m.start) * 0.1),
      end: m.end,
      beats,
      audio: "music",
      speed,
      effects: [...new Set(fx)],
      transition,
      text: "",
      focusX: 50,
      frame: "fill",
      why: isDrop ? "drop hit" : first ? "hook" : `score ${m.score}`,
    });
    t += slot;
  }

  const look = options.look !== "auto" ? options.look : recipe?.look || (hype ? "teal-orange" : "moody-film");
  return {
    mode: "demo",
    concept: `Heuristic cut: best-scoring moments from ${sources.length} source${sources.length > 1 ? "s" : ""}, ${hype ? "fast" : "relaxed"} pacing${music ? ` on ${music.bpm} BPM` : ""}. Add an ANTHROPIC_API_KEY for a Claude-directed edit that actually watches the footage.`,
    title: options.title || "",
    look,
    lookIntensity: recipe?.lookIntensity ?? 0.85,
    textStyle: options.textStyle !== "auto" ? options.textStyle : recipe?.text?.style && TEXT_STYLES[recipe.text.style] ? recipe.text.style : "slam",
    accent: recipe?.accent || ACCENTS[Math.floor(rand() * 4)],
    musicStart,
    shots,
  };
}

/**
 * @param sources  analyzed sources: [{ letter, name, workDir, duration, width, height, fps, hasAudio, orientation, moments, sheets, cuts, speech? }]
 * @param music    music analysis + name, or null
 * @param starts   musicStarts() suggestions
 * @param options  normalized edit options
 * @param style    styleGuidance() prompt block
 * @param recipe   merged recipe of the selected style ideas (heuristic mode)
 */
export async function directEdit({ sources, music, starts, options, style, recipe, seed }) {
  if (!hasClaudeKey()) return heuristicPlan({ sources, music, starts, options, recipe, seed });
  try {
    return await claudePlan({ sources, music, starts, options, style });
  } catch (err) {
    // Still make the edit: a heuristic cut beats an error card.
    console.error("[director] Claude failed, using the heuristic director:", err.message);
    const plan = heuristicPlan({ sources, music, starts, options, recipe, seed });
    return { ...plan, concept: plan.concept.replace(/ Add an ANTHROPIC_API_KEY.*$/, ""), notice: `${claudeProblem(err)}, so the heuristic director cut this one. Re-roll once that's fixed for a Claude cut.` };
  }
}
