// Builds a HyperFrames composition for one clip — as a project folder for rendering, or as a live
// preview page that plays straight from the source video.
import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./tools.js";
import { HF_STYLES } from "./hfstyles.js";
import { objectPositionFor } from "./subject.js";
import { captionClearOfFaces } from "./facezone.js";
import { placeEmphasis } from "./emphasis.js";

const ASSETS = path.join(ROOT, "assets");
const BASE_CAPTION_PX = 118;

export const ASPECTS = {
  "9:16": { label: "9:16", hint: "Reels · TikTok · Shorts", width: 1080, height: 1920 },
  "4:5": { label: "4:5", hint: "Instagram feed", width: 1080, height: 1350 },
  "1:1": { label: "1:1", hint: "Square", width: 1080, height: 1080 },
  "16:9": { label: "16:9", hint: "YouTube · landscape", width: 1920, height: 1080 },
};

export const FONTS = {
  // The leaning grotesque from the reels the creator likes: heavy, italic, soft shadow, no outline.
  italic: { label: "Bold Italic", css: "'Studio Italic', 'Inter', system-ui, sans-serif", weight: 700, italic: true },
  anton: { label: "Anton", css: "'Anton', sans-serif", weight: 400 },
  inter: { label: "Inter Black", css: "'Inter', system-ui, sans-serif", weight: 900 },
  interBold: { label: "Inter Bold", css: "'Inter', system-ui, sans-serif", weight: 800 },
};

/** Style presets. A clip's design starts from one and can override any field. */
export const STYLES = {
  // Podcast Frame is the house default; it's listed first everywhere.
  podcast: {
    label: "Podcast Frame",
    description: "Blurred backdrop, framed video, clean headline — a premium podcast clip.",
    layout: "framed",
    design: {
      // Premium brand look: clean sentence-case Inter in white, words brighten as they're spoken, nothing bounces.
      font: "interBold", uppercase: false, textColor: "#FFFFFF", accentColor: "#FFFFFF", emphasisColor: "#FFFFFF",
      captionScale: 0.52, captionY: null, maxWords: 4, outline: false, highlight: "reveal",
      titleStyle: "plain", showTitle: true, titleOut: 0, zoom: false, progress: true, cropX: 50,
    },
  },
  // Learned from the FLAVSMEDIA reel in Study: bright clean grade, jump-cut punch-ins, phrase captions with
  // italic serif emphasis words. No headline and no light leak (the creator's call).
  talk: {
    label: "Editorial Talk",
    description: "From your Study: bright clean look, jump-cut punch-ins, captions with italic serif emphasis.",
    layout: "cover",
    design: {
      font: "interBold", uppercase: false, textColor: "#FFFFFF", accentColor: "#FFFFFF", emphasisColor: "#FFFFFF",
      captionScale: 0.8, captionY: 62, maxWords: 3, outline: false, highlight: "serif",
      titleStyle: "plain", showTitle: false, titleOut: 0, zoom: true, progress: false, cropX: 50,
      jumpCuts: true, grade: "clean", leak: false,
    },
  },
  bold: {
    label: "Bold Pop",
    description: "Full-bleed crop, huge punchy captions, yellow karaoke highlight.",
    layout: "cover",
    design: {
      font: "anton", uppercase: true, textColor: "#FFFFFF", accentColor: "#FFE600", emphasisColor: "#4ADE80",
      captionScale: 1, captionY: 64, maxWords: 3, outline: true, highlight: "color",
      titleStyle: "card", showTitle: true, titleOut: 0, zoom: true, progress: true, cropX: 50,
    },
  },
  minimal: {
    label: "Clean Minimal",
    description: "Cinematic crop, calm captions with a sliding highlight pill.",
    layout: "cover",
    design: {
      font: "interBold", uppercase: false, textColor: "#FFFFFF", accentColor: "#7C3AED", emphasisColor: "#FDE68A",
      captionScale: 0.58, captionY: 72, maxWords: 5, outline: false, highlight: "pill",
      titleStyle: "pill", showTitle: true, titleOut: 5, zoom: true, progress: true, cropX: 50,
    },
  },
};

const HEX = /^#[0-9a-f]{6}$/i;

// Voice and bed go into the renderer ~2 dB under full level: its AAC true-peak check (-1 dBFS) otherwise fails on
// hot joins. The finished file is brought back to -14 LUFS afterwards (lib/master.js), so nothing sounds quieter.
const MIX_HEADROOM = 0.8;

/**
 * The house music level under the voice: 13% (2026-09-15: the creator found 11% too quiet to hear, but the bed must
 * never overpower the voice). Clips saved at the old 11% house level follow it back up.
 */
export const MUSIC_LEVEL = 0.13;
export const houseLevel = (level) => (Math.abs(level - 0.11) < 0.001 ? MUSIC_LEVEL : level);

/**
 * The music-only ending on podcast clips, measured from the creator's reference short: the bed stays flat under
 * the talking, holds ~1s past the last word, then comes up ~12 dB over half a second and plays out with no captions.
 */
export const MUSIC_TAIL = { sec: 3.5, hold: 0.9, ramp: 0.5, level: 0.75 };

