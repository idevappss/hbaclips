// The edit vocabulary: color grades, transitions, shot effects, speed moves and text styles.
// Everything here is plain data plus small ffmpeg filter builders, so new looks are one entry away.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const f3 = (n) => (Math.round(n * 1000) / 1000).toString();

// ---------------------------------------------------------------------------
// Color grades

const NEUTRAL = {
  contrast: 1, saturation: 1, gamma: 1, brightness: 0, warmth: 0, tint: 0,
  shadows: [0, 0, 0], highlights: [0, 0, 0], fade: 0, vignette: 0, grain: 0, sharpen: 0, soften: 0, mono: 0,
};

export const LOOKS = {
  natural: { label: "Natural Pop", description: "True color with extra punch and crispness.", params: { contrast: 1.06, saturation: 1.18, sharpen: 0.35, vignette: 0.15 } },
  "teal-orange": { label: "Teal & Orange", description: "Blockbuster split tone: teal shadows, warm skin and highlights.", params: { contrast: 1.12, saturation: 1.12, warmth: 0.1, shadows: [-0.06, 0.01, 0.09], highlights: [0.08, 0.02, -0.07], vignette: 0.3, sharpen: 0.3 } },
  "moody-film": { label: "Moody Film", description: "Muted color, lifted matte blacks, film grain.", params: { contrast: 1.08, saturation: 0.82, gamma: 0.95, shadows: [0, 0.03, 0.05], highlights: [0.05, 0.02, -0.03], fade: 0.55, vignette: 0.45, grain: 0.45 } },
  "warm-vintage": { label: "Warm Vintage", description: "Faded warm tones, soft focus and heavy grain, like old film stock.", params: { contrast: 0.96, saturation: 0.88, warmth: 0.6, tint: 0.15, highlights: [0.04, 0.02, -0.04], fade: 0.7, vignette: 0.5, grain: 0.6, soften: 0.3 } },
  "cold-crisp": { label: "Cold Crisp", description: "Cool blue cast, hard contrast, razor sharp.", params: { contrast: 1.15, saturation: 0.92, warmth: -0.55, sharpen: 0.55, vignette: 0.2 } },
  bleach: { label: "Bleach Bypass", description: "Gritty, high-contrast, desaturated.", params: { contrast: 1.35, saturation: 0.42, gamma: 0.95, sharpen: 0.5, grain: 0.35, vignette: 0.35 } },
  noir: { label: "Noir B&W", description: "Deep black-and-white with grain and a heavy vignette.", params: { mono: 1, contrast: 1.4, gamma: 0.9, grain: 0.55, vignette: 0.6 } },
  "neon-night": { label: "Neon Night", description: "Saturated magenta and cyan, glowing nightlife energy.", params: { contrast: 1.15, saturation: 1.45, tint: 0.35, shadows: [0.02, -0.04, 0.12], highlights: [0.06, -0.02, 0.06], vignette: 0.45 } },
  "golden-hour": { label: "Golden Hour", description: "Sun-soaked warm glow with rich color.", params: { contrast: 1.05, saturation: 1.2, warmth: 0.75, highlights: [0.08, 0.04, -0.04], fade: 0.2, soften: 0.15, vignette: 0.3 } },
  "dream-haze": { label: "Dream Haze", description: "Soft, airy pastel with milky blacks.", params: { contrast: 0.88, saturation: 1.05, brightness: 0.03, tint: 0.1, fade: 0.8, soften: 0.6, grain: 0.15 } },
  gritty: { label: "Gritty Street", description: "Crunchy detail, muted color, grain — raw and aggressive.", params: { contrast: 1.25, saturation: 0.75, shadows: [0, 0.02, 0.03], sharpen: 0.8, grain: 0.5, vignette: 0.5 } },
  none: { label: "No grade", description: "Leave the footage as shot.", params: {} },
};

const lerp = (a, b, t) => a + (b - a) * t;

