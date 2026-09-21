// Plans a HyperFrames-style edit: which moments play where, cut on the music's grid the way the studied
// reels are paced, with spoken hook lines for story promos. The plan is rendered by lib/hfedit.js.
import fs from "node:fs/promises";
import path from "node:path";
import { ASPECTS } from "./compose.js";
import { loadMoments } from "./edits.js";
import { HF_STYLES, resolveStyle } from "./hfstyles.js";
import { getTrack, listTracks } from "./sounds.js";
import { projectDir, saveProject } from "./store.js";
import { measuredReferences } from "./study.js";
import { FFMPEG, run } from "./tools.js";
import { pickShots } from "./visual.js";
import { trackSubject, typicalX } from "./subject.js";
import { workingFile } from "./work.js";
import { hasProfanity } from "./profanity.js";

export const HF_LENGTHS = [15, 30, 45];
const r3 = (n) => Math.round(n * 1000) / 1000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Words a spoken hook line shouldn't lean on (captions still show what was said elsewhere). */
const HOOK_BLOCKLIST = { test: (text) => hasProfanity(text) };

/** Fill in and validate a HyperFrames edit's design. */
export function normalizeHfDesign(input = {}) {
  const styleId = HF_STYLES[input.style]?.kind === "edit" ? input.style : "cinematic";
  const style = HF_STYLES[styleId];
  const num = (value, min, max, fallback) => {
    const n = Number(value);
    return value !== undefined && value !== null && value !== "" && Number.isFinite(n) ? clamp(n, min, max) : fallback;
  };
  return {
    style: styleId,
    aspect: "9:16", // every Dope edit is a vertical reel
    length: HF_LENGTHS.includes(Number(input.length)) ? Number(input.length) : 15,
    // Open on something valuable the speaker says, then bring the music in (the creator's favorite structure).
    voiceIntro: typeof input.voiceIntro === "boolean" ? input.voiceIntro : true,
    pace: HF_PACES[input.pace] ? input.pace : "balanced",
    title: String(input.title ?? "").trim().slice(0, 60),
    captions: typeof input.captions === "boolean" ? input.captions : style.text.captions !== "minimal",
    bars: typeof input.bars === "boolean" ? input.bars : style.bars,
    strength: num(input.strength, 0, 1.2, 1),
    accentColor: /^#[0-9a-f]{6}$/i.test(input.accentColor || "") ? input.accentColor.toUpperCase() : "#FF2E3F",
    originalAudio: num(input.originalAudio, 0, 1, 1), // the speaker's voice on spoken lines
    cropX: num(input.cropX, 0, 100, 50),
    autoFrame: typeof input.autoFrame === "boolean" ? input.autoFrame : true, // each shot's crop follows its subject
    variant: Math.round(num(input.variant, 0, 999, 0)), // "New cut" counter: different moments, same style
  };
}

/** Deterministic shuffle for a variant (0 keeps the natural order). */
function shuffled(list, seed) {
  if (!seed) return list;
  let s = seed * 2654435761;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const HF_PACES = {
  relaxed: { label: "Relaxed", hint: "Long shots on the phrase, few effects" },
  balanced: { label: "Balanced", hint: "Cuts on the bar, effects on the big hits" },
  energetic: { label: "Energetic", hint: "Quick cuts on the beat" },
};

// Shot lengths in beats of the song (cycled), with the shortest and longest a shot may run in seconds and the
// rhythm to use when there's no song. The creator found the studied promo pace (~0.7s shots) far too fast.
const PACING = {
  promo: {
    relaxed: { beats: [8, 8, 16, 8], min: 2.2, max: 5, seconds: 2.8 },
    balanced: { beats: [4, 4, 8, 4, 4, 8], min: 1.3, max: 3.6, seconds: 1.8 },
    energetic: { beats: [2, 4, 2, 2, 4, 8], min: 0.7, max: 2.2, seconds: 1.1 },
  },
  cinematic: {
    relaxed: { beats: [16, 16, 8, 16], min: 4, max: 8, seconds: 4.8 },
    balanced: { beats: [8, 8, 16, 8], min: 2.6, max: 6, seconds: 3.4 },
    energetic: { beats: [4, 8, 4, 8], min: 1.6, max: 3.8, seconds: 2.2 },
  },
};

const paceFor = (styleId, pace) => (PACING[styleId] || PACING.cinematic)[pace] || (PACING[styleId] || PACING.cinematic).balanced;

/** The song's beats on the edit timeline: [{ t, strength, down }] (down = first beat of a bar), or null without a song. */
function musicGrid(track, start, length) {
  if (!track?.beats?.length) return null;
  const downs = track.downbeats || [];
  const grid = track.beats
    .map((t, i) => ({ t: r3(t - start), strength: track.strengths?.[i] ?? 0.5, down: downs.some((d) => Math.abs(d - t) < 0.03) }))
    .filter((b) => b.t >= -0.03 && b.t <= length + 0.03);
  return grid.length >= 4 ? grid : null;
}

function beatLength(grid) {
  const gaps = grid.slice(1).map((b, i) => b.t - grid[i].t).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] || 0.5;
}

