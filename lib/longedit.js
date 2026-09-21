// Full-video edits: the whole talk, tightened and finished as a YouTube video or a presentation. Claude reads the
// transcript (and any slides or PDFs that came with it) to mark retakes, rambles and dead starts, write chapters and
// the YouTube copy, and — for presentations — the key points to put on screen and which slide goes with which part.
// Filler words and long pauses come out on top of that (lib/tighten.js). The render is plain ffmpeg — cut, join,
// burn in text and slides, master the loudness — because a 20-minute video is too long for a browser renderer.
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { FFMPEG, run } from "./tools.js";
import { projectDir, saveProject } from "./store.js";
import { cutSegment, probe } from "./media.js";
import { cleanAudioFile } from "./work.js";
import { tightenClip, toTightened } from "./tighten.js";
import { formatMoney, formatMoneyText } from "./money.js";
import { correctWords } from "./corrections.js";
import { materialBlocks, slideImage } from "./materials.js";
import { masterLoudness } from "./master.js";
import { checkRender, describeQa } from "./qa.js";
import { audienceGuidance } from "./audience.js";

const MODEL = "claude-opus-5";
export const LONG_FORMATS = {
  youtube: { label: "YouTube video", hint: "The whole talk, tightened — chapters, title and description written for you" },
  presentation: { label: "Presentation", hint: "Tightened talk with key points on screen and your slides shown as you get to them" },
};

/** Fill in and validate the choices for a full-video edit. */
export function normalizeLongDesign(input = {}) {
  const format = LONG_FORMATS[input.format] ? input.format : "youtube";
  const bool = (key, fallback) => (typeof input[key] === "boolean" ? input[key] : fallback);
  return {
    format,
    // "tight" also drops rambles and tangents; "light" only retakes, false starts and dead air.
    tightness: ["light", "tight"].includes(input.tightness) ? input.tightness : "tight",
    captions: bool("captions", format === "presentation"),
    callouts: bool("callouts", format === "presentation"),
    slides: bool("slides", format === "presentation"),
    chapterCards: bool("chapterCards", true),
  };
}

const PlanSchema = z.object({
  cut_ranges: z.array(z.object({
    from_segment: z.number(),
    to_segment: z.number().describe("inclusive"),
    reason: z.string().describe("retake, false start, ramble, tangent, pre-roll chatter, repeated point…"),
  })),
  chapters: z.array(z.object({ segment: z.number().describe("segment the chapter starts on; the first chapter starts at the first kept segment"), title: z.string().describe("2–6 words") })),
  youtube_title: z.string().describe("under 70 characters, premium voice"),
  youtube_description: z.string().describe("2–4 short paragraphs, no hashtags, no emoji; chapters are added after it automatically"),
  thumbnail_text: z.string().describe("2–4 words for the thumbnail"),
  callouts: z.array(z.object({ segment: z.number(), text: z.string().describe("the key point in at most 7 words") })),
  slides: z.array(z.object({ material: z.number().describe("index of the attached picture, from 0, in the order they were attached"), from_segment: z.number(), to_segment: z.number() })),
});

const SYSTEM = `You are a senior long-form editor for a premium creator who teaches doctors, chiropractors and physical therapists how to grow their practices, expanding into lifestyle. You edit full talks for YouTube and for presentations. Your edits keep the speaker's argument whole and make it feel intentional: nothing important is lost, but nothing wastes the viewer's time.

Voice: premium and understated. No emoji, no all-caps, no clickbait, no hype words. Money is always written with $ and short units ($1, $20k, $100k/month).`;

