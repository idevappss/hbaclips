// Merge adapter: renders a Dope Clips edit plan (edits/timeline.js buildPlan output) with HyperFrames.
// The director decides the edit — shots, speeds, effects, transitions, look, text, captions, sound — and
// this module turns that plan into a HyperFrames composition for live preview and for rendering.
import fs from "node:fs/promises";
import path from "node:path";
import { FFMPEG, ROOT, run } from "./tools.js";
import { LOOKS, TEXT_STYLES } from "../edits/looks.js";

const r3 = (n) => Math.round(n * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** Deterministic pseudo-random in [0, 1) — renders must look the same on every frame seek. */
const rnd = (seed) => {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export const SFX_DIR = path.join(ROOT, "edits", "sfx");

/** Seconds of source a shot's speed parts consume, measured from shot.in. */
export function sourceSpan(parts) {
  return parts.reduce((max, p) => Math.max(max, p.freeze ? p.src : p.src + p.out * (p.speed || 1)), 0);
}

const resolveSource = (file) => (path.isAbsolute(file) ? file : path.join(ROOT, file));

// ---------------------------------------------------------------------------
// Staging media: one trimmed file per shot, plus reversed pieces and freeze stills.

/**
 * Cut every shot's source window into `dir`.
 * @param maxHeight  1920 for renders, ~540 for the live preview
 * @returns media map: media[i] = { file, offset }, media["i-k"] = { file, offset: 0 } (reversed) | { still }
 */
export async function stageSegments(plan, dir, { maxHeight = 1920, preview = false, signal, onProgress } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const scale = `scale=-2:'min(${maxHeight},ih)'`;
  const quality = preview ? ["-preset", "veryfast", "-crf", "27"] : ["-preset", "veryfast", "-crf", "16"];
  const media = {};

  for (const shot of plan.shots) {
    const src = resolveSource(shot.file);
    const pad = Math.min(0.1, shot.in);
    const span = sourceSpan(shot.parts) + 0.3;
    const name = `shot-${shot.index}.mp4`;
    await run(FFMPEG, [
      "-y", "-loglevel", "error", "-ss", r3(shot.in - pad).toString(), "-i", src, "-t", r3(span + pad).toString(),
      "-map", "0:v:0", "-map", "0:a:0?", "-vf", scale, "-c:v", "libx264", ...quality, "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", path.join(dir, name),
    ], { signal });
    media[shot.index] = { file: name, offset: r3(pad) };

    for (const [k, part] of shot.parts.entries()) {
      if (part.freeze) {
        const still = `still-${shot.index}-${k}.jpg`;
        await run(FFMPEG, ["-y", "-loglevel", "error", "-ss", r3(shot.in + part.src).toString(), "-i", src, "-frames:v", "1", "-vf", scale, "-q:v", "2", path.join(dir, still)], { signal });
        media[`${shot.index}-${k}`] = { still };
      } else if (part.reverse) {
        const file = `rev-${shot.index}-${k}.mp4`;
        const length = part.out * (part.speed || 1) + 0.05;
        await run(FFMPEG, [
          "-y", "-loglevel", "error", "-ss", r3(shot.in + part.src).toString(), "-i", src, "-t", r3(length).toString(),
          "-an", "-vf", `reverse,${scale}`, "-c:v", "libx264", ...quality, "-pix_fmt", "yuv420p", path.join(dir, file),
        ], { signal });
        media[`${shot.index}-${k}`] = { file, offset: 0 };
      }
    }
    onProgress?.((shot.index + 1) / plan.shots.length);
  }
  return media;
}

// ---------------------------------------------------------------------------
// Look → CSS

const NEUTRAL_GRADE = {
  contrast: 1, saturation: 1, gamma: 1, brightness: 0, warmth: 0, tint: 0,
  shadows: [0, 0, 0], highlights: [0, 0, 0], fade: 0, vignette: 0, grain: 0, soften: 0, mono: 0,
};

/** Look + intensity → resolved grade params (the same shape edits/looks.js gradeParams returns). */
function lookParams(lookId, intensity) {
  const look = LOOKS[lookId] || LOOKS.natural;
  const t = clamp(Number(intensity) || 0, 0, 1.5);
  const p = { ...NEUTRAL_GRADE, ...look.params };
  return Object.fromEntries(
    Object.entries(NEUTRAL_GRADE).map(([key, neutral]) => [key, Array.isArray(neutral) ? p[key].map((x) => lerp(0, x, t)) : lerp(neutral, p[key], t)]),
  );
}

/** Resolved grade params → a CSS filter plus overlay settings. `cssFilter` (from an edit-plan/1 grade) wins when given. */
function gradeCss(params, cssFilter = null) {
  const p = { ...NEUTRAL_GRADE, ...params };
  const filters = [
    `contrast(${r3(p.contrast)})`,
    `saturate(${r3(p.saturation * (1 - clamp(p.mono, 0, 1)) * (p.warmth < 0 ? 1 + p.warmth * 0.1 : 1))})`,
    `brightness(${r3((1 + p.brightness) * Math.pow(1 / (p.gamma || 1), 0.35))})`,
  ];
  if (p.warmth > 0.01) filters.push(`sepia(${r3(p.warmth * 0.32)})`);
  const hue = -p.warmth * (p.warmth > 0 ? 4 : 9) - p.tint * 14;
  if (Math.abs(hue) > 0.5) filters.push(`hue-rotate(${r3(hue)}deg)`);
  if (p.soften > 0.01) filters.push(`blur(${r3(p.soften * 1.1)}px)`);

  const tone = (arr) => arr.map((x) => clamp(Math.round(128 + x * 900), 0, 255));
  const [sr, sg, sb] = tone(p.shadows);
  const [hr, hg, hb] = tone(p.highlights);
  const toneStrength = Math.max(...p.shadows.map(Math.abs), ...p.highlights.map(Math.abs));

  return {
    filter: cssFilter || filters.join(" "),
    vignette: p.vignette > 0.01 ? r3(0.18 + 0.45 * p.vignette) : 0,
    fade: r3(p.fade),
    grain: r3(p.grain),
    tone: toneStrength > 0.004 ? { shadows: `rgb(${sr},${sg},${sb})`, highlights: `rgb(${hr},${hg},${hb})`, opacity: r3(clamp(toneStrength * 6, 0, 0.6)) } : null,
  };
}

const GRAIN_SVG = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 1.4 -0.2'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>`,
)}")`;