// How a song's sections change the cutting: the drop cuts about twice as fast as the breakdown, so the edit
// rides the song instead of running at one speed through all of it.
const SECTION_DENSITY = { intro: 1.5, build: 0.8, peak: 0.5, break: 1.6, steady: 1, outro: 1.5 };

/**
 * The song's shape across the edit: [{ from, to, role, energy }] over the beat grid, where `role` is
 * intro / build / peak / break / steady / outro. Built from how loud each beat hits, so the drop, the
 * breakdown and the ride-out all get named. Empty when the song is too short to have a shape.
 */
function musicSections(grid, length) {
  const bars = [];
  for (let i = 0; i < grid.length; i += 4) {
    const slice = grid.slice(i, i + 4);
    if (slice.length < 2) break;
    bars.push({ t: slice[0].t, end: slice.at(-1).t, energy: slice.reduce((sum, b) => sum + b.strength, 0) / slice.length });
  }
  if (bars.length < 4) return [];
  // Smooth over neighbouring bars so one loud snare doesn't read as a whole new section.
  const smooth = bars.map((_, i) => {
    const win = bars.slice(Math.max(0, i - 1), i + 2);
    return win.reduce((sum, b) => sum + b.energy, 0) / win.length;
  });
  const sorted = [...smooth].sort((a, b) => a - b);
  const at = (q) => sorted[clamp(Math.floor(sorted.length * q), 0, sorted.length - 1)];
  const [lo, hi] = [at(0.25), at(0.75)];
  const span = Math.max(0.04, hi - lo);

  // Cut the song where its level clearly steps, keeping every section long enough to feel like one — a
  // section that flips every couple of bars isn't a section, it's just the beat.
  const barSec = Math.max(0.5, (bars.at(-1).end - bars[0].t) / Math.max(1, bars.length - 1));
  const minBars = Math.max(2, Math.ceil(Math.max(5, length / 6) / barSec));
  const edges = [0];
  for (let i = 1; i < bars.length - minBars / 2; i++) {
    if (Math.abs(smooth[i] - smooth[edges.at(-1)]) > span * 0.6 && i - edges.at(-1) >= minBars) edges.push(i);
  }
  const sections = edges.map((startBar, n) => {
    const endBar = edges[n + 1] ?? bars.length;
    const level = smooth.slice(startBar, endBar).reduce((sum, e) => sum + e, 0) / Math.max(1, endBar - startBar);
    const rising = smooth[endBar - 1] - smooth[startBar] > span * 0.3;
    const first = n === 0;
    const last = endBar >= bars.length;
    let role = "steady";
    if (level >= hi - span * 0.15) role = "peak";
    else if (level <= lo + span * 0.25) role = first ? "intro" : last ? "outro" : "break";
    else if (rising) role = "build";
    return { from: r3(bars[startBar].t), to: r3(endBar >= bars.length ? length : bars[endBar].t), role, energy: r3(clamp((level - lo) / span, 0, 1)) };
  });
  // Two sections in a row that play the same way are one section.
  const merged = [];
  for (const s of sections) {
    const prev = merged.at(-1);
    if (prev?.role === s.role) {
      prev.to = s.to;
      prev.energy = r3((prev.energy + s.energy) / 2);
    } else merged.push(s);
  }
  return merged.length > 1 ? merged.slice(0, 8) : [];
}