async function planWithClaude({ project, segments, design, materials }) {
  const pictures = (project.materials || []).filter((m) => m.kind === "image");
  const transcript = segments.map((s) => `[#${s.index} | ${s.start.toFixed(1)}–${s.end.toFixed(1)}s] ${s.text}`).join("\n");
  const prompt = `Edit this full video as a ${LONG_FORMATS[design.format].label.toLowerCase()}.
${project.options?.notes ? `Creator notes: ${project.options.notes}\n` : ""}
<transcript>
${transcript}
</transcript>

Deliver:
1. cut_ranges — stretches to remove, as segment ranges. ${design.tightness === "tight" ? "Remove retakes (keep the later, complete take), false starts, pre-roll and post-roll chatter (\"is it recording?\", \"okay let's go\"), points made twice, and rambles or tangents that don't serve the talk." : "Remove only retakes (keep the later, complete take), false starts, and pre-roll or post-roll chatter. Keep rambles and tangents — this is a light edit."} Never cut a segment the next one depends on to make sense; every join must read as one continuous thought. Curse words: remove the sentence when it can go without breaking the thought. An empty list is right for a clean recording. Filler words and long pauses are removed separately — don't list them.
2. chapters — 3–12 chapters for the kept video, in order, the first on the first kept segment. Titles 2–6 words, plain and specific.
3. youtube_title, youtube_description, thumbnail_text.
4. callouts — ${design.callouts ? "the 4–15 key points worth putting on screen as short text, one every 45–120 seconds at most, on the segment where the point lands." : "return an empty list."}
5. slides — ${design.slides && pictures.length ? `the creator attached ${pictures.length} picture${pictures.length === 1 ? "" : "s"} (shown above as Picture 0 to Picture ${pictures.length - 1}). For each one that is a slide or visual for this talk, the segment range where it should be on screen while the speaker covers it (at least 6 seconds, ranges must not overlap). Skip pictures that don't match anything said.` : "return an empty list."}`;
  const client = new Anthropic();
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: betaZodOutputFormat(PlanSchema) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [SYSTEM, await audienceGuidance()].filter(Boolean).join("\n\n"),
    messages: [{ role: "user", content: materials.length ? [...materials, { type: "text", text: prompt }] : prompt }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new Error("Claude declined to edit this video.");
  if (message.stop_reason === "max_tokens" || !message.parsed_output) throw new Error("Claude's edit plan came back incomplete. Try again.");
  return message.parsed_output;
}

const r3 = (n) => Math.round(n * 1000) / 1000;

/** Source ranges minus the cuts. */
function subtract(ranges, cuts) {
  let out = ranges.map((r) => ({ ...r }));
  for (const c of cuts) {
    out = out.flatMap((r) => {
      if (c.end <= r.start || c.start >= r.end) return [r];
      return [...(c.start > r.start ? [{ start: r.start, end: c.start }] : []), ...(c.end < r.end ? [{ start: c.end, end: r.end }] : [])];
    });
  }
  return out.filter((r) => r.end - r.start >= 0.3);
}

/** A source time on the edited timeline; a time that was cut lands where the video picks up again. */
function mapTime(parts, t) {
  const exact = toTightened(parts, t);
  if (exact !== null) return exact;
  let clock = 0;
  for (const p of parts) {
    if (p.start >= t) return r3(clock);
    clock += p.end - p.start;
  }
  return r3(clock);
}

const stamp = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Plan the full-video edit and store it on project.long. Needs the transcript; the render is queued separately.
 */
export async function planLongEdit(project, designInput, { signal } = {}) {
  const design = normalizeLongDesign(designInput);
  const long = (project.long = { id: "long", design, status: "planning", message: "Reading the whole talk…", render: project.long?.render || null });
  await saveProject(project);
  try {
    const dir = projectDir(project.id);
    const words = correctWords(JSON.parse(await fs.readFile(path.join(dir, "words.json"), "utf8")));
    const segments = (project.segments || []).map((s, index) => ({ ...s, index: s.index ?? index }));
    if (!words.length || !segments.length) throw new Error("This video has no speech to edit.");
    const pictures = (project.materials || []).filter((m) => m.kind === "image");
    const materials = design.slides || pictures.length || (project.materials || []).length ? await materialBlocks(project) : [];
    const plan = await planWithClaude({ project, segments, design, materials });
    signal?.throwIfAborted();

    const last = segments.length - 1;
    const seg = (i) => segments[Math.min(last, Math.max(0, Math.round(Number(i) || 0)))];
    long.message = "Tightening the cut…";
    await saveProject(project);

    // Speech from the first word to the last, minus Claude's cuts, then filler and long pauses out.
    const whole = [{ start: Math.max(0, words[0].start - 0.3), end: Math.min(project.source.duration, words.at(-1).end + 0.7) }];
    const cuts = plan.cut_ranges
      .map((c) => {
        const [a, b] = [seg(c.from_segment), seg(c.to_segment)].sort((x, y) => x.start - y.start);
        return { start: r3(a.start - 0.05), end: r3(b.end + 0.05), reason: c.reason };
      })
      .sort((a, b) => a.start - b.start);
    const ranges = subtract(whole, cuts);
    const tight = tightenClip(words, ranges, { pauseMax: 0.9, pauseKeep: 0.5, filler: true, minPiece: 2.5, absorbMax: 1.4, keepOut: cuts });
    const parts = tight.parts.map((p) => ({ start: r3(p.start), end: r3(p.end) }));
    const duration = r3(parts.reduce((s, p) => s + p.end - p.start, 0));

    const chapters = [];
    for (const c of plan.chapters) {
      const t = chapters.length ? mapTime(parts, seg(c.segment).start) : 0;
      if (chapters.length && t - chapters.at(-1).t < 20) continue; // YouTube wants chapters at least 10s apart
      chapters.push({ t: r3(t), title: formatMoneyText(c.title.trim()) });
    }
    const callouts = design.callouts
      ? plan.callouts
          .map((c) => ({ t: r3(mapTime(parts, seg(c.segment).start) + 0.6), d: 4.5, text: formatMoneyText(c.text.trim()) }))
          .filter((c, i, all) => c.t < duration - 2 && (!i || c.t - all[i - 1].t > 12))
      : [];
    const slides = design.slides
      ? plan.slides
          .map((s) => {
            const m = pictures[Math.round(s.material)];
            if (!m) return null;
            const from = mapTime(parts, seg(s.from_segment).start);
            const to = mapTime(parts, seg(s.to_segment).end);
            return to - from >= 4 ? { file: m.file, name: m.name, t: r3(from), d: r3(to - from) } : null;
          })
          .filter(Boolean)
          .sort((a, b) => a.t - b.t)
          .filter((s, i, all) => !i || s.t >= all[i - 1].t + all[i - 1].d)
      : [];
    const description = `${plan.youtube_description.trim()}\n\n${chapters.map((c) => `${stamp(c.t)} ${c.title}`).join("\n")}`;

    Object.assign(long, {
      status: "ready",
      message: `Cut ${stamp(project.source.duration - duration)} — ${stamp(project.source.duration)} down to ${stamp(duration)}`,
      plannedAt: new Date().toISOString(),
      plan: {
        parts,
        words: formatMoney(tight.words),
        duration,
        cuts: cuts.map((c) => ({ ...c, at: stamp(c.start) })),
        removed: { ...tight.removed, rambles: r3(cuts.reduce((s, c) => s + c.end - c.start, 0)) },
        chapters,
        callouts,
        slides,
        youtube: { title: formatMoneyText(plan.youtube_title.trim()), description, thumbnail: formatMoneyText(plan.thumbnail_text.trim()) },
      },
    });
  } catch (err) {
    Object.assign(long, { status: "error", message: err.name === "AbortError" ? "Stopped" : err.message });
  }
  await saveProject(project);
  return long;
}

// ---------------------------------------------------------------------------
// Rendering

const assTime = (sec) => {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
const assText = (s) => String(s).replace(/\\/g, "").replace(/[{}]/g, "").replace(/\n/g, " ");

/** Caption lines from the re-timed words: up to 7 words, broken at sentence ends and pauses. */
function captionLines(words) {
  const lines = [];
  let cur = [];
  const flush = () => {
    if (cur.length) lines.push({ s: cur[0].s, e: cur.at(-1).e, text: cur.map((w) => w.text).join(" ") });
    cur = [];
  };
  for (const w of words) {
    if (cur.length && (w.s - cur.at(-1).e > 0.6 || cur.length >= 7)) flush();
    cur.push(w);
    if (/[.!?]$/.test(w.text)) flush();
  }
  flush();
  return lines.map((l, i) => ({ ...l, e: Math.min(lines[i + 1]?.s ?? l.e + 0.4, l.e + 0.4) }));
}

/** The burned-in text as an ASS script sized for a W×H frame. */
export function buildAss(plan, design, W, H) {
  const u = H / 1080;
  const px = (n) => Math.round(n * u);
  const font = "Helvetica Neue";
  const styles = [
    // name, size, primary, back, bold, borderStyle, outline, shadow, alignment, marginL, marginR, marginV
    // Captions keep a thin dark edge so they stay readable over white slides and bright backgrounds.
    ["Caption", px(46), "&H00FFFFFF", "&H99000000", 1, 1, px(2.2), px(1.5), 2, px(220), px(220), px(60)],
    ["Callout", px(44), "&H00FFFFFF", "&H33101012", 1, 3, px(18), 0, 1, px(96), px(96), px(210)],
    ["Chapter", px(30), "&H00FFFFFF", "&H33101012", 1, 3, px(12), 0, 7, px(72), px(72), px(60)],
  ];
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles.map(([name, size, primary, back, bold, border, outline, shadow, align, ml, mr, mv]) => `Style: ${name},${font},${size},${primary},${primary},${border === 3 ? back : "&H70000000"},${back},${bold},0,0,0,100,100,0,0,${border},${outline},${shadow},${align},${ml},${mr},${mv},1`),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const event = (layer, s, e, style, text) => lines.push(`Dialogue: ${layer},${assTime(s)},${assTime(e)},${style},,0,0,0,,${text}`);
  if (design.captions) for (const l of captionLines(plan.words)) event(0, l.s, l.e, "Caption", assText(l.text));
  for (const c of plan.callouts) event(1, c.t, Math.min(plan.duration, c.t + c.d), "Callout", `{\\fad(250,300)}${assText(c.text)}`);
  if (design.chapterCards) {
    plan.chapters.forEach((c, i) => i && event(2, c.t + 0.3, Math.min(plan.duration, c.t + 4), "Chapter", `{\\fad(250,300)}${String(i + 1).padStart(2, "0")}  ·  ${assText(c.title)}`));
  }
  return lines.join("\n");
}

/**
 * Render project.long's plan into renders/long-<format>.mp4. `setRender` receives progress; `signal` stops it.
 */
export async function renderLongEdit(project, { signal, setRender }) {
  const long = project.long;
  const { plan, design } = long;
  const dir = projectDir(project.id);
  const work = path.join(dir, "compositions", "long", `job-${Date.now().toString(36)}`);
  await fs.mkdir(path.join(work, "parts"), { recursive: true });
  const started = Date.now();
  try {
    // 1. Every kept stretch, cut frame-accurately from the original with the cleaned dialogue.
    const src = path.join(dir, project.source.file);
    const audioSrc = project.source.hasAudio ? cleanAudioFile(project) : null;
    const list = [];
    for (const [i, p] of plan.parts.entries()) {
      signal.throwIfAborted();
      const file = path.join(work, "parts", `p${String(i).padStart(4, "0")}.mp4`);
      await cutSegment(src, file, p.start, p.end, { signal, audioSrc, fadeEdges: true, fadeSec: 0.025, hdr: project.source.hdr });
      list.push(`file '${file.replace(/'/g, "'\\''")}'`);
      if (i % 3 === 0 || i === plan.parts.length - 1) await setRender({ progress: Math.round((70 * (i + 1)) / plan.parts.length), message: `Cutting ${i + 1} of ${plan.parts.length} pieces…` });
    }
    await fs.writeFile(path.join(work, "parts.txt"), list.join("\n"));
    const joined = path.join(work, "joined.mp4");
    await run(FFMPEG, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(work, "parts.txt"), "-c", "copy", "-movflags", "+faststart", joined], { signal });

    // 2. Text and slides on top, when there are any.
    const hasText = design.captions || plan.callouts.length || (design.chapterCards && plan.chapters.length > 1);
    let out = joined;
    if (hasText || plan.slides.length) {
      await setRender({ progress: 72, message: plan.slides.length ? "Adding your slides and key points…" : "Adding the text…" });
      const info = await probe(joined);
      // Slides need a steady 16:9 canvas; otherwise the video keeps its own size.
      const [W, H] = plan.slides.length ? [1920, 1080] : [info.width, info.height];
      const assFile = path.join(work, "text.ass");
      await fs.writeFile(assFile, buildAss(plan, design, W, H));
      const inputs = ["-i", joined];
      const chain = [];
      let base = "[0:v]";
      if (plan.slides.length) {
        const between = (s) => `between(t,${s.t.toFixed(2)},${(s.t + s.d).toFixed(2)})`;
        const anySlide = plan.slides.map(between).join("+");
        chain.push(`[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0b0b0c,setsar=1,split=2[cam][pipsrc]`);
        chain.push(`[pipsrc]scale=${Math.round(W * 0.24)}:-2[pip]`);
        base = "[cam]";
        const images = await Promise.all(plan.slides.map((sl) => slideImage(project.id, sl.file)));
        plan.slides.forEach((s, i) => {
          inputs.push("-loop", "1", "-t", String(Math.ceil(plan.duration + 1)), "-i", images[i]);
          chain.push(`[${i + 1}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0b0b0c,setsar=1,format=yuv420p[sl${i}]`);
          chain.push(`${base}[sl${i}]overlay=0:0:enable='${between(s)}'[b${i}]`);
          base = `[b${i}]`;
        });
        // The speaker stays on screen in the corner while a slide is up.
        chain.push(`${base}[pip]overlay=W-w-${Math.round(W * 0.03)}:H-h-${Math.round(H * 0.05)}:enable='${anySlide}'[withpip]`);
        base = "[withpip]";
      }
      const escaped = assFile.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
      chain.push(`${base}ass='${escaped}':fontsdir=/System/Library/Fonts[v]`);
      out = path.join(work, "final.mp4");
      const total = plan.duration;
      await run(
        FFMPEG,
        ["-y", "-loglevel", "error", "-progress", "pipe:1", "-nostats", ...inputs, "-filter_complex", chain.join(";"), "-map", "[v]", "-map", "0:a?", "-t", total.toFixed(3), "-c:v", "h264_videotoolbox", "-b:v", "12M", "-allow_sw", "1", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", out],
        {
          signal,
          onLine: (line) => {
            const m = /out_time_us=(\d+)/.exec(line);
            if (m) setRender({ progress: Math.min(94, 72 + Math.round((22 * Number(m[1])) / 1e6 / total)), message: "Adding the text…" });
          },
        },
      );
    }

    // 3. Loudness to -14 LUFS, then a look at the file before calling it done.
    await setRender({ progress: 95, message: "Mastering the sound…" });
    await masterLoudness(out, { signal }).catch((err) => {
      if (signal.aborted) throw err;
      console.error(`[${project.id}/long] loudness master`, err.message);
    });
    const qa = await checkRender(out, { expect: plan.duration, signal }).catch(() => null);
    // A talk holds on a slide or a title graphic for a few seconds all the time; only a long freeze is a problem.
    if (qa) {
      qa.problems = qa.problems.filter((p) => !(/frozen/.test(p.text) && Number.parseFloat(p.text) <= 5));
      qa.ok = !qa.problems.some((p) => p.level === "error");
    }
    await fs.mkdir(path.join(dir, "renders"), { recursive: true });
    const name = `long-${design.format}.mp4`;
    await fs.rename(out, path.join(dir, "renders", name));
    return { file: `renders/${name}`, duration: qa?.duration ?? plan.duration, qa: qa ? { ok: qa.ok, problems: qa.problems } : null, message: describeQa(qa) || `Rendered in ${Math.round((Date.now() - started) / 1000)}s` };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
