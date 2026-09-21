// The edit plan contract ("edit-plan/1", documented in shared/EDIT_PLAN.md). It's the internal plan from
// timeline.buildPlan() with every field unchanged, plus resolved additions (motion samples, effect cues, grade
// params, text styles, audio automation, paths) so a renderer never has to re-decide anything.
// HBA Clips renders it with HyperFrames; render.js renders the same plan with ffmpeg. The motion and effect
// math here mirrors render.js; keep the two in step. Within edit-plan/1, changes are additive only.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOOKS, TEXT_STYLES, TRANSITIONS, cssFilter, gradeChain, gradeParams } from "./looks.js";
import { sourceSpan } from "./render.js";

export const PLAN_VERSION = "edit-plan/1";
export const SFX_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "sfx");

const FPS = 30;
const r3 = (n) => Math.round(n * 1000) / 1000;
const r4 = (n) => Math.round(n * 10000) / 10000;
const hex = (h) => `#${String(h).replace(/^#/, "").toUpperCase()}`;

const MOTION = new Set(["push", "pull", "punch", "beat-zoom", "shake", "rumble"]);

/**
 * Zoom/shake as samples [t, scale, x, y]: t = seconds from the shot's timeline start, scale about the frame
 * center, x/y = translation in canvas pixels applied after scaling. Collinear samples are dropped, so
 * renderers interpolate linearly between the ones kept.
 */
function motionSamples(shot, width) {
  const fx = new Set(shot.effects);
  if (![...fx].some((e) => MOTION.has(e))) return null;
  const frames = Math.round(shot.length * FPS);
  const hit = Math.round(shot.pre * FPS);
  const px = width / 1080;
  const beatFrames = fx.has("beat-zoom") ? shot.beats.slice(0, 16).map((b) => Math.round(b * FPS)) : [];
  const punch = (n, at, amp) => (n < at ? 0 : amp * (n - at < 3 ? (n - at) / 3 : Math.exp(-(n - at - 3) / 7)));

  const raw = [];
  for (let n = 0; n <= frames; n++) {
    let z = 0;
    let dx = 0;
    let dy = 0;
    if (fx.has("push")) z += (0.085 * n) / frames;
    if (fx.has("pull")) z += 0.085 * (1 - n / frames);
    if (fx.has("punch")) z += punch(n, hit, 0.075);
    for (const b of beatFrames) z += punch(n, b, 0.045);
    if (fx.has("shake")) {
      z += 0.03;
      if (n >= hit) {
        dx += 24 * px * Math.exp(-(n - hit) / 6) * Math.sin((n - hit) * 2.3);
        dy += 18 * px * Math.exp(-(n - hit) / 6) * Math.cos((n - hit) * 2.9);
      }
    }
    if (fx.has("rumble")) {
      z += 0.025;
      dx += 7 * px * Math.sin(n * 1.31) + 4 * px * Math.sin(n * 2.77);
      dy += 6 * px * Math.sin(n * 1.73 + 1) + 3 * px * Math.sin(n * 3.1);
    }
    // render.js crops a fraction z off each side and shifts the crop window by (dx, dy) source pixels.
    const scale = 1 / (1 - 2 * z);
    raw.push([r4(n / FPS), r4(scale), r3(-dx * scale), r3(-dy * scale)]);
  }
  const kept = [raw[0]];
  for (let i = 1; i < raw.length - 1; i++) {
    const [a, b, c] = [kept.at(-1), raw[i], raw[i + 1]];
    const f = (b[0] - a[0]) / (c[0] - a[0]);
    if ([1, 2, 3].some((k) => Math.abs(a[k] + (c[k] - a[k]) * f - b[k]) > (k === 1 ? 0.0005 : 0.25))) kept.push(b);
  }
  if (raw.length > 1) kept.push(raw.at(-1));
  return kept;
}