const sectionAt = (sections, t) => sections.find((s) => t >= s.from - 0.05 && t < s.to) || null;
/** The pace a section cuts at: same pattern, stretched or tightened by how hard the song is going. */
const paceIn = (pace, section) => {
  const mult = SECTION_DENSITY[section?.role] ?? 1;
  return mult === 1 ? pace : { ...pace, mult, min: Math.max(0.5, r3(pace.min * mult)), max: r3(pace.max * mult), seconds: r3(pace.seconds * mult) };
};

/** Cuts on the song's beats: each shot lasts a whole number of beats from the pace pattern, on a bar line when it can. */
function beatCuts(from, to, grid, basePace, sections = []) {
  const beatLen = beatLength(grid);
  let i = grid.findIndex((b) => b.t >= from - 0.07);
  if (i < 0) return evenCuts(from, to, basePace);
  const cuts = [from];
  for (let k = 0; ; k++) {
    // Re-read the song's section at every cut: the drop tightens the shots, the breakdown lets them run.
    const pace = paceIn(basePace, sectionAt(sections, grid[i].t));
    let n = Math.max(1, Math.round(pace.beats[k % pace.beats.length] * (pace.mult ?? 1)));
    while (n * beatLen < pace.min && n < 64) n *= 2;
    while (n > 1 && n * beatLen > pace.max) n = Math.max(1, Math.round(n / 2));
    let j = i + n;
    if (n % 4 === 0) {
      for (const offset of [0, -1, 1]) {
        if (grid[j + offset]?.down) {
          j += offset;
          break;
        }
      }
    }
    const next = grid[j];
    if (!next || to - next.t < pace.min * 0.6 || next.t <= cuts.at(-1) + 0.2) break;
    cuts.push(r3(next.t));
    i = j;
  }
  return cuts;
}

/** Without a song: an even rhythm at the pace's shot length. */
function evenCuts(from, to, pace) {
  const rhythm = [1, 1, 1.35, 0.8, 1.15];
  const cuts = [from];
  let t = from;
  for (let k = 0; to - t > pace.min * 1.5; k++) {
    const next = t + clamp(pace.seconds * rhythm[k % rhythm.length], pace.min, pace.max);
    if (to - next < pace.min * 0.6) break;
    cuts.push(r3(next));
    t = next;
  }
  return cuts;
}

/**
 * A song from the creator's sound library for an edit, picked at random but weighted toward songs long enough
 * for the edit and at a tempo that suits the style. `exclude` skips the song the edit already has.
 */
export async function pickTrack(styleId, length, { exclude = null } = {}) {
  // The library listing leaves beat data out (beatCount only); the chosen song is loaded in full.
  const tracks = (await listTracks()).filter((t) => t.id !== exclude && t.status !== "error" && t.beatCount >= 8);
  if (!tracks.length) return null;
  const [lo, hi] = styleId === "cinematic" ? [60, 118] : [92, 150];
  const weight = (t) => Math.min(1, (t.duration || 0) / length) ** 2 * (t.bpm >= lo && t.bpm <= hi ? 1 : 0.45) + 0.02;
  let r = Math.random() * tracks.reduce((sum, t) => sum + weight(t), 0);
  const chosen = tracks.find((t) => (r -= weight(t)) <= 0) || tracks.at(-1);
  return getTrack(chosen.id);
}

/** The transcript words from `start` to the end of that sentence (up to ~5.5s), as a spoken line. */
function lineAt(words, start) {
  const first = words.findIndex((w) => w.end > start - 0.05);
  if (first < 0) return null;
  const line = [];
  for (let i = first; i < words.length; i++) {
    const w = words[i];
    if (line.length && (w.start - line.at(-1).end > 0.7 || w.end - words[first].start > 5.5)) break;
    line.push(w);
    if (/[.?!]$/.test(w.text) && w.end - words[first].start >= 1.4) break;
  }
  // Ran out of time mid-sentence: end on the last comma or pause-worthy word instead of a dangling fragment.
  if (!/[.?!]$/.test(line.at(-1).text)) {
    const soft = line.findLastIndex((w, i) => i >= 2 && /[,;:]$/.test(w.text));
    if (soft > 0) line.length = soft + 1;
  }
  if (!line.length) return null;
  const text = line.map((w) => w.text).join(" ");
  const span = line.at(-1).end - line[0].start;
  if (span < 1.2 || HOOK_BLOCKLIST.test(text)) return null;
  return { start: r3(line[0].start), end: r3(line.at(-1).end), text, words: line };
}

