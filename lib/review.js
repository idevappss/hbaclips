// The review a clip has to pass before the creator sees it. Four looks, cheapest first:
//   1. preflight — the cut list itself: a cut through a word, slivers, the wrong length.
//   2. audit     — the rendered file, measured: sound running through a join (a click), music too close to the voice.
//   3. sense     — Claude reads exactly what the viewer hears, with every cut marked: does it make sense on its own?
//   4. picture   — Claude looks at frames either side of every cut and across the clip.
// The findings are scored, and the ones with a known fix become repairs (leave a stretch uncut, soften the joins,
// lower the music) that the render loop applies before trying again. Reimplemented from ideas in ClipTalk's review
// loop (its code is non-commercial; nothing is copied).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { FFMPEG, run } from "./tools.js";

const MODEL = "claude-opus-5";
const r1 = (n) => Math.round(n * 10) / 10;
const r3 = (n) => Math.round(n * 1000) / 1000;
const hasKey = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

/** Where the finished clip joins two pieces: [{ index, t (output s), from: {end}, to: {start} }] in source seconds. */
export function joinsOf(plan) {
  return plan.parts.slice(1).map((p, k) => ({ index: k + 1, t: p.t, prevEnd: plan.parts[k].end, nextStart: p.start }));
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Preflight: the cut list

export function preflight(plan, words) {
  const issues = [];
  const say = (severity, kind, note, extra = {}) => issues.push({ severity, kind, note, source: "preflight", ...extra });
  for (const [i, p] of plan.parts.entries()) {
    for (const [edge, t] of [["start", p.start], ["end", p.end]]) {
      const through = words.find((w) => w.start < t - 0.04 && w.end > t + 0.04);
      if (through) say("major", "cut_through_word", `Piece ${i + 1} ${edge}s in the middle of "${through.text}".`, { cut: edge === "start" ? i : i + 1, at: r1(edge === "start" ? p.t : p.t + p.dur) });
    }
    if (p.dur < 0.25) say("major", "sliver", `Piece ${i + 1} is only ${p.dur.toFixed(2)}s long.`, { cut: i, at: r1(p.t) });
  }
  if (plan.duration < 12) say("major", "too_short", `The clip runs ${r1(plan.duration)}s.`);
  if (plan.duration > 60) say("critical", "too_long", `The clip runs ${r1(plan.duration)}s, over a minute.`);
  if (plan.hook) {
    const body = plan.parts.slice(1);
    const overlap = body.reduce((sum, p) => sum + Math.max(0, Math.min(p.end, plan.hook.end) - Math.max(p.start, plan.hook.start)), 0);
    if (overlap >= (plan.hook.end - plan.hook.start) * 0.8) say("major", "hook_repeated", "The opening hook is said again inside the clip.");
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Audit: the rendered file

function decodeAudio(file, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"]);
    const chunks = [];
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code !== 0) return reject(new Error(`couldn't read the render's sound (${code})`));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
}

const rmsDb = (pcm, from, to) => {
  const a = Math.max(0, Math.floor(from * 16000));
  const b = Math.min(pcm.length, Math.ceil(to * 16000));
  if (b <= a) return -120;
  let s = 0;
  for (let i = a; i < b; i++) s += pcm[i] * pcm[i];
  return 10 * Math.log10(s / (b - a) + 1e-12);
};

async function loudness(files, signal) {
  const inputs = files.flatMap((f) => ["-i", f]);
  const graph = files.length > 1 ? `${files.map((_, i) => `[${i}:a]`).join("")}concat=n=${files.length}:v=0:a=1,ebur128` : "ebur128";
  const lines = [];
  await run(FFMPEG, ["-hide_banner", "-nostats", ...inputs, "-filter_complex", graph, "-f", "null", "-"], { signal, onLine: (l) => lines.push(l) });
  const integrated = lines.map((l) => l.match(/^\s*I:\s*(-?[\d.]+) LUFS/)).filter(Boolean).at(-1);
  const shortTerm = lines.map((l) => l.match(/\bt:\s*([\d.]+).*?\bS:\s*(-?[\d.]+)/)).filter((m) => m && Number(m[1]) > 3 && Number(m[2]) > -70).map((m) => Number(m[2]));
  return { integrated: integrated ? Number(integrated[1]) : null, swing: shortTerm.length ? Math.max(...shortTerm) - Math.min(...shortTerm) : 0 };
}

export async function auditRender({ file, plan, compositionDir, signal }) {
  const issues = [];
  const pcm = await decodeAudio(file, signal);
  // Sound at every join: a clean cut sits in a quiet gap; a loud join or a sudden sample jump is a click.
  for (const j of joinsOf(plan)) {
    const at = rmsDb(pcm, j.t - 0.012, j.t + 0.012);
    const i0 = Math.max(1, Math.floor((j.t - 0.004) * 16000));
    const i1 = Math.min(pcm.length - 1, Math.ceil((j.t + 0.004) * 16000));
    let jump = 0;
    for (let i = i0; i <= i1; i++) jump = Math.max(jump, Math.abs(pcm[i] - pcm[i - 1]));
    if (at > -24 || jump > 0.35) {
      issues.push({ severity: "major", kind: "audio_join", source: "audit", cut: j.index, at: r1(j.t), note: `Sound runs through the cut at ${r1(j.t)}s (${Math.round(at)} dB at the join).` });
    }
  }
  // Music against voice, measured from the stems the render was built from.
  try {
    const assets = path.join(compositionDir, "assets");
    const names = await fs.readdir(assets);
    const parts = names.filter((n) => /^part-\d+\.mp4$/.test(n)).sort((a, b) => Number(a.match(/\d+/)) - Number(b.match(/\d+/))).map((n) => path.join(assets, n));
    if (names.includes("bed.m4a") && parts.length) {
      const [voice, bed] = await Promise.all([loudness(parts, signal), loudness([path.join(assets, "bed.m4a")], signal)]);
      const gap = voice.integrated !== null && bed.integrated !== null ? voice.integrated - bed.integrated : null;
      if (gap !== null && gap < 15) issues.push({ severity: "major", kind: "music_loud", source: "audit", note: `Music is only ${r1(gap)} LU under the voice (should be 15+).`, gap: r1(gap) });
      if (bed.swing > 4.5) issues.push({ severity: "minor", kind: "music_uneven", source: "audit", note: `The music level moves ${r1(bed.swing)} LU across the clip.` });
    }
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Sense: Claude reads the clip

const SenseSchema = z.object({
  scores: z.object({
    hook: z.number().describe("0-10: do the first 3 seconds make the right viewer stop?"),
    clarity: z.number().describe("0-10: does it make complete sense to someone who saw nothing else?"),
    flow: z.number().describe("0-10: does every cut join cleanly, with no jump in meaning?"),
    payoff: z.number().describe("0-10: does it land a clear takeaway or solution?"),
  }),
  issues: z.array(
    z.object({
      severity: z.enum(["critical", "major", "minor"]),
      kind: z.enum(["broken_thought_at_cut", "dangling_reference", "weak_open", "incomplete_end", "no_payoff", "repetition", "health_claim_risk", "off_brand", "other"]),
      cut: z.number().describe("the ‖n‖ cut number the issue is at, or -1"),
      note: z.string().describe("one sentence the creator will read"),
    }),
  ),
  word_fixes: z
    .array(z.object({ heard: z.string().describe("the single word exactly as written in clip_words"), should_be: z.string().describe("what the speaker actually said, from context") }))
    .describe("only transcription mistakes you are sure of from context (e.g. a title or topic makes the right word obvious); never style edits"),
});

const SENSE_SYSTEM = `You are the final editor for a premium short-form brand whose audience is healthcare professionals (doctors, chiropractors, physical therapists) and lifestyle viewers. You review a finished clip's words exactly as a viewer hears them — everything cut away is gone — and decide whether it can be posted.

Be strict about what breaks a clip and relaxed about everything else:
- A cut that joins two thoughts so the meaning jumps, repeats, or no longer follows is a broken_thought_at_cut.
- "Like I said", "this one", "that" pointing at something the clip never showed is a dangling_reference.
- The clip must open on a line that grabs (a big truth, the viewer's own question, or a call-out) and end on a complete sentence that pays off.
- health_claim_risk is for health outcomes (cures, fixes pain, doses, treatment results) and for any outcome promised to the viewer as guaranteed ("I guarantee", "you will make") — critical when it reads as a guarantee. The creator teaches practice growth: their own and their clients' business results stated as results ("we did $50k/month", "clients got to six figures") are the brand's proof, not a risk. At most a minor note, never major or critical, unless the numbers contradict each other.
- On-screen graphics and title cards that were already in the recording are the creator's own; don't count them against the clip.
- The first words the viewer hears must not continue something they never heard ("and that's why", "so the second one"); that is weak_open, and critical when the clip makes no sense without it.
- When the clip is an answer, the question has to be in it (asked by the other person or restated); if the answer depends on a missing question, that is dangling_reference.
- The last sentence must complete its thought; stopping mid-idea is incomplete_end.
- Ordinary spoken style, small grammar slips and informal words are fine. Don't nitpick.
- If a word is clearly a speech-to-text mistake (it contradicts the title or the obvious topic), list it in word_fixes.
Severity: critical only when the clip should not be posted as it is; major when a viewer would notice; minor for polish.`;

export async function sensePass({ plan, clip }) {
  if (!hasKey()) return null;
  // Mark each cut before the first word spoken after it, numbered like the joins.
  const marks = new Map();
  for (const j of joinsOf(plan)) {
    const w = plan.words.findIndex((x) => x.s >= j.t - 0.03);
    if (w >= 0 && !marks.has(w)) marks.set(w, j.index);
  }
  const text = plan.words.map((w, i) => (marks.has(i) ? `‖${marks.get(i)}‖ ${w.text}` : w.text)).join(" ");
  const response = await new Anthropic().beta.messages.parse({
    model: MODEL,
    max_tokens: 6000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: betaZodOutputFormat(SenseSchema) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SENSE_SYSTEM,
    messages: [
      {
        role: "user",
        content: `On-screen title: "${clip.title || ""}"
Length: ${r1(plan.duration)}s. ‖n‖ marks where the edit cuts from one piece of the recording to the next${plan.hook ? " (‖1‖ is where the opening hook, taken from elsewhere in the video, hands over to the clip)" : ""}.

<clip_words>
${text}
</clip_words>

Score it and list its issues.`,
      },
    ],
  });
  return response.parsed_output || null;
}

// ---------------------------------------------------------------------------------------------------------------
// 4. Picture: Claude looks at frames around every cut

const PictureSchema = z.object({
  scores: z.object({
    picture: z.number().describe("0-10: framing, subject visible and centered, nothing broken"),
    continuity: z.number().describe("0-10: do the cuts look intentional rather than glitchy?"),
  }),
  issues: z.array(
    z.object({
      severity: z.enum(["critical", "major", "minor"]),
      kind: z.enum(["jarring_jump", "face_cut_off", "caption_covers_face", "text_card_or_black", "frozen_or_broken", "other"]),
      cut: z.number().describe("the cut number from the frame labels, or -1"),
      at: z.number().describe("output seconds from the frame label, or -1"),
      note: z.string(),
    }),
  ),
});

async function frameJpeg(file, t, dir) {
  const out = path.join(dir, `${crypto.randomBytes(4).toString("hex")}.jpg`);
  await run(FFMPEG, ["-v", "error", "-y", "-ss", Math.max(0, t).toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "5", out]);
  const data = (await fs.readFile(out)).toString("base64");
  await fs.rm(out, { force: true });
  return data;
}

export async function picturePass({ file, plan }) {
  if (!hasKey()) return null;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "review-"));
  try {
    const shots = [];
    const D = plan.duration;
    for (let k = 0; k < 5; k++) shots.push({ t: r1(0.4 + ((D - 0.8) * k) / 4), label: `across the clip at ${r1(0.4 + ((D - 0.8) * k) / 4)}s` });
    for (const j of joinsOf(plan).slice(0, 8)) {
      shots.push({ t: r1(Math.max(0, j.t - 0.2)), label: `cut ${j.index}, just before (${r1(j.t - 0.2)}s)` });
      shots.push({ t: r1(j.t + 0.2), label: `cut ${j.index}, just after (${r1(j.t + 0.2)}s)` });
    }
    const content = [];
    for (const s of shots) {
      content.push({ type: "text", text: s.label });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: await frameJpeg(file, s.t, tmp) } });
    }
    content.push({
      type: "text",
      text: "These are frames from a finished vertical clip for a premium healthcare/lifestyle brand, labeled by time. Check the picture: is the speaker framed well, do cuts look intentional (a cut between two different framings is normal; a glitchy flash, a frame of something unrelated, or a face cut off is not), do captions cover the face, is anything black, frozen or a leftover text card? Don't flag normal jump cuts in a talking-head edit.",
    });
    const response = await new Anthropic().beta.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: betaZodOutputFormat(PictureSchema) },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content }],
    });
    return response.parsed_output || null;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Scoring, repairs, and the whole review