/** An ffmpeg filter chain (comma-joined, no labels) for a look at 0–1 intensity. Empty string for none. */
export function gradeChain(lookId, intensity = 1) {
  const look = LOOKS[lookId] || LOOKS.natural;
  const t = clamp(Number(intensity) || 0, 0, 1.5);
  const p = { ...NEUTRAL, ...look.params };
  const v = (key) => lerp(NEUTRAL[key], p[key], t);
  const tone = (key, i) => lerp(0, p[key][i], t);
  const chain = [];

  const contrast = v("contrast");
  const saturation = v("saturation") * (1 - clamp(v("mono"), 0, 1));
  const gamma = v("gamma");
  const brightness = v("brightness");
  if ([contrast - 1, saturation - 1, gamma - 1, brightness].some((x) => Math.abs(x) > 0.005)) {
    chain.push(`eq=contrast=${f3(contrast)}:saturation=${f3(saturation)}:gamma=${f3(gamma)}:brightness=${f3(brightness)}`);
  }

  const warmth = v("warmth");
  const tint = v("tint");
  const bal = {
    rs: tone("shadows", 0) + warmth * 0.03 + tint * 0.02, gs: tone("shadows", 1) - tint * 0.03, bs: tone("shadows", 2) - warmth * 0.03 + tint * 0.02,
    rm: warmth * 0.06 + tint * 0.025, gm: warmth * 0.01 - tint * 0.035, bm: -warmth * 0.06 + tint * 0.025,
    rh: tone("highlights", 0) + warmth * 0.04, gh: tone("highlights", 1) + warmth * 0.01, bh: tone("highlights", 2) - warmth * 0.04,
  };
  if (Object.values(bal).some((x) => Math.abs(x) > 0.004)) {
    chain.push(`colorbalance=${Object.entries(bal).map(([k, x]) => `${k}=${f3(clamp(x, -1, 1))}`).join(":")}`);
  }

  const fade = v("fade");
  if (fade > 0.01) chain.push(`curves=all='0/${f3(0.11 * fade)} 0.5/${f3(0.5 + 0.02 * fade)} 1/${f3(1 - 0.05 * fade)}'`);
  const soften = v("soften");
  if (soften > 0.01) chain.push(`gblur=sigma=${f3(soften * 1.6)}`);
  const sharpen = v("sharpen");
  if (sharpen > 0.01) chain.push(`unsharp=5:5:${f3(sharpen)}:5:5:0`);
  const vignette = v("vignette");
  if (vignette > 0.01) chain.push(`vignette=a=${f3(0.18 + 0.45 * vignette)}`);
  const grain = v("grain");
  if (grain > 0.01) chain.push(`noise=alls=${Math.round(grain * 22)}:allf=t`);
  return chain.join(",");
}

/** A look's parameters resolved at an intensity (the same values gradeChain uses), for other renderers. */
export function gradeParams(lookId, intensity = 1) {
  const look = LOOKS[lookId] || LOOKS.natural;
  const t = clamp(Number(intensity) || 0, 0, 1.5);
  const p = { ...NEUTRAL, ...look.params };
  const out = {};
  for (const key of Object.keys(NEUTRAL)) {
    out[key] = Array.isArray(NEUTRAL[key]) ? p[key].map((x) => +lerp(0, x, t).toFixed(4)) : +lerp(NEUTRAL[key], p[key], t).toFixed(4);
  }
  return out;
}