/** A promo's on-screen hook: the project's best short title, else the opening line's first words. */
function hookTitle(project, lines) {
  const titles = (project.analysis?.titles || []).map((t) => (typeof t === "string" ? t : t.title)).filter((t) => t && t.split(/\s+/).length <= 6 && !HOOK_BLOCKLIST.test(t));
  if (titles.length) return titles[0].replace(/[.?!,]+$/, "");
  const words = lines[0]?.text.replace(/[.?!,]+$/, "").split(/\s+/) || [];
  return words.length ? words.slice(0, 4).join(" ") : "";
}

async function pickLines(project, count) {
  if (!count) return [];
  let words = [];
  try {
    words = JSON.parse(await fs.readFile(path.join(projectDir(project.id), "words.json"), "utf8"));
  } catch {
    return [];
  }
  if (words.length < 10) return [];
  const candidates = [
    ...(project.analysis?.messages || []).filter((m) => Number.isFinite(m.start)).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).map((m) => m.start),
    ...(project.clips || []).map((c) => c.start),
  ];
  const lines = [];
  for (const start of candidates) {
    const line = lineAt(words, start);
    if (line && !lines.some((l) => Math.abs(l.start - line.start) < 20)) lines.push(line);
    if (lines.length >= count) break;
  }
  return lines;
}

/**
 * Build the plan. Segments tile the timeline: { t, dur, kind: "shot" | "line", mediaStart, rate, transition, fx }.
 * Transitions: "cut" | "dissolve" (overlaps the previous segment) | "flash" | "leak"; fx: "mono" | "punch".
 */
