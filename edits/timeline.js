// Fits a director's shot list onto the music's beat grid and turns it into an exact, frame-quantized
// render plan: slot times, transition overlaps, source windows, speed parts, text, captions and SFX cues.
import { beatGrid } from "./beats.js";
import { EFFECTS, LOOKS, SPEEDS, TEXT_STYLES, TRANSITIONS } from "./looks.js";
import { FPS, sourceSpan, speedParts } from "./render.js";

export const ASPECTS = {
  "9:16": { width: 1080, height: 1920, label: "9:16 · Reels / TikTok / Shorts" },
  "4:5": { width: 1080, height: 1350, label: "4:5 · Instagram feed" },
  "1:1": { width: 1080, height: 1080, label: "1:1 · Square" },
  "16:9": { width: 1920, height: 1080, label: "16:9 · YouTube" },
};

const q = (t) => Math.round(t * FPS) / FPS; // snap to a frame
const r3 = (n) => Math.round(n * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const SFX = {
  "whoosh-short": { lead: 0.22, duration: 0.57, gain: 0.45 },
  whoosh: { lead: 0.3, duration: 0.57, gain: 0.5 },
  impact: { name: "impact-bass-1", lead: 0.02, duration: 1.4, gain: 0.75 },
  glitch: { name: "glitch-1", lead: 0.03, duration: 0.55, gain: 0.32 },
};

/**
 * @param raw      director plan: { title, look, lookIntensity, textStyle, accent, musicStart, shots: [...] }
 * @param sources  { A: { file, duration, hasAudio, fps, words? }, ... }
 * @param music    beat analysis + { file } or null
 * @param options  { length, aspect, audioMode, captions, sfx, lut }
 */
export function buildPlan(raw, { sources, music, options }) {
  const { width, height } = ASPECTS[options.aspect] || ASPECTS["9:16"];
  const target = clamp(Number(options.length) || 30, 5, 180);
  const musicStart = music ? clamp(Number(raw.musicStart) || 0, 0, Math.max(0, music.duration - 2)) : 0;
  const grid = beatGrid(music, musicStart, target + 30);
  const beatSec = music?.period || 0.5;
  const allowSource = options.audioMode !== "music";
  const onlySource = options.audioMode === "source" || !music;

  // 1. Slots on the grid.
  const slots = [];
  let g = 0; // grid index of the current cut
  for (const s of raw.shots) {
    const src = sources[s.source];
    if (!src) continue;
    const t0 = grid[g];
    if (t0 >= target - beatSec * 0.5) break;
    const dialogue = allowSource && src.hasAudio && (s.audio === "source" || onlySource);
    let beats = clamp(Math.round(Number(s.beats) || 2), 1, 16);
    if (dialogue && s.audio === "source") {
      // Hold the shot until the line is finished, rounded up to the next beat.
      const need = Math.max(0.4, Number(s.end) - Number(s.start));
      beats = 1;
      while (grid[g + beats] - t0 < need - 0.12 && beats < 64) beats++;
    }
    // Don't overshoot the target by more than half a beat.
    while (beats > 1 && grid[g + beats] > target + beatSec * 0.5) beats--;
    slots.push({ s, src, dialogue, start: q(t0), end: q(grid[g + beats]) });
    g += beats;
  }
  if (!slots.length) throw new Error("The plan didn't contain any usable shots.");

  // 2. Transitions (need room on both sides, and an even number of frames so each side gets half).
  slots.forEach((slot, i) => {
    let type = i === 0 ? "cut" : TRANSITIONS[slot.s.transition] ? slot.s.transition : "cut";
    let d = TRANSITIONS[type].duration;
    if (i > 0) {
      const room = Math.min(slot.end - slot.start, slots[i - 1].end - slots[i - 1].start) * 0.6;
      if (d > room) {
        type = "cut";
        d = 0;
      }
    }
    d = (Math.round((d * FPS) / 2) * 2) / FPS;
    slot.transition = { type, duration: r3(d) };
  });

  // 3. Shots with source windows.
  const shots = slots.map((slot, i) => {
    const { s, src } = slot;
    const pre = slot.transition.duration / 2;
    const post = (slots[i + 1]?.transition.duration || 0) / 2;
    const length = q(slot.end - slot.start + pre + post);
    let speed = SPEEDS[s.speed] ? s.speed : "normal";
    let effects = [...new Set((s.effects || []).filter((e) => EFFECTS[e]))].slice(0, 3);
    if (slot.dialogue) {
      speed = "normal";
      effects = effects.filter((e) => !["echo", "strobe", "invert"].includes(e));
    }
    let parts = speedParts(speed, length, beatSec);
    let span = sourceSpan(parts);
    if (span > src.duration) {
      speed = src.duration >= length * 0.5 ? "slow" : "freeze";
      parts = speedParts(speed, length, beatSec);
      span = sourceSpan(parts);
    }
    const start = clamp(Number(s.start) || 0, 0, src.duration);
    const inPoint = r3(clamp(start - pre, 0, Math.max(0, src.duration - span - 0.05)));
    const segStart = slot.start - pre;
    const beats = grid.filter((t) => t > segStart + 0.02 && t < segStart + length - 0.05).map((t) => r3(t - segStart));
    const transitionIn = TRANSITIONS[slot.transition.type];
    const nextType = slots[i + 1]?.transition.type;
    return {
      index: i,
      source: s.source,
      moment: s.moment || null,
      file: src.file,
      in: inPoint,
      slotStart: r3(slot.start),
      slotEnd: r3(slot.end),
      pre: r3(pre),
      post: r3(post),
      length: r3(length),
      speed,
      parts,
      effects,
      beats,
      transition: slot.transition,
      nextTransition: nextType || "cut",
      edgeIn: transitionIn.edge || null,
      edgeOut: nextType ? TRANSITIONS[nextType].edge || null : null,
      focusX: clamp(Number(s.focusX ?? 50), 0, 100),
      frame: s.frame === "fit" ? "fit" : "fill",
      useAudio: Boolean(slot.dialogue && speed === "normal" && (s.audio === "source" || onlySource)),
      text: String(s.text || "").trim().slice(0, 40),
      why: s.why || "",
    };
  });
  const length = shots.at(-1).slotEnd;

  // 4. Text: the hook title over the opening, word slams on shots.
  const texts = [];
  const title = String(raw.title || "").trim();
  if (title) texts.push({ start: 0.03, end: Math.min(length, Math.max(1.6, shots[0].slotEnd, shots[1]?.slotEnd ?? 0)), text: title, y: 0.2, size: 0.82 });
  for (const shot of shots) {
    if (!shot.text) continue;
    const overlapsTitle = title && shot.slotStart < texts[0].end;
    texts.push({ start: shot.slotStart, end: Math.min(shot.slotEnd, shot.slotStart + Math.max(0.5, Math.min(1.6, shot.slotEnd - shot.slotStart))), text: shot.text, y: overlapsTitle ? 0.5 : 0.46 });
  }

  // 5. Captions on dialogue shots (word timings from the source transcript).
  const captions = [];
  if (options.captions) {
    for (const shot of shots.filter((x) => x.useAudio)) {
      const words = (sources[shot.source].words || []).filter((w) => w.start >= shot.in && w.end <= shot.in + shot.length);
      const offset = shot.slotStart - shot.pre - shot.in;
      for (let k = 0; k < words.length; k += 3) {
        const group = words.slice(k, k + 3).map((w) => ({ s: r3(w.start + offset), e: r3(w.end + offset), text: w.text }));
        captions.push({ start: group[0].s, end: Math.min(shot.slotEnd, group.at(-1).e + 0.25), words: group });
      }
    }
  }

  // 6. Sound design.
  const sfx = [];
  const level = options.sfx === "off" ? 0 : options.sfx === "subtle" ? 0.6 : 1;
  if (level) {
    for (const shot of shots.slice(1)) {
      const kind = TRANSITIONS[shot.transition.type].sfx;
      const spec = SFX[kind];
      if (!spec) continue;
      sfx.push({ name: spec.name || kind, at: r3(Math.max(0, shot.slotStart - spec.lead)), duration: spec.duration, gain: spec.gain * level });
    }
    if (music?.drop !== null && music?.drop !== undefined) {
      const dropAt = music.drop - musicStart;
      if (dropAt > 2 && dropAt < length - 1) {
        const rise = Math.min(4, dropAt - 0.2);
        sfx.push({ name: "riser", at: r3(dropAt - rise), offset: r3(10 - rise), duration: r3(rise), gain: 0.3 * level });
        sfx.push({ name: "impact-bass-2", at: r3(dropAt), duration: 1.8, gain: 0.7 * level });
      }
    }
    sfx.sort((a, b) => a.at - b.at);
    sfx.splice(48);
  }

  // Beat markers on the edit timeline (beats past the song's end are extrapolated from its tempo).
  const onTimeline = (times) => times.map((t) => r3(t - musicStart)).filter((t) => t >= -0.001 && t <= length);
  const markers = {
    bpm: music?.bpm ?? null,
    beats: grid.filter((t) => t <= length),
    downbeats: music ? onTimeline(music.downbeats) : [],
    drop: music?.drop !== null && music?.drop !== undefined && music.drop - musicStart >= 0 && music.drop - musicStart <= length ? r3(music.drop - musicStart) : null,
  };

  return {
    version: 1,
    markers,
    width,
    height,
    fps: FPS,
    length: r3(length),
    look: LOOKS[raw.look] ? raw.look : "natural",
    lookIntensity: clamp(Number(raw.lookIntensity ?? 0.8), 0, 1.2),
    lut: Boolean(options.lut),
    textStyle: TEXT_STYLES[raw.textStyle] ? raw.textStyle : "slam",
    accent: /^[0-9a-f]{6}$/i.test(String(raw.accent || "").replace("#", "")) ? String(raw.accent).replace("#", "").toUpperCase() : "FFE600",
    music: music ? { file: music.file, start: r3(musicStart), gain: options.audioMode === "mix" ? 0.85 : 1, bpm: music.bpm } : null,
    title,
    concept: raw.concept || "",
    shots,
    texts,
    captions,
    sfx,
  };
}