// A model can only call something critical when it's one of the things that truly stops a post.
const CRITICAL_OK = new Set(["broken_thought_at_cut", "incomplete_end", "health_claim_risk", "weak_open", "text_card_or_black", "frozen_or_broken", "too_long"]);

export function scoreReview({ findings, sense, picture }) {
  const issues = findings.map((f) => (f.severity === "critical" && !CRITICAL_OK.has(f.kind) ? { ...f, severity: "major" } : f));
  const s = sense?.scores;
  const p = picture?.scores;
  const clamp10 = (n) => Math.min(10, Math.max(0, Number(n) || 0));
  const words = s ? (clamp10(s.hook) * 0.3 + clamp10(s.clarity) * 0.25 + clamp10(s.flow) * 0.25 + clamp10(s.payoff) * 0.2) * 10 : 75;
  const pic = p ? ((clamp10(p.picture) + clamp10(p.continuity)) / 2) * 10 : 75;
  const base = words * 0.8 + pic * 0.2;
  const count = (sev) => issues.filter((i) => i.severity === sev).length;
  const penalty = Math.min(15, 6 * count("critical")) + Math.min(12, 3 * count("major")) + Math.min(3, 0.5 * count("minor"));
  const score = Math.max(0, Math.round(base - penalty));
  const pass = count("critical") === 0 && score >= 60;
  return { score, pass, recommended: pass && score >= 75 && count("major") === 0, issues, scores: { ...(s || {}), ...(p || {}) } };
}