/** Non-motion effects as timeline cues with the exact parameters render.js uses. */
function effectCues(shot, index) {
  const fx = new Set(shot.effects);
  const t0 = r3(shot.slotStart - shot.pre);
  const L = shot.length;
  const p = shot.pre;
  const cues = [];
  const cue = (type, start, duration, params = {}) => cues.push({ shot: index, type, start: r3(start), duration: r3(duration), params });
  const split = { redShiftPx: [-16, 5], blueShiftPx: [16, -5] };
  const axis = (type) => (/up|down/.test(type) ? "y" : "x");

  if (fx.has("mono")) cue("mono", t0, L, { saturation: 0 });
  if (fx.has("echo")) cue("echo", t0, L, { frames: 4, weights: [1, 0.75, 0.5, 0.3] });
  if (fx.has("blur-in")) cue("blur-in", t0, p + 0.2, { steps: [{ untilLocal: r3(p + 0.1), blurSigmaPx: 22 }, { untilLocal: r3(p + 0.2), blurSigmaPx: 8 }] });
  if (fx.has("rgb")) cue("rgb-split", t0 + p, 0.17, split);
  if (shot.edgeIn === "rgb") cue("rgb-split", t0, p + 0.05, { ...split, reason: "glitch transition in" });
  if (shot.edgeOut === "rgb") cue("rgb-split", t0 + L - shot.post - 0.05, shot.post + 0.05, { ...split, reason: "glitch transition out" });
  if (shot.edgeIn === "blur") cue("motion-blur", t0, p, { axis: axis(shot.transition.type), blurSigmaPx: 34, reason: "whip transition in" });
  if (shot.edgeOut === "blur") cue("motion-blur", t0 + L - shot.post, shot.post, { axis: axis(shot.nextTransition), blurSigmaPx: 34, reason: "whip transition out" });
  if (fx.has("flash")) {
    cue("flash", t0 + p, 0.067, { brightnessAdd: 0.38 });
    cue("flash", t0 + p + 0.067, 0.067, { brightnessAdd: 0.16 });
  }
  if (fx.has("strobe")) for (const b of shot.beats) cue("strobe", t0 + b, 0.05, { brightnessAdd: 0.24 });
  if (fx.has("invert")) cue("invert", t0 + p, 0.067);
  if (fx.has("letterbox")) cue("letterbox", t0, L, { barHeight: 0.11, color: "#000000" });
  return cues;
}

const ANIMATIONS = {
  slam: "scale 1.65→1.00 and opacity 0→1 over 90 ms, 1.00→1.04 by 160 ms, back to 1.00 by 240 ms; fade out over the last min(160 ms, 20%)",
  rise: "fade in 110 ms while moving up 46 px (at 1080 wide) over 200 ms; fade out over the last min(160 ms, 20%)",
  fade: "fade in 220 ms; fade out over the last max(200 ms, 20%)",
  flicker: "opacity 0→1 (0–50 ms), →0.44 (100 ms), →1 (150 ms), →0.62 (200 ms), →1 (260 ms); fade out over the last min(160 ms, 20%)",
};

function resolvedTextStyle(id, { width, accent }) {
  const s = TEXT_STYLES[id] || TEXT_STYLES.slam;
  const scale = width / 1080;
  return {
    id,
    font: s.font,
    weight: s.bold ? 700 : 400,
    sizePx: Math.round(s.size * scale),
    color: hex(s.color),
    outlinePx: Math.round(s.outline * scale),
    outlineColor: s.outlineColor === "accent" ? hex(accent) : hex(s.outlineColor),
    shadowPx: Math.round(s.shadow * scale),
    letterSpacingPx: s.spacing,
    uppercase: s.upper,
    glow: Boolean(s.glow),
    box: Boolean(s.box),
    animation: s.anim,
    animationTiming: ANIMATIONS[s.anim],
    maxWidthPx: Math.round(width * 0.86),
    shrink: "0.9× for two lines, 0.78× for three or more",
  };
}

/** Music gain automation: full level, ducked under dialogue with a quick attack and a slower release. */
function musicVolume(plan) {
  const base = plan.music.gain;
  const duck = r3(base * 0.22);
  const fade = r3(Math.min(1.6, plan.length * 0.12));
  const windows = plan.shots.filter((s) => s.useAudio).map((s) => [s.slotStart - s.pre, s.slotStart - s.pre + s.length]);
  const merged = [];
  for (const w of windows.sort((a, b) => a[0] - b[0])) {
    if (merged.length && w[0] <= merged.at(-1)[1] + 0.5) merged.at(-1)[1] = Math.max(merged.at(-1)[1], w[1]);
    else merged.push([...w]);
  }
  const points = [[0, 0], [0.03, base]];
  for (const [a, b] of merged) points.push([r3(Math.max(0.04, a - 0.01)), base], [r3(a + 0.05), duck], [r3(b), duck], [r3(b + 0.45), base]);
  points.push([r3(plan.length - fade), base], [r3(plan.length), 0]);
  return { points: points.filter((pt, i) => i === 0 || pt[0] > points[i - 1][0]).map(([t, gain]) => ({ t, gain })), duckGain: duck, fadeOutSec: fade };
}

/**
 * @param plan      internal plan from timeline.buildPlan() (kept intact in the result)
 * @param edit      the edit record (id, name, sources, music)
 * @param raw       director output (concept, mode, notice)
 * @param analyzed  analyzed sources [{ letter, file, duration, width, height, fps, hasAudio }]
 */