export async function buildHfPlan(project, design, { track, onProgress } = {}) {
  const d = normalizeHfDesign(design);
  const style = resolveStyle(d.style, await measuredReferences());
  const sourceDuration = Number(project.source.duration) || 0;
  if (sourceDuration < 4) throw new Error(`This video is only ${Math.round(sourceDuration * 10) / 10}s long — edits need a few seconds of footage.`);
  const pace = paceFor(style.id, d.pace);

  // Open on something valuable the speaker says (their voice, no music), then the song comes in and the cutting
  // starts. Longer edits drop a second line past the middle, over the music.
  const lines = d.voiceIntro && project.source.hasAudio ? (await pickLines(project, d.length >= 25 ? 2 : 1)).filter((l) => l.end - l.start <= d.length - 4) : [];
  const musicAt = lines.length ? r3(lines[0].end - lines[0].start + 0.25) : 0;

  // The song drives the rest: it enters on its first bar, cuts land on its beats, and the edit stays within it.
  const musicStart = track?.downbeats?.length && track.downbeats[0] <= 1.5 ? r3(track.downbeats[0]) : 0;
  const songLeft = track?.duration ? track.duration - musicStart : Infinity;
  const length = Math.max(5, Math.min(d.length, Math.floor(musicAt + songLeft), Math.floor(sourceDuration)));
  const grid = musicGrid(track, musicStart - musicAt, length);
  const sections = grid ? musicSections(grid, length) : [];
  const snap = (t) => (grid ? grid.reduce((best, b) => (Math.abs(b.t - t) < Math.abs(best - t) ? b.t : best), t) : t);

  const stretches = [];
  let cursor = 0;
  lines.forEach((line, i) => {
    const span = line.end - line.start;
    const at = i === 0 ? 0 : r3(snap(length * 0.55));
    if (at < cursor || at + span > length - 2) return;
    if (at > cursor) stretches.push({ kind: "shots", from: cursor, to: at });
    const end = i === 0 ? musicAt : r3(Math.min(length - 2, snap(at + span + 0.15)));
    stretches.push({ kind: "line", from: at, to: Math.max(end, at + 1.2), line });
    cursor = Math.max(end, at + 1.2);
  });
  if (length - cursor > 0.4) stretches.push({ kind: "shots", from: cursor, to: length });

  const slots = [];
  for (const s of stretches) {
    if (s.kind === "line") slots.push({ t: s.from, dur: r3(s.to - s.from), kind: "line", line: s.line });
    else {
      const cuts = grid ? beatCuts(s.from, s.to, grid, pace, sections) : evenCuts(s.from, s.to, pace);
      cuts.forEach((c, i) => slots.push({ t: c, dur: r3((cuts[i + 1] ?? s.to) - c), kind: "shot" }));
    }
  }
  // A shot left stranded against the next spoken line reads as a glitch, not a cut: give its time back to the
  // shot before it.
  for (let i = slots.length - 1; i > 0; i--) {
    const floor = paceIn(pace, sectionAt(sections, slots[i].t)).min * 0.7;
    if (slots[i].kind === "shot" && slots[i - 1].kind === "shot" && slots[i].dur < floor) {
      slots[i - 1].dur = r3(slots[i - 1].dur + slots[i].dur);
      slots.splice(i, 1);
    }
  }

  // Moments for the shot slots, strongest first, played back in story order.
  onProgress?.("Finding the best-looking moments…");
  const moments = await loadMoments(project, (f) => onProgress?.(`Scanning the footage… ${Math.round(f * 100)}%`));
  const shotSlots = slots.filter((s) => s.kind === "shot");
  const longest = Math.max(...shotSlots.map((s) => s.dur), 1);
  const avoid = lines.map((l) => ({ start: l.start - 1.5, end: l.end + 1.5 }));
  const picked = pickShots(moments, {
    // Ask for enough footage that every slot gets its own moment, even when moments come out long.
    targetSec: Math.max(shotSlots.reduce((sum, s) => sum + s.dur, 0) * 1.8, shotSlots.length * (longest + 0.8) * 1.4),
    shotMin: Math.min(pace.min, 1),
    shotMax: longest + 0.8,
    minGapSec: clamp(sourceDuration / (shotSlots.length * 2.5), 0.5, 6),
    avoid,
  })
    .filter((s) => s.start <= sourceDuration - 1)
    .sort((a, b) => b.score - a.score);
  // A new cut draws from a wider pool of strong moments in a different mix.
  const pool = d.variant ? shuffled(picked.slice(0, Math.ceil(shotSlots.length * 1.8)), d.variant) : picked;
  picked.splice(0, picked.length, ...pool.slice(0, shotSlots.length).sort((a, b) => a.start - b.start));
  if (!picked.length) throw new Error("Couldn't find usable moments in this video.");

  // Fewer good moments than slots: merge the tail slots so every shot is real footage.
  while (shotSlots.length > picked.length) {
    const last = shotSlots.pop();
    const idx = slots.indexOf(last);
    const prev = slots[idx - 1];
    slots.splice(idx, 1);
    if (prev) prev.dur = r3(prev.dur + last.dur);
  }

  let shotIndex = 0;
  const best = picked.reduce((b, s, i) => (s.score > picked[b].score ? i : b), 0);
  const segments = slots.map((slot, i) => {
    if (slot.kind === "line") {
      return { index: i, t: slot.t, dur: slot.dur, kind: "line", mediaStart: slot.line.start, rate: 1, transition: i ? "flash" : "cut", fx: null, text: slot.line.text, words: slot.line.words.map((w) => ({ text: w.text, s: r3(w.start - slot.line.start), e: r3(w.end - slot.line.start) })) };
    }
    const shot = picked[shotIndex];
    const isBest = shotIndex === best;
    shotIndex += 1;
    const available = Math.max(0.3, Math.min(shot.end + 1.5, sourceDuration) - shot.start);
    // Cinematic slows its best moment down; any shot too short for its slot stretches a little.
    let rate = style.id === "cinematic" && isBest ? 0.6 : 1;
    if (slot.dur * rate > available) rate = clamp(available / slot.dur, 0.5, 1);
    const mediaStart = clamp(shot.start - Math.max(0, slot.dur * rate - (shot.end - shot.start)) / 2, 0, Math.max(0, sourceDuration - slot.dur * rate - 0.1));
    return { index: i, t: slot.t, dur: slot.dur, kind: "shot", mediaStart: r3(mediaStart), rate: r3(rate), transition: "cut", fx: null, score: shot.score };
  });

  // Effects land on the music: punch-ins, flashes and the black-and-white hit only where a cut meets a bar line,
  // and fewer of them the more relaxed the pace.
  const tr = style.transitions;
  const beatAt = (t) => grid?.find((b) => Math.abs(b.t - t) < 0.07) || null;
  const barLen = grid ? beatLength(grid) * 4 : pace.seconds * 2;
  const flashGap = { relaxed: 8, balanced: 4, energetic: 2 }[d.pace] * barLen * 0.95;
  // Accents earn their place: never two in a row, never closer than a couple of bars, and the breakdown stays
  // clean so the drop still lands. An effect everywhere is the same as no effect anywhere.
  const accentGap = barLen * { relaxed: 4, balanced: 2, energetic: 1.5 }[d.pace];
  let lastFlash = -Infinity;
  let lastAccent = -Infinity;
  let barCuts = 0;
  segments.forEach((s, i) => {
    if (!i || s.kind === "line") return;
    const beat = beatAt(s.t);
    const onBar = grid ? Boolean(beat?.down) : true;
    const role = sectionAt(sections, s.t)?.role;
    const calm = role === "break" || role === "intro" || role === "outro";
    const quiet = segments[i - 1].fx || segments[i - 1].transition === "flash"; // the shot before already hit
    if (onBar) barCuts += 1;
    if (tr.dissolveEvery && i % tr.dissolveEvery === 0 && s.dur > 1 && segments[i - 1].dur > 1) s.transition = "dissolve";
    const wantsPunch = d.pace === "energetic" || role === "peak" || (d.pace === "balanced" && barCuts % 2 === 1);
    if (style.camera.punch && onBar && wantsPunch && !calm && !quiet && s.t - lastAccent >= accentGap) {
      s.fx = "punch";
      lastAccent = s.t;
    }
    if (tr.flashes && d.pace !== "relaxed" && s.transition === "cut" && onBar && !calm && !quiet && (beat?.strength ?? 1) >= 0.6 && s.t - lastFlash >= flashGap && s.t - lastAccent >= accentGap * 0.5) {
      s.transition = "flash";
      lastFlash = s.t;
      lastAccent = s.t;
    }
  });
  if (tr.lightLeaks) {
    const target = segments.filter((s, i) => i && s.transition === "cut").sort((a, b) => Math.abs(a.t - length * 0.4) - Math.abs(b.t - length * 0.4))[0];
    if (target) target.transition = "leak";
  }
  if (tr.monoHits && d.pace !== "relaxed") {
    // The black-and-white hit goes where the song is hardest — the drop, if the song has one.
    const strength = (s) => (beatAt(s.t)?.strength ?? 0) + (sectionAt(sections, s.t)?.role === "peak" ? 1 : 0);
    const hit = segments
      .filter((s) => s.kind === "shot" && s.t > length * 0.45 && s.dur <= 2.6 && (!grid || beatAt(s.t)?.down))
      .sort((a, b) => strength(b) - strength(a))[0];
    if (hit) hit.fx = "mono";
  }

  // Where the subject sits in each shot, so landscape footage can be cropped around it for taller canvases.
  if (project.source.width > project.source.height) {
    onProgress?.("Framing the subject in each shot…");
    for (const s of segments) {
      const span = s.dur * s.rate;
      const track = await trackSubject(workingFile(project), s.mediaStart, s.mediaStart + span, { step: Math.max(0.3, span / 3) }).catch(() => []);
      s.focusX = typicalX(track);
    }
  }

  return {
    styleId: style.id,
    source: { width: project.source.width, height: project.source.height },
    style: { label: style.label, grade: style.grade, camera: style.camera, transitions: style.transitions, text: style.text, pacing: style.pacing, learnedFrom: style.learnedFrom },
    duration: length,
    segments,
    beats: grid ? grid.map((b) => ({ t: b.t, strength: b.strength, down: b.down })) : [],
    sections,
    musicStart,
    musicAt,
    pace: d.pace,
    title: d.title || (style.text.title === "hook" ? hookTitle(project, lines) : ""),
  };
}