/** Closest CSS filter for resolved grade params. Split toning, fade, vignette and grain need overlays. */
export function cssFilter(g) {
  const parts = [
    `contrast(${f3(g.contrast)})`,
    `saturate(${f3(g.saturation * (1 - clamp(g.mono, 0, 1)))})`,
    `brightness(${f3((1 + g.brightness) * (1 + (1 - g.gamma) * 0.6))})`,
  ];
  if (g.warmth > 0.01) parts.push(`sepia(${f3(g.warmth * 0.3)})`);
  if (g.warmth < -0.01) parts.push(`hue-rotate(${f3(g.warmth * 12)}deg)`);
  if (Math.abs(g.tint) > 0.01) parts.push(`hue-rotate(${f3(g.tint * -10)}deg)`);
  if (g.soften > 0.01) parts.push(`blur(${f3(g.soften * 1.2)}px)`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Transitions. `xfade` is the ffmpeg transition; `edge` adds treatment to the frames either side of the cut.

export const TRANSITIONS = {
  cut: { label: "Hard cut", xfade: null, duration: 0, sfx: null, description: "Straight cut on the beat. The backbone of a hype edit." },
  flash: { label: "White flash", xfade: "fadewhite", duration: 0.2, sfx: "impact", description: "Blown-out white flash, hits like a snare." },
  "dip-black": { label: "Dip to black", xfade: "fadeblack", duration: 0.34, sfx: null, description: "Quick breath through black; good before a drop." },
  "whip-left": { label: "Whip pan ←", xfade: "smoothleft", duration: 0.2, sfx: "whoosh-short", edge: "blur", description: "Fast motion-blurred push left." },
  "whip-right": { label: "Whip pan →", xfade: "smoothright", duration: 0.2, sfx: "whoosh-short", edge: "blur", description: "Fast motion-blurred push right." },
  "whip-up": { label: "Whip pan ↑", xfade: "smoothup", duration: 0.2, sfx: "whoosh-short", edge: "blur", description: "Fast vertical whip, very Reels-native." },
  "whip-down": { label: "Whip pan ↓", xfade: "smoothdown", duration: 0.2, sfx: "whoosh-short", edge: "blur", description: "Fast vertical whip downward." },
  zoom: { label: "Zoom punch", xfade: "zoomin", duration: 0.24, sfx: "whoosh", description: "Punches through into the next shot." },
  glitch: { label: "Glitch", xfade: "pixelize", duration: 0.2, sfx: "glitch", edge: "rgb", description: "Digital break-up with RGB split." },
  blur: { label: "Blur swipe", xfade: "hblur", duration: 0.26, sfx: "whoosh-short", description: "Smeared horizontal blur into the next shot." },
  dissolve: { label: "Dissolve", xfade: "fade", duration: 0.45, sfx: null, description: "Soft crossfade for emotional or chill moments." },
  slide: { label: "Slide", xfade: "slideleft", duration: 0.26, sfx: "whoosh-short", description: "Clean slide, the next shot pushes the last out." },
  squeeze: { label: "Squeeze", xfade: "squeezeh", duration: 0.24, sfx: "whoosh-short", description: "Squashes through horizontally." },
  circle: { label: "Iris open", xfade: "circleopen", duration: 0.34, sfx: "whoosh", description: "Circle reveal from the center." },
  radial: { label: "Clock wipe", xfade: "radial", duration: 0.3, sfx: "whoosh-short", description: "Radial sweep." },
  slices: { label: "Slices", xfade: "hlslice", duration: 0.3, sfx: "whoosh-short", description: "Venetian-blind slice reveal." },
};

// ---------------------------------------------------------------------------
// Shot effects (applied inside a shot) and speed moves.

export const EFFECTS = {
  punch: "Quick zoom punch-in on the first beat, easing back. Adds impact.",
  "beat-zoom": "Zoom pulse on every beat inside the shot.",
  push: "Slow zoom in across the shot (Ken Burns push).",
  pull: "Slow zoom out across the shot.",
  shake: "Camera shake that hits at the start and decays, like an impact.",
  rumble: "Constant low handheld shake for the whole shot.",
  rgb: "RGB split / chromatic glitch burst at the start.",
  flash: "Brightness flash on the first frames.",
  strobe: "Brightness pulse on every beat.",
  echo: "Ghosting motion trails (frame blending).",
  invert: "Two-frame negative flash at the start.",
  letterbox: "Cinematic black bars top and bottom.",
  mono: "This shot only in black and white.",
  "blur-in": "Starts out of focus and snaps sharp.",
};

export const SPEEDS = {
  normal: "Real time.",
  slow: "Half speed slow motion (best on 60fps or smooth motion).",
  fast: "1.6× speed, for energy.",
  ramp: "Speed ramp: real time → sudden slow motion → back to real time.",
  "ramp-fast": "Speed ramp: slow build that rips into fast.",
  reverse: "Plays backwards.",
  stutter: "Repeats the first quarter-beat three times, then plays (the stutter/rewind effect).",
  freeze: "Plays, then freezes on the last frame for the end of the slot.",
};

// ---------------------------------------------------------------------------
// Text styles, rendered with libass. Font names resolve through macOS CoreText.

export const TEXT_STYLES = {
  slam: { label: "Impact Slam", font: "Impact", size: 150, bold: 0, color: "FFFFFF", outline: 7, outlineColor: "000000", shadow: 4, spacing: 1, anim: "slam", upper: true },
  clean: { label: "Clean Condensed", font: "Avenir Next Condensed Heavy", size: 118, bold: 0, color: "FFFFFF", outline: 0, outlineColor: "000000", shadow: 5, spacing: 0, anim: "rise", upper: true },
  minimal: { label: "Minimal Spaced", font: "Futura", size: 76, bold: 0, color: "FFFFFF", outline: 0, outlineColor: "000000", shadow: 2, spacing: 14, anim: "fade", upper: true },
  neon: { label: "Neon Glow", font: "Futura", size: 120, bold: 1, color: "FFFFFF", outline: 5, outlineColor: "accent", shadow: 0, spacing: 3, anim: "flicker", upper: true, glow: true },
  boxed: { label: "Boxed Label", font: "DIN Condensed", size: 110, bold: 1, color: "0A0A0A", outline: 14, outlineColor: "accent", shadow: 0, spacing: 1, anim: "slam", upper: true, box: true },
};

export const ACCENTS = ["FFE600", "FF2E63", "00E5FF", "7CFF4F", "FF7A00", "B388FF", "FFFFFF"];

/** One-line summaries for prompts and the UI. */
export function vocabulary() {
  return {
    looks: Object.fromEntries(Object.entries(LOOKS).map(([id, l]) => [id, l.description])),
    transitions: Object.fromEntries(Object.entries(TRANSITIONS).map(([id, t]) => [id, t.description])),
    effects: EFFECTS,
    speeds: SPEEDS,
    textStyles: Object.fromEntries(Object.entries(TEXT_STYLES).map(([id, t]) => [id, t.label])),
  };
}