export function toEditPlan(plan, { edit, raw, analyzed, planVersion }) {
  const { width, height } = plan;
  const grade = gradeParams(plan.look, plan.lookIntensity);
  const bySource = Object.fromEntries(analyzed.map((a) => [a.letter, a]));
  const projectOf = (letter) => edit.sources.find((x) => x.letter === letter)?.projectId || null;

  const shots = plan.shots.map((s, i) => {
    const t0 = r3(s.slotStart - s.pre);
    let cursor = t0;
    return {
      ...s,
      file: path.resolve(s.file),
      projectId: projectOf(s.source),
      timeline: { start: t0, duration: s.length },
      sourceWindow: { in: s.in, out: r3(s.in + sourceSpan(s.parts)) },
      speedSegments: s.parts.map((part) => {
        const seg = { timelineStart: r3(cursor), duration: r3(part.out), sourceStart: r3(s.in + part.src), rate: part.speed, reverse: Boolean(part.reverse), freeze: Boolean(part.freeze) };
        cursor += part.out;
        return seg;
      }),
      reframe: s.frame === "fit"
        ? { mode: "fit", backdrop: { blurPx: 40, brightnessAdd: -0.1, saturation: 1.25 } }
        : { mode: "fill", focusX: r3(s.focusX / 100), focusY: 0.42 },
      motion: motionSamples(s, width),
      transitionIn: i === 0 ? null : { type: s.transition.type, duration: s.transition.duration, start: r3(s.slotStart - s.transition.duration / 2), sfx: TRANSITIONS[s.transition.type].sfx },
      audio: s.useAudio ? { gain: 1, fadeInSec: 0.03, fadeOutSec: 0.08 } : null,
    };
  });

  const textStyle = resolvedTextStyle(plan.textStyle, { width, accent: plan.accent });
  return {
    ...plan,
    contract: PLAN_VERSION,
    editId: edit.id,
    name: edit.name,
    planVersion,
    createdAt: new Date().toISOString(),
    director: { mode: raw.mode, concept: raw.concept || "", notice: raw.notice || null },
    canvas: { width, height, fps: plan.fps, duration: plan.length, background: "#000000" },
    sources: Object.fromEntries(
      edit.sources.map((s) => {
        const a = bySource[s.letter] || {};
        return [s.letter, { name: s.name, projectId: s.projectId || null, file: a.file ? path.resolve(a.file) : null, duration: a.duration, width: a.width, height: a.height, fps: a.fps, hasAudio: a.hasAudio }];
      }),
    ),
    grade: {
      look: plan.look,
      label: LOOKS[plan.look]?.label || plan.look,
      intensity: plan.lookIntensity,
      params: grade,
      cssFilter: cssFilter(grade),
      overlays: { vignette: grade.vignette, grain: grade.grain, fade: grade.fade, splitTone: { shadows: grade.shadows, highlights: grade.highlights, warmth: grade.warmth, tint: grade.tint } },
      ffmpeg: gradeChain(plan.look, plan.lookIntensity),
    },
    shots,
    transitions: shots.slice(1).map((s) => ({ from: s.index - 1, to: s.index, ...s.transitionIn })),
    effectCues: plan.shots.flatMap((s, i) => effectCues(s, i)),
    texts: plan.texts.map((t) => ({ ...t, xPx: Math.round(width / 2), yPx: Math.round(height * t.y), style: textStyle })),
    textStyleResolved: textStyle,
    captionStyle: {
      font: "Avenir Next Condensed Heavy", weight: 400, sizePx: Math.round((88 * width) / 1080), color: "#FFFFFF", activeColor: hex(plan.accent),
      outlinePx: Math.round((6 * width) / 1080), outlineColor: "#000000", shadowPx: Math.round((3 * width) / 1080), uppercase: true,
      xPx: Math.round(width / 2), yPx: Math.round(height * 0.74), firstWordPop: "scale 0.88→1 over 80 ms",
    },
    audio: {
      music: plan.music ? { trackId: edit.music?.trackId || null, name: edit.music?.name || null, file: path.resolve(plan.music.file), sourceStart: plan.music.start, bpm: plan.music.bpm, volume: musicVolume(plan) } : null,
      dialogue: shots.filter((s) => s.useAudio).map((s) => ({ shot: s.index, file: s.file, sourceStart: s.in, timelineStart: s.timeline.start, duration: s.length, gain: 1, fadeInSec: 0.03, fadeOutSec: 0.08 })),
      sfx: plan.sfx.map((c) => ({ ...c, file: path.join(SFX_DIR, `${c.name}.mp3`), url: `sfx/${c.name}.mp3`, sourceStart: c.offset || 0, fadeOutSec: 0.15 })),
      master: { loudnessLufs: -14, truePeakDb: -1.5 },
    },
  };
}