/** Fill in and validate a (possibly partial or untrusted) design. `captionY: null` means automatic. */
export function normalizeDesign(input = {}) {
  const style = STYLES[input.style] ? input.style : "podcast";
  const base = STYLES[style].design;
  const given = (key) => input[key] !== undefined && input[key] !== null && input[key] !== "";
  const oneOf = (key, allowed) => (given(key) && allowed.includes(input[key]) ? input[key] : base[key]);
  const bool = (key) => (typeof input[key] === "boolean" ? input[key] : base[key]);
  const color = (key) => (given(key) && HEX.test(input[key]) ? input[key].toUpperCase() : base[key]);
  const num = (key, min, max, fallback = base[key]) => {
    const n = Number(input[key]);
    return given(key) && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    style,
    aspect: ASPECTS[input.aspect] ? input.aspect : "9:16",
    font: oneOf("font", Object.keys(FONTS)),
    uppercase: bool("uppercase"),
    textColor: color("textColor"),
    accentColor: color("accentColor"),
    emphasisColor: color("emphasisColor"),
    captionScale: num("captionScale", 0.4, 1.6),
    captionY: input.captionY === "auto" ? null : num("captionY", 5, 95),
    maxWords: Math.round(num("maxWords", 1, 6)),
    outline: bool("outline"),
    highlight: oneOf("highlight", ["color", "pill", "serif", "reveal", "none"]),
    titleStyle: oneOf("titleStyle", ["card", "pill", "plain"]),
    showTitle: bool("showTitle"),
    titleOut: num("titleOut", 0, 60),
    zoom: bool("zoom"),
    progress: bool("progress"),
    cropX: num("cropX", 0, 100, 50),
    // Follow the speaker across the crop; turning it off uses cropX as a fixed position.
    autoFrame: typeof input.autoFrame === "boolean" ? input.autoFrame : true,
    // Always on (the creator's call, no toggle): cut "um"s, stutters, filler and long pauses (lib/tighten.js),
    // open on the video's strongest hook, and fill a thin clip out with other strong lines.
    tighten: true,
    hookFirst: true,
    stitch: true,
    // How the framing moves: hard punch-ins on phrases, a soft glide, or a still shot.
    motion: ["punchy", "gentle", "none"].includes(input.motion) ? input.motion : base.jumpCuts ? "punchy" : "gentle",
    // Quiet instrumental bed under the talking: "auto" (pick one), "none", or a track id.
    musicBed: typeof input.musicBed === "string" && input.musicBed ? input.musicBed.slice(0, 40) : "auto",
    musicLevel: houseLevel(num("musicLevel", 0, 0.8, MUSIC_LEVEL)),
    // Studied-style extras (Editorial Talk): hard punch-in jump cuts, HyperFrames color grade, light leak on the open.
    jumpCuts: typeof input.jumpCuts === "boolean" ? input.jumpCuts : Boolean(base.jumpCuts),
    // Power words popping big and key-point cards sliding in (lib/emphasis.js). On for every style unless turned off.
    pops: typeof input.pops === "boolean" ? input.pops : true,
    // Word-by-word captions. Turned off for footage that already has captions burned in (lib/sourcecaptions.js).
    captions: typeof input.captions === "boolean" ? input.captions : true,
    grade: ["clean", "none"].includes(input.grade) ? input.grade : base.grade || "none",
    leak: typeof input.leak === "boolean" ? input.leak : Boolean(base.leak),
    // Podcast Frame stays premium whatever was saved on the clip: no outlines, all-caps, poster fonts, colored
    // word pops or boxed titles. Size, position, text color and the title still follow the clip's design.
    ...(style === "podcast" ? premiumLook(input, base) : {}),
    // Editorial Talk never carries a headline or the light-leak glare, whatever an older saved design says.
    ...(style === "talk" ? { showTitle: false, leak: false } : {}),
  };
}

function premiumLook(input, base) {
  const text = typeof input.textColor === "string" && HEX.test(input.textColor) ? input.textColor.toUpperCase() : base.textColor;
  return {
    font: input.font === "italic" || input.font === "interBold" ? input.font : base.font,
    uppercase: false,
    outline: false,
    highlight: "reveal",
    titleStyle: "plain",
    accentColor: text,
    emphasisColor: text,
  };
}