// ---------------------------------------------------------------------------
// Composition

/**
 * @param plan       edits/timeline.js buildPlan output
 * @param media      stageSegments result
 * @param mediaBase  URL prefix for staged files ("assets/segments/" for renders, a served URL for previews)
 * @param musicSrc   URL of the music file (plan.music.file staged or served), or null
 * @param sfxSrc     (name) => URL of an SFX file
 */
export function buildPlanHtml({ plan, media, mediaBase, musicSrc = null, sfxSrc, assetBase = "assets/", runtimeSrc = null }) {
  const W = plan.width;
  const H = plan.height;
  const D = r3(plan.length);
  const k = Math.min(W, H) / 1080;
  const accent = `#${String(plan.accent || "FFE600").replace(/^#/, "")}`;
  // edit-plan/1 (edits/contract.js) adds resolved motion, effect cues, grade, styles and audio automation.
  const v1 = plan.contract === "edit-plan/1";
  const grade = v1 && plan.grade?.params ? gradeCss(plan.grade.params, plan.grade.cssFilter) : gradeCss(lookParams(plan.look, plan.lookIntensity));
  const style = TEXT_STYLES[plan.textStyle] || TEXT_STYLES.slam;
  const cs = v1 ? plan.captionStyle || null : null;

  // Shots: an untimed wrapper per shot (transitions animate .shot, slow zooms .zoom, hits .hit); each
  // speed part is its own timed <video>, because HyperFrames plays media at one constant rate per element.
  const shotsHtml = plan.shots
    .map((shot) => {
      const t0 = r3(shot.slotStart - shot.pre);
      const masks = [shot.transition?.type === "radial" ? "mask-radial" : "", shot.transition?.type === "slices" ? "mask-slices" : ""].join(" ");
      let offset = 0;
      const parts = shot.parts
        .map((part, partIndex) => {
          const start = r3(t0 + offset);
          const dur = r3(part.out);
          offset += part.out;
          const special = media[`${shot.index}-${partIndex}`];
          const position = `object-position:${shot.focusX}% ${shot.reframe?.focusY != null ? r3(shot.reframe.focusY * 100) : 50}%`;
          if (special?.still) {
            return `<img class="clip media ${shot.frame}" src="${esc(mediaBase + special.still)}" data-start="${start}" data-duration="${dur}" style="${position}" alt="" />`;
          }
          const file = special?.file ?? media[shot.index].file;
          const mediaStart = special ? 0 : r3(media[shot.index].offset + part.src);
          const rate = clamp(part.speed || 1, 0.1, 5);
          const attrs = `src="${esc(mediaBase + file)}" data-start="${start}" data-duration="${dur}" data-media-start="${mediaStart}"${rate !== 1 ? ` data-playback-rate="${r3(rate)}"` : ""} muted playsinline`;
          const fg = `<video id="v${shot.index}-${partIndex}" class="media ${shot.frame}" ${attrs} data-track-index="${shot.index % 2}" style="${position}"></video>`;
          return shot.frame === "fit" ? `<video id="b${shot.index}-${partIndex}" class="media backdrop" ${attrs} data-track-index="${2 + (shot.index % 2)}"></video>${fg}` : fg;
        })
        .join("");
      const bars = shot.effects.includes("letterbox")
        ? `<div class="clip bars" data-start="${t0}" data-duration="${r3(shot.length)}"><i></i><i></i></div>`
        : "";
      return `<div class="shot ${masks}" id="sh${shot.index}" style="z-index:${shot.index + 1}"><div class="zoom" id="zm${shot.index}"><div class="hit" id="ht${shot.index}">${parts}</div></div>${bars}</div>`;
    })
    .join("\n        ");

  const textsHtml = plan.texts
    .map((text, i) => {
      const size = Math.round(style.size * k * (text.size || 1));
      return `<div id="txr${i}" class="clip txt-row" data-start="${r3(text.start)}" data-duration="${r3(text.end - text.start)}" style="top:${r3(text.y * 100)}%"><span id="tx${i}" class="txt ${plan.textStyle}" style="font-size:${size}px">${esc(style.upper ? text.text.toUpperCase() : text.text)}</span></div>`;
    })
    .join("\n      ");

  const captionsHtml = plan.captions
    .map(
      (cap, i) =>
        `<div class="clip cap-row" id="cp${i}" data-start="${r3(cap.start)}" data-duration="${r3(cap.end - cap.start)}"><span class="cap">${cap.words.map((w, j) => `<b id="cw${i}-${j}">${esc(w.text)}</b>`).join(" ")}</span></div>`,
    )
    .join("\n      ");

  // Audio: music (ducked under dialogue), the shots' own sound where the plan uses it, and SFX cues.
  const dialogue = plan.shots.filter((s) => s.useAudio);
  const audio = [];
  if (plan.music && musicSrc) {
    audio.push(`<audio id="music" src="${esc(musicSrc)}" data-start="0" data-duration="${D}" data-media-start="${r3(plan.music.start)}" data-track-index="20" data-volume="1"></audio>`);
  }
  for (const shot of dialogue) {
    audio.push(`<audio id="da${shot.index}" src="${esc(mediaBase + media[shot.index].file)}" data-start="${r3(shot.slotStart - shot.pre)}" data-duration="${r3(shot.length)}" data-media-start="${media[shot.index].offset}" data-track-index="21" data-volume="1"></audio>`);
  }
  plan.sfx.forEach((cue, i) => {
    if (!sfxSrc) return;
    audio.push(`<audio id="fx${i}" src="${esc(sfxSrc(cue.name))}" data-start="${r3(cue.at)}" data-duration="${r3(Math.min(cue.duration, D - cue.at))}" data-media-start="${r3(cue.offset || 0)}" data-track-index="${30 + i}" data-volume="${r3(clamp(cue.gain, 0, 1.5))}"></audio>`);
  });

  const data = {
    W,
    H,
    D,
    k: r3(k),
    accent,
    cues: v1 ? plan.effectCues || [] : null,
    volume: v1 ? plan.audio?.music?.volume?.points || null : null,
    textAnim: style.anim,
    musicGain: plan.music ? r3(plan.music.gain ?? 1) : null,
    ducks: dialogue.map((s) => [r3(s.slotStart - s.pre), r3(s.slotStart - s.pre + s.length)]),
    grain: grade.grain,
    shots: plan.shots.map((s) => ({
      i: s.index,
      t0: r3(s.slotStart - s.pre),
      len: r3(s.length),
      slot: r3(s.slotStart),
      pre: r3(s.pre),
      trans: s.transition?.type || "cut",
      d: r3(s.transition?.duration || 0),
      edgeIn: s.edgeIn,
      effects: s.effects,
      beats: s.beats,
      mono: s.effects.includes("mono") ? 1 : 0,
      motion: v1 && Array.isArray(s.motion) && s.motion.length ? s.motion : null,
      jitter: Array.from({ length: 64 }, (_, j) => [r3(rnd(s.index * 97 + j) * 2 - 1), r3(rnd(s.index * 131 + j * 7) * 2 - 1)]),
    })),
    texts: plan.texts.map((t, i) => ({ id: `tx${i}`, start: r3(t.start), end: r3(t.end) })),
    captions: plan.captions.map((c, i) => ({ words: c.words.map((w, j) => ({ id: `cw${i}-${j}`, s: w.s, e: w.e })) })),
  };

  const fontFaces = [...new Set(Object.values(TEXT_STYLES).map((s) => s.font))]
    .map((font) => `@font-face { font-family: "${font}"; src: local("${font}"); }`)
    .join("\n      ");

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <title>${esc(plan.title || "Dope edit")}</title>
    ${runtimeSrc ? `<script src="${esc(runtimeSrc)}"></script>` : ""}
    <script src="${assetBase}vendor/gsap.min.js"></script>
    <style>
      ${fontFaces}
      html, body { margin: 0; background: #000; }
      #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
      #grade { position: absolute; inset: 0; filter: ${grade.filter}; }
      .shot, .zoom, .hit { position: absolute; inset: 0; }
      .zoom, .hit { transform-origin: 50% 45%; }
      .shot.mask-radial { --sweep: 360deg; -webkit-mask-image: conic-gradient(#000 var(--sweep), transparent 0); mask-image: conic-gradient(#000 var(--sweep), transparent 0); }
      .shot.mask-slices { --slice: 10%; -webkit-mask-image: repeating-linear-gradient(90deg, #000 0 var(--slice), transparent var(--slice) 10%); mask-image: repeating-linear-gradient(90deg, #000 0 var(--slice), transparent var(--slice) 10%); }
      .media { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      .media.fit { object-fit: contain; }
      .media.backdrop { object-fit: cover; filter: blur(40px) brightness(0.55) saturate(1.3); transform: scale(1.15); }
      .bars i { position: absolute; left: 0; right: 0; height: 11%; background: #000; }
      .bars i:first-child { top: 0; }
      .bars i:last-child { bottom: 0; }
      #tone { position: absolute; inset: 0; pointer-events: none; ${grade.tone ? `background: linear-gradient(180deg, ${grade.tone.highlights}, ${grade.tone.shadows}); mix-blend-mode: soft-light; opacity: ${grade.tone.opacity};` : "display: none;"} }
      #fade { position: absolute; inset: 0; pointer-events: none; background: rgba(30, 30, 34, ${r3(grade.fade * 0.5)}); mix-blend-mode: lighten; }
      #vignette { position: absolute; inset: 0; pointer-events: none; background: radial-gradient(115% 85% at 50% 50%, rgba(0,0,0,0) 50%, rgba(0,0,0,${grade.vignette}) 100%); }
      #grain { position: absolute; inset: -60px; pointer-events: none; background-image: ${GRAIN_SVG}; background-size: 300px 300px; mix-blend-mode: overlay; opacity: ${r3(grade.grain * 0.45)}; }
      #flash, #dip { position: absolute; inset: 0; opacity: 0; pointer-events: none; }
      #flash { background: #fff; }
      #dip { background: #000; }
      .txt-row { position: absolute; left: 60px; right: 60px; transform: translateY(-50%); display: flex; justify-content: center; }
      .txt { display: inline-block; text-align: center; line-height: 1.02; font-family: "${style.font}", Impact, sans-serif; font-weight: ${style.bold ? 700 : 400};
        color: #${style.color}; letter-spacing: ${Math.round(style.spacing * k)}px;
        ${style.outline && !style.box ? `-webkit-text-stroke: ${Math.round(style.outline * k)}px ${style.outlineColor === "accent" ? accent : `#${style.outlineColor}`}; paint-order: stroke fill;` : ""}
        ${style.shadow ? `text-shadow: 0 ${Math.round(style.shadow * 2 * k)}px ${Math.round(style.shadow * 5 * k)}px rgba(0,0,0,.55);` : ""}
        ${style.glow ? `text-shadow: 0 0 ${Math.round(18 * k)}px ${accent}, 0 0 ${Math.round(42 * k)}px ${accent};` : ""}
        ${style.box ? `background: ${accent}; padding: ${Math.round(10 * k)}px ${Math.round(26 * k)}px ${Math.round(4 * k)}px;` : ""} }
      .cap-row { position: absolute; left: 60px; right: 60px; top: ${cs ? r3((cs.yPx / H) * 100) : 74}%; transform: translateY(-50%); display: flex; justify-content: center; }
      .cap { text-align: center; font-family: "${cs?.font || style.font}", Impact, sans-serif; font-size: ${cs ? cs.sizePx : Math.round(72 * k)}px; line-height: 1.12; color: ${cs?.color || "#fff"}; text-transform: uppercase;
        -webkit-text-stroke: ${cs ? cs.outlinePx : Math.round(7 * k)}px ${cs?.outlineColor || "#000"}; paint-order: stroke fill; text-shadow: 0 ${cs ? cs.shadowPx * 2 : 6}px 22px rgba(0,0,0,.5); }
      .cap b { font-weight: inherit; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="edit" data-start="0" data-width="${W}" data-height="${H}" data-duration="${D}" data-fps="${plan.fps || 30}">
      <div id="grade">
        ${shotsHtml}
      </div>
      <div id="tone"></div>
      <div id="fade"></div>
      <div id="vignette"></div>
      <div id="grain"></div>
      <div id="dip"></div>
      <div id="flash"></div>
      ${textsHtml}
      ${captionsHtml}
      ${audio.join("\n      ")}
    </div>
    <script>
      (function () {
        const P = ${JSON.stringify(data).replace(/</g, "\\u003c")};
        const W = P.W, H = P.H;
        const tl = gsap.timeline({ paused: true });
        const L = { immediateRender: false };
        const sh = (i) => "#sh" + i, zm = (i) => "#zm" + i, ht = (i) => "#ht" + i;
        const F = (s, o) => "blur(" + (o.b || 0) + "px) brightness(" + (o.br ?? 1) + ") invert(" + (o.inv || 0) + ") grayscale(" + s.mono + ") hue-rotate(" + (o.hue || 0) + "deg) saturate(" + (o.sat ?? 1) + ")";

        // ---- transitions (centered on the incoming shot's slot start) ----
        P.shots.forEach(function (s, idx) {
          if (idx === 0 || s.trans === "cut" || !s.d) return;
          const a = sh(P.shots[idx - 1].i), b = sh(s.i), d = s.d, t = s.slot - d / 2;
          const overlay = function (sel) {
            tl.fromTo(sel, { opacity: 0 }, { opacity: 1, duration: d / 2, ease: "power2.in", ...L }, t);
            tl.fromTo(sel, { opacity: 1 }, { opacity: 0, duration: d / 2, ease: "power2.out", ...L }, t + d / 2);
          };
          const move = function (outTo, inFrom, blur) {
            tl.fromTo(a, { x: 0, y: 0, filter: "blur(0px)" }, { ...outTo, filter: "blur(" + blur + "px)", duration: d, ease: "power3.in", ...L }, t);
            tl.fromTo(b, { ...inFrom, filter: "blur(" + blur + "px)" }, { x: 0, y: 0, filter: "blur(0px)", duration: d, ease: "power3.out", ...L }, t);
          };
          switch (s.trans) {
            case "flash": overlay("#flash"); break;
            case "dip-black": overlay("#dip"); break;
            case "whip-left": move({ x: -W }, { x: W }, 30); break;
            case "whip-right": move({ x: W }, { x: -W }, 30); break;
            case "whip-up": move({ y: -H }, { y: H }, 30); break;
            case "whip-down": move({ y: H }, { y: -H }, 30); break;
            case "slide": move({ x: -W }, { x: W }, 0); break;
            case "zoom":
              tl.fromTo(a, { scale: 1, opacity: 1 }, { scale: 1.9, opacity: 0, duration: d, ease: "power3.in", ...L }, t);
              tl.fromTo(b, { scale: 1.3, opacity: 0 }, { scale: 1, opacity: 1, duration: d, ease: "power3.out", ...L }, t);
              break;
            case "blur":
              tl.fromTo(a, { filter: "blur(0px)", opacity: 1 }, { filter: "blur(32px)", opacity: 0, duration: d, ease: "power2.in", ...L }, t);
              tl.fromTo(b, { filter: "blur(32px)", opacity: 0 }, { filter: "blur(0px)", opacity: 1, duration: d, ease: "power2.out", ...L }, t);
              break;
            case "dissolve":
              tl.fromTo(b, { opacity: 0 }, { opacity: 1, duration: d, ease: "sine.inOut", ...L }, t);
              break;
            case "squeeze":
              tl.fromTo(a, { scaleX: 1 }, { scaleX: 0, duration: d / 2, ease: "power2.in", ...L }, t);
              tl.set(b, { scaleX: 0 }, t);
              tl.fromTo(b, { scaleX: 0 }, { scaleX: 1, duration: d / 2, ease: "power2.out", ...L }, t + d / 2);
              break;
            case "circle":
              tl.fromTo(b, { clipPath: "circle(0% at 50% 50%)" }, { clipPath: "circle(82% at 50% 50%)", duration: d, ease: "power2.inOut", ...L }, t);
              break;
            case "radial":
              tl.fromTo(b, { "--sweep": "0deg" }, { "--sweep": "360deg", duration: d, ease: "none", ...L }, t);
              break;
            case "slices":
              tl.fromTo(b, { "--slice": "0%" }, { "--slice": "10%", duration: d, ease: "power1.inOut", ...L }, t);
              break;
            case "glitch": {
              const steps = [0, 1, 0.2, 1, 0.5, 1];
              steps.forEach(function (o, k) { tl.set(b, { opacity: o, x: (k % 2 ? -1 : 1) * W * 0.035 }, t + (d * k) / steps.length); });
              tl.set(b, { opacity: 1, x: 0 }, t + d);
              break;
            }
          }
        });

        // ---- shot effects ----
        P.shots.forEach(function (s) {
          const zoom = zm(s.i), hit = ht(s.i), fx = s.effects, t0 = s.t0, first = t0 + s.pre;
          tl.set(hit, { filter: F(s, {}) }, t0);

          if (s.motion) {
            // The plan's exact zoom/shake: [t, scale, x, y] samples from the shot start, linear in between.
            const m = s.motion;
            tl.set(zoom, { scale: m[0][1], x: m[0][2], y: m[0][3], transformOrigin: "50% 50%" }, t0);
            for (let k = 1; k < m.length; k++) {
              tl.fromTo(zoom, { scale: m[k - 1][1], x: m[k - 1][2], y: m[k - 1][3] }, { scale: m[k][1], x: m[k][2], y: m[k][3], duration: Math.max(0.001, m[k][0] - m[k - 1][0]), ease: "none", ...L }, t0 + m[k - 1][0]);
            }
          } else {
            if (fx.includes("push")) tl.fromTo(zoom, { scale: 1 }, { scale: 1.16, duration: s.len, ease: "none" }, t0);
            else if (fx.includes("pull")) tl.fromTo(zoom, { scale: 1.16 }, { scale: 1, duration: s.len, ease: "none" }, t0);

            if (fx.includes("beat-zoom")) {
              s.beats.forEach(function (b) {
                tl.fromTo(hit, { scale: 1 }, { scale: 1.08, duration: 0.05, ease: "power2.out", ...L }, t0 + b);
                tl.fromTo(hit, { scale: 1.08 }, { scale: 1, duration: 0.22, ease: "power2.out", ...L }, t0 + b + 0.05);
              });
            } else if (fx.includes("punch")) {
              const at = t0 + (s.beats[0] ?? s.pre);
              tl.fromTo(hit, { scale: 1 }, { scale: 1.18, duration: 0.08, ease: "power2.out", ...L }, at);
              tl.fromTo(hit, { scale: 1.18 }, { scale: 1, duration: 0.35, ease: "power2.out", ...L }, at + 0.08);
            }

            if (fx.includes("shake")) {
              for (let k = 0; k < 9; k++) {
                const amp = 42 * (1 - k / 9);
                tl.to(hit, { x: s.jitter[k][0] * amp, y: s.jitter[k][1] * amp, duration: 0.05, ease: "none", ...L }, first + k * 0.05);
              }
              tl.to(hit, { x: 0, y: 0, duration: 0.05, ease: "none", ...L }, first + 0.45);
            } else if (fx.includes("rumble")) {
              const n = Math.min(63, Math.floor(s.len / 0.06));
              for (let k = 0; k < n; k++) tl.to(hit, { x: s.jitter[k][0] * 11, y: s.jitter[k][1] * 11, duration: 0.06, ease: "none", ...L }, t0 + k * 0.06);
              tl.to(hit, { x: 0, y: 0, duration: 0.05, ease: "none", ...L }, t0 + n * 0.06);
            }
          }

          // Without plan cues, approximate the filter effects from the effect names.
          if (!P.cues) {
            if (fx.includes("blur-in")) tl.fromTo(hit, { filter: F(s, { b: 18 }) }, { filter: F(s, {}), duration: 0.4, ease: "power2.out", ...L }, first);
            if (fx.includes("flash")) tl.fromTo(hit, { filter: F(s, { br: 2.4 }) }, { filter: F(s, {}), duration: 0.25, ease: "power2.out", ...L }, first);
            if (fx.includes("strobe")) s.beats.forEach(function (b) { tl.fromTo(hit, { filter: F(s, { br: 1.9 }) }, { filter: F(s, {}), duration: 0.18, ease: "power2.out", ...L }, t0 + b); });
            if (fx.includes("invert")) {
              tl.set(hit, { filter: F(s, { inv: 1 }) }, first);
              tl.set(hit, { filter: F(s, {}) }, first + 2 / 30);
            }
            if (fx.includes("rgb")) {
              [[140, 2.6, 1], [0, 1, -1], [200, 3, 1], [0, 1, 0]].forEach(function (step, k) {
                tl.set(hit, { filter: F(s, { hue: step[0], sat: step[1] }), x: step[2] * W * 0.012 }, first + k * 0.045);
              });
            }
            if (s.edgeIn === "blur") tl.fromTo(hit, { filter: F(s, { b: 14 }) }, { filter: F(s, {}), duration: 0.14, ease: "power2.out", ...L }, s.slot);
          }
          // Frame blending isn't possible per element; echo is a soft ghost pulse on each beat.
          if (fx.includes("echo")) s.beats.forEach(function (b) { tl.fromTo(hit, { filter: F(s, { b: 4, br: 1.15 }) }, { filter: F(s, {}), duration: 0.3, ease: "power1.out", ...L }, t0 + b); });
        });

        // ---- effect cues with the plan's exact timings (edit-plan/1) ----
        (P.cues || []).forEach(function (c) {
          const s = P.shots.find(function (x) { return x.i === c.shot; });
          if (!s) return;
          const hit = ht(s.i), end = c.start + c.duration, params = c.params || {};
          switch (c.type) {
            case "flash":
            case "strobe":
              tl.set(hit, { filter: F(s, { br: 1 + (params.brightnessAdd || 0.3) * 2 }) }, c.start);
              tl.set(hit, { filter: F(s, {}) }, end);
              break;
            case "invert":
              tl.set(hit, { filter: F(s, { inv: 1 }) }, c.start);
              tl.set(hit, { filter: F(s, {}) }, end);
              break;
            case "blur-in": {
              let at = c.start;
              (params.steps || []).forEach(function (step) {
                tl.set(hit, { filter: F(s, { b: step.blurSigmaPx * 0.6 }) }, at);
                at = s.t0 + step.untilLocal;
              });
              tl.set(hit, { filter: F(s, {}) }, at);
              break;
            }
            case "motion-blur":
              tl.set(hit, { filter: F(s, { b: (params.blurSigmaPx || 30) * 0.45 }) }, c.start);
              tl.set(hit, { filter: F(s, {}) }, end);
              break;
            case "rgb-split": {
              const n = Math.max(2, Math.round(c.duration / 0.045));
              const shift = Math.abs((params.redShiftPx && params.redShiftPx[0]) || 12) * 0.6;
              for (let k = 0; k < n; k++) {
                tl.set(hit, { filter: F(s, { hue: k % 2 ? 0 : 160, sat: k % 2 ? 1 : 2.6 }), x: (k % 2 ? -1 : 1) * shift }, c.start + (k * c.duration) / n);
              }
              tl.set(hit, { filter: F(s, {}), x: 0 }, end);
              break;
            }
          }
        });

        // ---- text + captions ----
        // Text animations follow the timings in edits/contract.js so HyperFrames and ffmpeg renders match.
        P.texts.forEach(function (t) {
          const el = "#" + t.id, dur = Math.max(0.2, t.end - t.start), s0 = t.start;
          let out = Math.min(0.16, dur * 0.2);
          if (P.textAnim === "slam") {
            tl.fromTo(el, { scale: 1.65, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.09, ease: "power2.out" }, s0);
            tl.fromTo(el, { scale: 1 }, { scale: 1.04, duration: 0.07, ease: "sine.out", ...L }, s0 + 0.09);
            tl.fromTo(el, { scale: 1.04 }, { scale: 1, duration: 0.08, ease: "sine.in", ...L }, s0 + 0.16);
          } else if (P.textAnim === "rise") {
            tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.11, ease: "none" }, s0);
            tl.fromTo(el, { y: 46 * P.k }, { y: 0, duration: 0.2, ease: "power2.out" }, s0);
          } else if (P.textAnim === "flicker") {
            [[0, 0], [0.05, 1], [0.1, 0.44], [0.15, 1], [0.2, 0.62], [0.26, 1]].forEach(function (f) { tl.set(el, { opacity: f[1] }, s0 + f[0]); });
          } else {
            tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.22, ease: "none" }, s0);
            out = Math.max(0.2, dur * 0.2);
          }
          tl.fromTo(el, { opacity: 1 }, { opacity: 0, duration: Math.min(out, dur * 0.5), ease: "none", ...L }, t.end - Math.min(out, dur * 0.5));
        });
        P.captions.forEach(function (c) {
          c.words.forEach(function (w) {
            tl.fromTo("#" + w.id, { color: "#FFFFFF" }, { color: P.accent, duration: 0.04, ...L }, w.s);
            tl.fromTo("#" + w.id, { color: P.accent }, { color: "#FFFFFF", duration: 0.08, ...L }, Math.max(w.e, w.s + 0.05));
          });
        });

        // ---- grain motion, music ducking ----
        if (P.grain > 0) {
          const n = Math.floor(P.D * 15);
          for (let k = 0; k < n; k++) tl.set("#grain", { x: ((k * 37) % 60) - 30, y: ((k * 53) % 60) - 30 }, k / 15);
        }
        if (P.volume && P.volume.length && document.getElementById("music")) {
          // The plan's gain automation: fade in, duck under dialogue, fade out at the end.
          tl.set("#music", { volume: P.volume[0].gain }, 0);
          for (let k = 1; k < P.volume.length; k++) {
            const a = P.volume[k - 1], b = P.volume[k];
            tl.fromTo("#music", { volume: a.gain }, { volume: b.gain, duration: Math.max(0.001, b.t - a.t), ease: "none", ...L }, a.t);
          }
        } else if (P.musicGain !== null && document.getElementById("music")) {
          const g = P.musicGain, low = g * 0.3;
          tl.set("#music", { volume: g }, 0);
          P.ducks.forEach(function (w) {
            tl.fromTo("#music", { volume: g }, { volume: low, duration: 0.25, ...L }, Math.max(0, w[0] - 0.15));
            tl.fromTo("#music", { volume: low }, { volume: g, duration: 0.35, ...L }, w[1]);
          });
          tl.fromTo("#music", { volume: g }, { volume: 0, duration: Math.min(1, P.D * 0.1), ...L }, P.D - Math.min(1, P.D * 0.1));
        }

        window.__timelines = window.__timelines || {};
        window.__timelines["edit"] = tl;
      })();
    </script>
  </body>
</html>
`;
  return { html, width: W, height: H, duration: D };
}