/**
 * Fixes the render loop can apply for these issues: { protect: [{start,end}], softJoins, musicLevel } — only what
 * changes something, or null when nothing more can be done automatically.
 */
export function repairsFor(report, plan, clip, design) {
  const protect = [...(clip.protect || [])];
  let softJoins = Boolean(clip.softJoins);
  let musicLevel = design.musicLevel;
  const joins = joinsOf(plan);
  for (const issue of report.issues) {
    if (["audio_join", "broken_thought_at_cut", "jarring_jump", "cut_through_word", "dangling_reference"].includes(issue.kind) && issue.cut > 0) {
      const j = joins.find((x) => x.index === issue.cut);
      if (!j) continue;
      const gap = j.nextStart - j.prevEnd;
      // A short gap in the same stretch of talk was a trimmed pause or filler: put it back. When the meaning broke
      // (a name or setup was cut away), a longer stretch comes back — up to 8 s of the talk that was removed.
      const meaning = issue.kind === "dangling_reference" || issue.kind === "broken_thought_at_cut";
      if (gap >= 0 && gap < (meaning ? 8 : 2.5)) {
        const range = { start: r3(j.prevEnd - 0.3), end: r3(j.nextStart + 0.3) };
        if (!protect.some((p) => p.start <= range.start + 0.05 && p.end >= range.end - 0.05)) protect.push(range);
      } else if (issue.kind === "audio_join") softJoins = true; // a join between different moments: soften it
    }
    if (issue.kind === "music_loud") musicLevel = Math.max(0.06, Math.round(musicLevel * 0.7 * 100) / 100);
  }
  // Misheard words the reviewer is sure about become this clip's word fixes (keyed by the word's source start).
  const wordFixes = { ...(clip.wordFixes || {}) };
  for (const fix of report.wordFixes || []) {
    const heard = String(fix.heard || "").toLowerCase().replace(/[^a-z0-9']/g, "");
    const target = String(fix.should_be || "").trim();
    if (!heard || !target || target.split(/\s+/).length > 3) continue;
    for (const w of report.clipWords || []) {
      if (String(w.text).toLowerCase().replace(/[^a-z0-9']/g, "") !== heard || w.src == null) continue;
      const trail = String(w.text).match(/[.,!?;:]+$/)?.[0] || "";
      wordFixes[String(Math.round(w.src * 1000))] = target.replace(/[.,!?;:]+$/, "") + trail;
    }
  }
  const fixesChanged = JSON.stringify(wordFixes) !== JSON.stringify(clip.wordFixes || {});
  const changed = fixesChanged || protect.length !== (clip.protect || []).length || softJoins !== Boolean(clip.softJoins) || musicLevel !== design.musicLevel;
  return changed ? { protect, softJoins, musicLevel, ...(fixesChanged ? { wordFixes } : {}) } : null;
}

/** Run every look on a finished render. Model passes that fail are skipped, never fatal. */
export async function reviewClip({ file, plan, words, clip, compositionDir, signal, onStage }) {
  onStage?.("Checking the cuts…");
  const findings = [...preflight(plan, words)];
  findings.push(...(await auditRender({ file, plan, compositionDir, signal }).catch(() => [])));
  onStage?.("Reviewing what the viewer hears…");
  const sense = await sensePass({ plan, clip }).catch((err) => (console.error("sense review skipped:", err.message), null));
  if (sense) findings.push(...sense.issues.map((i) => ({ ...i, source: "sense", cut: i.cut > 0 ? i.cut : undefined })));
  onStage?.("Reviewing the picture…");
  const picture = await picturePass({ file, plan }).catch((err) => (console.error("picture review skipped:", err.message), null));
  if (picture) findings.push(...picture.issues.map((i) => ({ ...i, source: "picture", cut: i.cut > 0 ? i.cut : undefined, at: i.at >= 0 ? i.at : undefined })));
  // Source times for the clip's words, so a word fix can be pinned to the exact word it corrects.
  const clipWords = plan.words.map((w) => {
    const part = plan.parts.find((p) => w.s >= p.t - 0.01 && w.s < p.t + p.dur);
    return { text: w.text, src: part ? r3(part.start + (w.s - part.t)) : null };
  });
  return { ...scoreReview({ findings, sense, picture }), wordFixes: sense?.word_fixes || [], clipWords, reviewedAt: new Date().toISOString(), models: { sense: Boolean(sense), picture: Boolean(picture) } };
}