/** A phrase's accent word when the clip didn't mark one: a number, else its longest real word. */
function fallbackEmphasis(words) {
  const numeric = words.findIndex((w) => /\d|\$/.test(w.text));
  if (numeric >= 0) return numeric;
  let best = -1;
  words.forEach((w, i) => {
    if (norm(w.text).length >= 5 && (best < 0 || norm(w.text).length > norm(words[best].text).length)) best = i;
  });
  return best;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const r3 = (n) => Math.round(n * 1000) / 1000;

// Words that belong with what comes after them: ending a caption on one leaves the reader hanging mid-phrase.
const LEADING_WORDS = new Set(["a", "an", "the", "to", "of", "in", "on", "at", "for", "and", "or", "but", "with", "my", "your", "his", "her", "their", "our", "its", "is", "was", "are", "that", "this", "i", "you", "we", "they", "it", "he", "she"]);

/** Short-form caption phrasing: a few words per beat, broken at pauses and punctuation. */
export function groupCaptions(words, duration, { maxWords, maxSpan = 1.8, pause = 0.45 }) {
  const groups = [];
  let cur = [];
  const flush = () => {
    if (cur.length) groups.push(cur);
    cur = [];
  };
  for (const w of words) {
    const prev = cur.at(-1);
    if (prev && (w.s - prev.e >= pause || w.e - cur[0].s > maxSpan || cur.length >= maxWords)) flush();
    cur.push(w);
    if (/[.?!]$/.test(w.text) || (/[,;:]$/.test(w.text) && cur.length >= 2)) flush();
  }
  flush();

  // Clean up the breaks the word count forced: nothing ends on a dangling "the" or "and", and no page flashes
  // up holding a single word on its own.
  const ends = (g) => /[.?!,;:]$/.test(g.at(-1).text);
  const fits = (g, extra = 1) => g.length + extra <= maxWords + 1;
  for (let i = 0; i < groups.length - 1; i++) {
    const g = groups[i];
    const next = groups[i + 1];
    const tail = norm(g.at(-1).text);
    const touching = next[0].s - g.at(-1).e < pause;
    if (g.length > 1 && !ends(g) && touching && LEADING_WORDS.has(tail) && fits(next)) next.unshift(g.pop());
  }
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i].length > 1) continue;
    const prev = groups[i - 1];
    const next = groups[i + 1];
    const word = groups[i][0];
    if (prev && word.s - prev.at(-1).e < pause && fits(prev) && !ends(prev)) prev.push(...groups.splice(i, 1)[0]);
    else if (next && next[0].s - word.e < pause && fits(next) && !/[.?!]$/.test(word.text)) next.unshift(...groups.splice(i, 1)[0]);
  }

  return groups.map((g, i) => {
    const start = Math.max(0, g[0].s - 0.05);
    const nextStart = groups[i + 1] ? Math.max(0, groups[i + 1][0].s - 0.05) : duration;
    const end = Math.min(nextStart, g.at(-1).e + 0.45, duration);
    return { id: `g${i}`, in: r3(start), out: r3(Math.max(end, start + 0.2)), words: g };
  });
}

function titleSize(title) {
  const n = title.length;
  return n <= 18 ? 96 : n <= 32 ? 82 : n <= 48 ? 70 : 60;
}

function titleHtml(title, highlight) {
  const target = norm(highlight);
  let used = false;
  return title
    .split(/\s+/)
    .map((w) => {
      // Only the first match — repeated words ("$0.50, $0.50") shouldn't all light up.
      if (used || !target || norm(w) !== target) return esc(w);
      used = true;
      return `<span class="hl">${esc(w)}</span>`;
    })
    .join(" ");
}

/**
 * Compose the clip's HTML.
 * @param clip        { title, highlight, start, end, emphasis[] }
 * @param words       full-video transcript words [{ text, start, end }]
 * @param source      { width, height }
 * @param design      normalized design (see normalizeDesign)
 * @param videoSrc    media URL; "assets/clip.mp4" for renders, the source video URL for previews
 * @param mediaStart  where in videoSrc the clip begins (0 for a pre-cut file, clip.start for the source)
 * @param assetBase   URL prefix for fonts/ and vendor/
 * @param runtimeSrc  HyperFrames runtime script for browser previews (renders inject their own)
 */
/**
 * @param timeline  tightened playback: { duration, parts: [{ t, dur, src, mediaStart }], words: [{ text, s, e }] }.
 *                  Without it the clip plays as one continuous piece from `videoSrc`.
 * @param music     quiet bed under the talking: { src, volume, duration }
 */