/**
 * One light 720p file with every segment back to back (with room for dissolves and slow motion),
 * so the live preview plays a single small video instead of seeking a 4K source.
 */
export async function buildHfProxy(project, editId, plan) {
  const dir = path.join(projectDir(project.id), "edits", editId);
  await fs.mkdir(dir, { recursive: true });
  const src = workingFile(project);
  const spans = plan.segments.map((s) => r3(s.dur * s.rate + 1)); // room for the longest dissolve
  const offsets = [];
  let at = 0;
  for (const span of spans) {
    offsets.push(r3(at));
    at += span;
  }
  const withAudio = Boolean(project.source.hasAudio);
  const inputs = plan.segments.flatMap((s, i) => ["-ss", String(s.mediaStart), "-t", String(spans[i]), "-i", src]);
  const chains = plan.segments.map(
    (_, i) => `[${i}:v]scale=-2:720,setsar=1,fps=30,format=yuv420p[v${i}]` + (withAudio ? `;[${i}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]` : ""),
  );
  const concat = plan.segments.map((_, i) => `[v${i}]${withAudio ? `[a${i}]` : ""}`).join("");
  const file = `proxy-${Date.now().toString(36)}.mp4`;
  await run(FFMPEG, [
    "-y", "-loglevel", "error", ...inputs,
    "-filter_complex", `${chains.join(";")};${concat}concat=n=${plan.segments.length}:v=1:a=${withAudio ? 1 : 0}[v]${withAudio ? "[a]" : ""}`,
    "-map", "[v]", ...(withAudio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "128k"] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-g", "30", "-movflags", "+faststart",
    path.join(dir, file),
  ]);
  for (const name of await fs.readdir(dir)) if (name.startsWith("proxy") && name !== file) await fs.rm(path.join(dir, name), { force: true });
  return { file: `edits/${editId}/${file}`, offsets };
}