export function buildCompositionHtml({ clip, words, source, design, videoSrc = "assets/clip.mp4", mediaStart = 0, assetBase = "assets/", runtimeSrc = null, focus = null, timeline = null, music = null, sourceEdited = false, faceBand = null }) {
  const d = normalizeDesign(design);
  const { width: W, height: H } = ASPECTS[d.aspect];
  const F = FONTS[d.font];
  const D = r3(timeline?.duration ?? clip.end - clip.start);
  const size = Math.round(BASE_CAPTION_PX * d.captionScale);
  const emphasis = new Set((clip.emphasis || []).map(norm));
  const parts = timeline?.parts?.length ? timeline.parts : [{ t: 0, dur: D, src: videoSrc, mediaStart }];

  // Word timings on the clip's own timeline (already re-timed when the clip was tightened).
  const clipWords = (timeline?.words || words.filter((w) => w.start >= clip.start - 0.05 && w.start < clip.end - 0.05).map((w) => ({ text: w.text, s: w.start - clip.start, e: w.end - clip.start })))
    .filter((w) => norm(w.text))
    .map((w, i) => {
      const s = r3(Math.max(0, w.s));
      return { id: `w${i}`, text: w.text, s, e: r3(Math.min(D, Math.max(w.e, s + 0.09))), emph: emphasis.has(norm(w.text)) };
    });
  const groups = d.captions ? groupCaptions(clipWords, D, { maxWords: d.maxWords }) : [];
  // Serif-emphasis captions give every phrase one accent word, even without marked emphasis.
  if (d.highlight === "serif") {
    for (const g of groups) {
      if (g.words.some((w) => w.emph)) continue;
      const i = fallbackEmphasis(g.words);
      if (i >= 0) g.words[i].emph = true;
    }
  }

  // Framing program, modeled on the creator's reference short: the shot pushes in on the valuable lines and pulls
  // back between them, changing on phrase boundaries every couple of seconds. "punchy" jumps, "gentle" glides.
  const moves = [];
  // Footage that already has its own jump cuts plays as it is: our zooms on top of it read as twitching.
  if (d.motion !== "none" && !sourceEdited) {
    const levels = d.motion === "punchy" ? { wide: 1, mid: 1.07, tight: 1.16 } : { wide: 1, mid: 1.04, tight: 1.09 };
    const minGap = d.motion === "punchy" ? 1.4 : 2.4;
    let last = -Infinity;
    let step = 0;
    for (const g of groups) {
      if (g.in < 0.6 || g.in > D - 0.8 || g.in - last < minGap) continue;
      const valuable = g.words.some((w) => w.emph || /\d|\$/.test(w.text));
      moves.push({ t: r3(g.in), scale: valuable ? levels.tight : step++ % 2 ? levels.wide : levels.mid });
      last = g.in;
    }
  }

  // Punch-in zooms on emphasized words, spaced out so they stay special.
  const punches = [];
  if (d.zoom && d.motion === "none") {
    for (const w of clipWords) {
      if (w.emph && w.s + 1.2 < D && (!punches.length || w.s - punches.at(-1) >= 3.5)) punches.push(w.s);
      if (punches.length >= 5) break;
    }
  }

  // Layout. "Framed" only makes sense when the source leaves room above and below it.
  const videoH = Math.round((W * source.height) / source.width);
  const layout = STYLES[d.style].layout === "framed" && videoH < H * 0.72 ? "framed" : "cover";
  const videoTop = Math.max(0, Math.round((H - videoH) / 2 - H * 0.02));
  const autoCaptionY = layout === "framed" ? Math.min(92, ((videoTop + videoH + 60 + size * 0.6) / H) * 100) : 64;
  // Full-screen styles move automatic captions off the speaker's face (lib/facezone.js); a height the creator set stays.
  const captionY = d.captionY ?? (layout === "cover" ? captionClearOfFaces(autoCaptionY, faceBand, ((size * 1.12 * 2) / H) * 100) : autoCaptionY);
  let titlePx = Math.round(titleSize(clip.title) * (W > H ? 0.85 : 1));
  if (layout === "framed") titlePx = Math.min(titlePx + 8, Math.round(videoTop * 0.36));
  // The premium look runs its headline a touch smaller.
  if (d.highlight === "reveal") titlePx = Math.round(titlePx * 0.88);
  const stroke = d.outline ? Math.max(2, Math.round(size * 0.1)) : 0;

  const display = (t) => (d.uppercase ? t.toUpperCase() : t).replace(/[.,;:]+$/, "");

  // Power words on top of the captions, placed on the words that say them. No key-point cards: the creator removed them.
  const talkEnd = D - (timeline?.tail || 0);
  const emph = d.pops ? placeEmphasis(clipWords, clip.emphasisPlan, talkEnd) : { pops: [], callouts: [] };
  const popFont = FONTS.inter;
  // The big words themselves are drawn behind the speaker by lib/behind.js after this composition is built; here
  // they only keep the key-point cards out of their way.
  const popsHtml = [].concat([])
    .map((p, i) => {
      const text = String(p.text).replace(/[.,;:!?]+$/, "");
      // One plain word shouts in capitals; amounts and phrases keep their own case.
      const shown = !/[\d$]/.test(text) && !/\s/.test(text) && text.length <= 12 ? text.toUpperCase() : text;
      const px = Math.round(Math.min(size * 2.6, (W * 0.84) / Math.max(3, shown.length * 0.62)));
      return `<div id="pop${i}" class="pop clip" data-start="${r3(p.s - 0.02)}" data-duration="${r3(p.e - p.s + 0.2)}" data-track-index="30"><span class="pop-word" style="font-size:${px}px">${esc(shown)}</span></div>`;
    })
    .join("\n      ");
  const captionsHtml = groups
    .map(
      (g, gi) =>
        `<div id="${g.id}" class="cap clip" data-start="${g.in}" data-duration="${r3(g.out - g.in)}" data-track-index="${2 + (gi % 4)}"><div class="cap-inner">${g.words
          .map((w) => `<span id="${w.id}" class="w${w.emph ? " emph" : ""}">${esc(display(w.text))}</span>`)
          .join("")}</div></div>`,
    )
    .join("\n      ");

  const data = {
    duration: D,
    layout,
    zoom: d.zoom,
    showTitle: d.showTitle,
    titleOut: d.titleOut > 0 && D > d.titleOut + 1 ? d.titleOut : null,
    progress: d.progress,
    punches,
    moves,
    motion: d.motion,
    // A premixed bed (renders, lib/bed.js) already carries its level, loop and ending, so it just plays.
    music: music?.premixed
      ? { premixed: true, volume: 1, loops: 1, loopSec: D, tail: null }
      : music ? { volume: r3(Math.min(0.8, music.volume ?? d.musicLevel)), loops: Math.max(1, Math.ceil(D / Math.max(4, music.duration || D))), loopSec: music.duration || D, tail: timeline?.tail ? { at: r3(D - timeline.tail + MUSIC_TAIL.hold), ramp: MUSIC_TAIL.ramp, level: music.volume ?? d.musicLevel } : null } : null,
    tail: timeline?.tail ? r3(timeline.tail) : 0,
    cuts: sourceEdited ? [] : parts.slice(1).map((p) => r3(p.t)),
    pops: [],
    captionPx: size,
    captionFloor: Math.round(size * 0.6),
    style: { text: d.textColor, accent: d.accentColor, emphasis: d.emphasisColor, highlight: d.highlight },
    groups: groups.map((g) => ({ id: g.id, in: g.in, words: g.words.map(({ id, s, e, emph }) => ({ id, s, e, emph })) })),
  };

  // Auto-frame: glide the crop to keep the subject in view (full-bleed layout only; framed shows the whole width).
  const frames = [];
  if (layout === "cover" && d.autoFrame && focus?.length) {
    for (const p of focus) {
      if (p.t < 0 || p.t > D) continue;
      const pos = objectPositionFor(p.x, source, { width: W, height: H });
      if (!frames.length || Math.abs(pos - frames.at(-1).pos) >= 2) frames.push({ t: r3(p.t), pos, ...(p.cut ? { cut: true } : {}) });
    }
  }
  const framePos = frames[0]?.pos ?? d.cropX;
  data.frames = frames;

  // Every kept piece of the tightened clip, played back to back.
  const piece = (part, id, track) =>
    `<video id="${id}" class="clip" src="${esc(part.src)}" data-start="${r3(part.t)}" data-duration="${r3(part.dur)}" data-media-start="${r3(part.mediaStart)}" data-track-index="${track}" muted playsinline`;
  const partAudio = parts
    .map((part, i) => `<audio id="pa${i}" src="${esc(part.src)}" data-start="${r3(part.t)}" data-duration="${r3(part.dur - (part.hold || 0))}" data-media-start="${r3(part.mediaStart)}" data-track-index="10" data-volume="${MIX_HEADROOM}"></audio>`)
    .join("\n      ");
  // A quiet instrumental bed under the voice, repeated if the track is shorter than the clip.
  const musicAudio = music?.premixed
    ? `<audio id="music" src="${esc(music.src)}" data-start="0" data-duration="${r3(D)}" data-media-start="0" data-track-index="20" data-volume="${MIX_HEADROOM}"></audio>`
    : music
    ? Array.from({ length: Math.max(1, Math.ceil(D / Math.max(4, music.duration || D))) }, (_, i) => {
        const at = i * (music.duration || D);
        // The level lives in the timeline fades below, not in data-volume: a volume tween replaces the gain.
        return `<audio id="music${i ? i : ""}" src="${esc(music.src)}" data-start="${r3(at)}" data-duration="${r3(Math.min(music.duration || D, D - at))}" data-media-start="0" data-track-index="${20 + i}" data-volume="1"></audio>`;
      }).join("\n      ")
    : "";
  // HyperFrames color grading (media-treatment) on the main footage, from the studied style.
  const grading = d.grade === "clean" ? ` data-color-grading="${esc(JSON.stringify(HF_STYLES.talk.grade))}"` : "";
  const leakBlock = d.leak
    ? `<div class="clip" id="open-leak" data-composition-id="organic-light-leak-overlay" data-composition-src="${assetBase}registry/organic-light-leak-overlay.html" data-start="0" data-duration="${r3(Math.min(1.8, D))}" data-width="${W}" data-height="${H}" data-track-index="5" style="position:absolute;inset:0;z-index:3;pointer-events:none"></div>`
    : "";
  const videoLayer =
    layout === "framed"
      ? `<div id="bg-wrap">${parts.map((part, i) => `${piece(part, `bg${i}`, 0)}></video>`).join("\n        ")}</div>
      <div id="bg-shade"></div>
      <div id="frame" style="top:${videoTop}px;height:${videoH}px"><div id="frame-punch">
        ${parts.map((part, i) => `${piece(part, `v${i}`, 1)}></video>`).join("\n        ")}
      </div></div>`
      : `<div id="video-zoom" style="--fx:${framePos}%"><div id="video-punch">
        ${parts.map((part, i) => `${piece(part, `v${i}`, 1)} style="object-position:var(--fx) 50%"${grading}></video>`).join("\n        ")}
      </div></div>
      ${d.highlight === "serif" ? "" : `<div id="shade-top"></div><div id="shade-bottom"></div>`}`;

  const titleBlock = d.showTitle
    ? `<div id="title-zone"><h1 id="title-card" class="${d.titleStyle}" style="font-size:${titlePx}px">${titleHtml(clip.title, clip.highlight)}</h1></div>`
    : "";

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <title>${esc(clip.title)}</title>
    ${runtimeSrc ? `<script src="${esc(runtimeSrc)}"></script>` : ""}
    <script src="${assetBase}vendor/gsap.min.js"></script>
    <style>
      @font-face { font-family: "Anton"; src: url("${assetBase}fonts/anton-latin-400-normal.woff2") format("woff2"); font-weight: 400; }
      @font-face { font-family: "Inter"; src: url("${assetBase}fonts/inter-latin-600-normal.woff2") format("woff2"); font-weight: 600; }
      @font-face { font-family: "Inter"; src: url("${assetBase}fonts/inter-latin-800-normal.woff2") format("woff2"); font-weight: 800; }
      @font-face { font-family: "Inter"; src: url("${assetBase}fonts/inter-latin-900-normal.woff2") format("woff2"); font-weight: 900; }
      @font-face { font-family: "Editorial Serif"; src: local("Didot Italic"), local("Didot-Italic"), local("Bodoni 72 Book Italic"), local("Georgia Italic"), local("Georgia-Italic"); font-style: italic; }
      /* The leaning headline face. Falls back to Inter, which the renderer slants itself. */
      @font-face { font-family: "Studio Italic"; src: local("HelveticaNeue-BoldItalic"), local("Helvetica Neue Bold Italic"), local("Helvetica-BoldOblique"), local("Helvetica Bold Oblique"), local("AvenirNext-DemiBoldItalic"); font-style: italic; font-weight: 700; }
      html, body { margin: 0; background: #000; }
      #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #000; font-family: "Inter", system-ui, sans-serif; }

      #video-zoom, #video-punch { position: absolute; inset: 0; transform-origin: 50% 42%; }
      #video-zoom video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      #shade-top { position: absolute; left: 0; right: 0; top: 0; height: 34%; background: linear-gradient(rgba(0,0,0,.62), rgba(0,0,0,0)); }
      #shade-bottom { position: absolute; left: 0; right: 0; bottom: 0; height: 48%; background: linear-gradient(rgba(0,0,0,0), rgba(0,0,0,.55)); }

      #bg-wrap { position: absolute; inset: -120px; filter: blur(56px) saturate(1.35) brightness(.55); }
      #bg-wrap video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      #bg-shade { position: absolute; inset: 0; background: radial-gradient(120% 70% at 50% 45%, rgba(0,0,0,0), rgba(0,0,0,.55)); }
      #frame { position: absolute; left: 0; width: ${W}px; overflow: hidden; box-shadow: 0 30px 80px rgba(0,0,0,.6); }
      #frame-punch { position: absolute; inset: 0; transform-origin: 50% 45%; }
      #frame video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }

      #title-zone { position: absolute; left: 0; right: 0; top: 0; display: flex; justify-content: center; box-sizing: border-box;
        ${layout === "framed" ? `height: ${videoTop}px; align-items: flex-end; padding: 0 70px ${Math.round(videoTop * 0.14)}px;` : `align-items: flex-start; padding: ${Math.round(H * 0.078)}px 70px 0;`} }
      #title-card { margin: 0; max-width: ${Math.min(940, W - 140)}px; text-align: center; line-height: 1.08; letter-spacing: -0.02em; font-weight: 900; color: ${d.textColor}; text-wrap: balance; }
      #title-card .hl { color: ${d.accentColor}; }
      #title-card.card { background: #fff; color: #0a0a0a; padding: 26px 40px 30px; border-radius: 30px; box-shadow: 0 18px 50px rgba(0,0,0,.45); transform: rotate(-1.5deg); }
      #title-card.card .hl { color: #0a0a0a; background: ${d.accentColor}; padding: 0 12px; border-radius: 12px; }
      #title-card.pill { font-weight: 800; background: rgba(10,10,14,.6); padding: 22px 38px; border-radius: 40px; border: 2px solid rgba(255,255,255,.14); }
      #title-card.plain { text-shadow: 0 4px 14px rgba(0,0,0,.55), 0 12px 40px rgba(0,0,0,.45); }
      ${F.italic ? `#title-card { font-family: ${F.css}; font-style: italic; font-weight: ${F.weight}; letter-spacing: -0.015em; }` : ""}

      .cap { position: absolute; left: 50px; right: 50px; top: ${r3(captionY)}%; transform: translateY(-50%); display: flex; justify-content: center; }
      .cap-inner { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; max-width: ${Math.round(W * 0.86)}px;
        gap: ${d.highlight === "pill" ? `${Math.round(size * 0.06)}px ${Math.round(size * 0.08)}px` : `${Math.round(size * 0.06)}px ${Math.round(size * 0.42)}px`}; }
      .w { display: inline-block; font-family: ${F.css}; font-weight: ${F.weight}; font-size: var(--cs, ${size}px); line-height: 1.12; color: ${d.textColor};
           ${F.italic ? "font-style: italic; letter-spacing: -0.012em;" : ""}
           ${stroke ? `-webkit-text-stroke: ${stroke}px #000; paint-order: stroke fill;` : ""}
           /* Without an outline the words still need to sit off the footage: a close shadow plus a soft one. */
           text-shadow: ${stroke ? "0 8px 28px rgba(0,0,0,.55)" : "0 4px 12px rgba(0,0,0,.5), 0 12px 38px rgba(0,0,0,.45)"}; ${d.highlight === "pill" ? `padding: ${Math.round(size * 0.06)}px ${Math.round(size * 0.22)}px ${Math.round(size * 0.1)}px; border-radius: ${Math.round(size * 0.26)}px;` : ""} }
      .w.emph { color: ${d.emphasisColor}; }
      ${
        d.highlight === "reveal"
          ? `.w { opacity: .5; letter-spacing: -0.01em; text-shadow: 0 2px 10px rgba(0,0,0,.45), 0 8px 30px rgba(0,0,0,.35); }
      #title-card { font-weight: ${F.weight}; letter-spacing: -0.025em; line-height: 1.1; }
      #title-card.plain { text-shadow: 0 2px 12px rgba(0,0,0,.45), 0 10px 36px rgba(0,0,0,.35); }
      #progress { height: 6px; background: rgba(255,255,255,.12); }
      #progress-fill { background: rgba(255,255,255,.85); }`
          : ""
      }
      ${
        d.highlight === "serif"
          ? `.w { text-shadow: 0 4px 24px rgba(0,0,0,.45); letter-spacing: -0.02em; }
      .w.emph { font-family: "Editorial Serif", Georgia, serif; font-style: italic; font-weight: 400; font-size: calc(var(--cs, ${size}px) * 1.38); letter-spacing: 0; }
      .cap-inner { align-items: baseline; }`
          : ""
      }

      .pop { position: absolute; left: 40px; right: 40px; top: ${r3(captionY)}%; transform: translateY(-50%); display: flex; justify-content: center; z-index: 6; pointer-events: none; }
      .pop-word { display: inline-block; font-family: ${popFont.css}; font-weight: 900; line-height: 1; letter-spacing: -0.035em; color: #fff; white-space: nowrap;
        text-shadow: 0 6px 18px rgba(0,0,0,.55), 0 18px 60px rgba(0,0,0,.5), 0 0 42px rgba(255,255,255,.18); }

      #progress { position: absolute; left: 0; right: 0; bottom: 0; height: 12px; background: rgba(255,255,255,.16); }
      #progress-fill { display: block; width: 100%; height: 100%; background: ${d.accentColor}; transform-origin: 0 50%; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="clip" data-start="0" data-width="${W}" data-height="${H}" data-duration="${D}" data-fps="30">
      ${videoLayer}
      ${leakBlock}
      ${partAudio}
      ${musicAudio}
      ${titleBlock}
      ${captionsHtml}
      ${popsHtml}
      ${d.progress ? `<div id="progress"><div id="progress-fill"></div></div>` : ""}
    </div>
    <script>
      (function () {
        const DATA = ${JSON.stringify(data).replace(/</g, "\\u003c")};
        const D = DATA.duration;
        const S = DATA.style;
        const tl = gsap.timeline({ paused: true });

        if (DATA.progress) tl.fromTo("#progress-fill", { scaleX: 0 }, { scaleX: 1, duration: D, ease: "none" }, 0);

        // Auto-frame pans: each move ends on its keyframe and never overlaps the previous one.
        (DATA.frames || []).forEach(function (f, i, all) {
          if (!i) return;
          var prev = all[i - 1];
          // A new speaker is a cut to them, not a pan across the room.
          if (f.cut) return tl.set("#video-zoom", { "--fx": f.pos + "%" }, f.t);
          var dur = Math.min(1.5, f.t - prev.t);
          tl.fromTo("#video-zoom", { "--fx": prev.pos + "%" }, { "--fx": f.pos + "%", duration: dur, ease: "sine.inOut", immediateRender: false }, f.t - dur);
        });

        // Framing moves: punchy styles jump on the phrase (seek-safe tl.set), gentle ones glide into it.
        if (DATA.moves.length) {
          gsap.set("#video-punch", { scale: 1 });
          DATA.moves.forEach(function (m) {
            if (DATA.motion === "punchy") tl.set("#video-punch", { scale: m.scale }, m.t);
            else tl.to("#video-punch", { scale: m.scale, duration: 0.7, ease: "power2.inOut" }, Math.max(0, m.t - 0.35));
          });
        }

        // The bed sits under the voice: every repeat is set to its level, with a fade in and out at the edges.
        if (DATA.music && !DATA.music.premixed) {
          for (var m = 0; m < DATA.music.loops; m++) gsap.set("#music" + (m ? m : ""), { volume: DATA.music.volume });
          tl.fromTo("#music", { volume: 0 }, { volume: DATA.music.volume, duration: 0.6, ease: "power1.out" }, 0);
          var lastBed = "#music" + (DATA.music.loops > 1 ? DATA.music.loops - 1 : "");
          var T = DATA.music.tail;
          if (T) {
            // Flat under the talking; once they're done the song comes up and plays out (every repeat, whichever is live).
            for (var k = 0; k < DATA.music.loops; k++) {
              tl.fromTo("#music" + (k ? k : ""), { volume: DATA.music.volume }, { volume: T.level, duration: T.ramp, ease: "sine.inOut", immediateRender: false }, T.at);
            }
          }
          var endLevel = T ? T.level : DATA.music.volume;
          tl.fromTo(lastBed, { volume: endLevel }, { volume: 0, duration: 0.9, ease: "power1.in", immediateRender: false }, Math.max(0, D - 0.9));
        }

        // The held last frame drifts in slowly under the music-only ending.
        if (DATA.tail && DATA.layout === "framed") {
          var from = DATA.cuts.length % 2 ? 1.12 : 1;
          tl.fromTo("#frame-punch", { scale: from }, { scale: from * 1.05, duration: DATA.tail, ease: "sine.inOut", immediateRender: false }, D - DATA.tail);
        }

        // Captions shrink to fit rather than wrap: at most two lines inside 86% of the frame, stepping the size down
        // to a floor. Only the size changes (never the timeline), so re-fitting once web fonts load is seek-safe.
        function fitCaptions() {
          document.querySelectorAll(".cap").forEach(function (cap) {
            var words = cap.querySelectorAll(".w");
            if (!words.length) return;
            for (var px = DATA.captionPx; px >= DATA.captionFloor; px -= 1) {
              cap.style.setProperty("--cs", px + "px");
              var lines = 0, lineTop = -1e9;
              for (var k = 0; k < words.length; k++) {
                var mid = words[k].offsetTop + words[k].offsetHeight / 2;
                if (mid > lineTop + px * 0.7) { lines++; lineTop = mid; }
              }
              if (lines <= 2) break;
            }
          });
        }
        fitCaptions();
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitCaptions);

        // Jump cuts inside the framed shot: alternate a slight punch-in at every cut so the join reads as an edit, not a glitch.
        if (DATA.layout === "framed" && DATA.cuts.length) {
          gsap.set("#frame-punch", { scale: 1 });
          DATA.cuts.forEach(function (t, i) { tl.set("#frame-punch", { scale: i % 2 ? 1 : 1.12 }, t); });
        }

        if (DATA.layout === "cover" && DATA.zoom) {
          tl.fromTo("#video-zoom", { scale: 1 }, { scale: 1.08, duration: D, ease: "none" }, 0);
          DATA.punches.forEach(function (t) {
            tl.fromTo("#video-punch", { scale: 1 }, { scale: 1.07, duration: 0.14, ease: "power2.out", immediateRender: false }, t);
            tl.fromTo("#video-punch", { scale: 1.07 }, { scale: 1, duration: 0.6, ease: "power2.inOut", immediateRender: false }, t + 0.5);
          });
        }

        if (DATA.showTitle) {
          if (S.highlight === "reveal") tl.fromTo("#title-card", { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7, ease: "power2.out" }, 0.1);
          else tl.fromTo("#title-card", { y: -50, scale: 0.88, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.5, ease: "back.out(1.7)" }, 0.05);
          if (DATA.titleOut) {
            tl.fromTo("#title-card", { y: 0, opacity: 1 }, { y: -30, opacity: 0, duration: 0.4, ease: "power2.in", immediateRender: false }, DATA.titleOut);
          }
        }

        DATA.groups.forEach(function (g) {
          if (S.highlight === "reveal") {
            // Premium: the phrase fades up in place, then each word brightens as it's spoken. No scale, no color.
            tl.fromTo("#" + g.id + " .cap-inner", { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: 0.2, ease: "power2.out" }, g.in);
            g.words.forEach(function (w) {
              tl.fromTo("#" + w.id, { opacity: 0.5 }, { opacity: 1, duration: 0.12, ease: "power1.out", immediateRender: false }, w.s);
            });
            return;
          }
          if (S.highlight === "serif") {
            // Editorial: phrases rise softly in; no karaoke color.
            tl.fromTo("#" + g.id + " .cap-inner", { y: 22, opacity: 0 }, { y: 0, opacity: 1, duration: 0.22, ease: "power2.out" }, g.in);
            return;
          }
          tl.fromTo("#" + g.id + " .cap-inner", { scale: 0.82, y: 26, opacity: 0 }, { scale: 1, y: 0, opacity: 1, duration: 0.14, ease: "back.out(2.2)" }, g.in);
          if (S.highlight === "none") return;
          g.words.forEach(function (w) {
            const sel = "#" + w.id;
            if (S.highlight === "pill") {
              tl.fromTo(sel, { backgroundColor: "rgba(0,0,0,0)" }, { backgroundColor: S.accent, duration: 0.06, immediateRender: false }, w.s);
              tl.fromTo(sel, { backgroundColor: S.accent }, { backgroundColor: "rgba(0,0,0,0)", duration: 0.1, immediateRender: false }, w.e);
            } else {
              const idle = w.emph ? S.emphasis : S.text;
              tl.fromTo(sel, { color: idle, scale: 1 }, { color: S.accent, scale: 1.08, duration: 0.07, ease: "power2.out", immediateRender: false }, w.s);
              tl.fromTo(sel, { color: S.accent, scale: 1.08 }, { color: idle, scale: 1, duration: 0.1, immediateRender: false }, w.e);
            }
          });
        });

        // Power words: the captions step aside, the word hits big with a small push on the picture, then gives the
        // captions back. Key-point cards slide in from the left and out again.
        (DATA.pops || []).forEach(function (p) {
          tl.fromTo(".cap", { opacity: 1 }, { opacity: 0, duration: 0.06, immediateRender: false }, p.s);
          tl.fromTo("#" + p.id + " .pop-word", { scale: 0.55, y: 26, opacity: 0 }, { scale: 1, y: 0, opacity: 1, duration: 0.26, ease: "back.out(2.6)", immediateRender: false }, p.s);
          tl.fromTo("#" + p.id + " .pop-word", { opacity: 1, scale: 1 }, { opacity: 0, scale: 1.06, duration: 0.16, ease: "power2.in", immediateRender: false }, p.e - 0.16);
          tl.fromTo(".cap", { opacity: 0 }, { opacity: 1, duration: 0.1, immediateRender: false }, p.e);
          var target = DATA.layout === "framed" ? "#frame" : "#root";
          if (DATA.layout === "framed") {
            tl.fromTo(target, { scale: 1 }, { scale: 1.035, duration: 0.14, ease: "power2.out", immediateRender: false }, p.s);
            tl.fromTo(target, { scale: 1.035 }, { scale: 1, duration: 0.5, ease: "power2.inOut", immediateRender: false }, p.s + 0.3);
          }
        });

        window.__timelines = window.__timelines || {};
        window.__timelines["clip"] = tl;
      })();
    </script>
  </body>
</html>
`;
  return { html, duration: D, width: W, height: H, groups: groups.length, words: clipWords.length };
}

/** Write a renderable composition folder: index.html plus fonts and GSAP (assets/clip.mp4 must already be there). */
export async function buildComposition(dir, options) {
  const result = buildCompositionHtml(options);
  await fs.mkdir(path.join(dir, "assets"), { recursive: true });
  await fs.cp(path.join(ASSETS, "fonts"), path.join(dir, "assets", "fonts"), { recursive: true });
  await fs.cp(path.join(ASSETS, "vendor"), path.join(dir, "assets", "vendor"), { recursive: true });
  await fs.cp(path.join(ASSETS, "registry"), path.join(dir, "assets", "registry"), { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), result.html);
  return result;
}