/** Create a HyperFrames edit and plan it in the background (status "scanning" → "ready" | "error"). */
export async function createHfEdit(project, { design: input, trackId } = {}) {
  const design = normalizeHfDesign(input);
  // "shuffle" (the default) picks a song from the sound library; "none" keeps the video's own sound.
  const shuffle = trackId === undefined || trackId === "shuffle";
  const track = shuffle ? await pickTrack(design.style, design.length) : null;
  const edit = {
    id: `hf-${Date.now().toString(36)}`,
    engine: "hf",
    createdAt: new Date().toISOString(),
    status: "scanning",
    message: "Picking moments in your studied style…",
    design,
    trackId: shuffle ? track?.id || null : trackId === "none" ? null : trackId || null,
  };
  project.edits = [edit, ...(project.edits || [])];
  await saveProject(project);
  planHfEdit(project, edit).catch((err) => console.error(`[${project.id}/${edit.id}]`, err));
  return edit;
}

/** (Re)plan an edit: new shots for its current design. */
export async function planHfEdit(project, edit) {
  // The edit lives inside project.edits, so its progress is saved by saving the project.
  const set = (patch) => {
    Object.assign(edit, patch);
    return saveProject(project);
  };
  try {
    await set({ status: "scanning", message: "Picking moments in your studied style…", error: null });
    const track = edit.trackId ? await getTrack(edit.trackId) : null;
    if (edit.trackId && !track) throw new Error("That music track is no longer in your sound library.");
    const plan = await buildHfPlan(project, edit.design, { track, onProgress: (message) => set({ message }) });
    await set({ message: "Preparing the preview…" });
    const proxy = await buildHfProxy(project, edit.id, plan);
    const lines = plan.segments.filter((s) => s.kind === "line").length;
    await set({
      status: "ready",
      plan,
      proxy,
      duration: plan.duration,
      planVersion: (edit.planVersion || 0) + 1,
      message: `${plan.segments.length} shots${lines ? ` · ${lines} spoken ${lines > 1 ? "lines" : "line"}` : ""} · ${plan.duration}s${track ? ` · ${track.name}` : ""}`,
    });
  } catch (err) {
    await set({ status: "error", message: "Couldn't build this edit", error: err.message });
  }
}
