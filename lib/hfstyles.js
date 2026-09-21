// Editing styles learned from the creator's studied reels (Study tab), rendered with HyperFrames:
// pacing, camera motion, transitions, color grade (HyperFrames media-treatment grading) and text.
// Each style names the reels it was modeled on; their measurements (lib/reelstyle.js) tune the numbers.

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

export const HF_STYLES = {
  cinematic: {
    label: "Cinematic smooth",
    kind: "edit",
    description: "Movie-like color, slow pushes and soft transitions — not too fast, not too many edits.",
    refs: ["ref_b871d4b4ed", "ref_6b8234ba27", "ref_4adf1aec63", "ref_07552b6cb3", "ref_716b50a364"],
    pacing: { shot: 2.6, min: 1.6, max: 4.2, snap: "bar" }, // cut on bar lines, let shots breathe
    camera: { push: 0.07, drift: 0.015, punch: 0 },
    transitions: { dissolveEvery: 3, dissolve: 0.5, flashes: false, lightLeaks: 1, openFade: 0.6, endFade: 0.9 },
    // Low-key and warm like xpeleu/ashtinvonge (brightness ~47, warm highlights): darker, crushed blacks,
    // saturation pulled back so it reads as film rather than phone footage.
    grade: {
      preset: "deep-contrast",
      intensity: 0.95,
      adjust: { exposure: -0.28, contrast: 0.14, highlights: -0.12, blacks: -0.18, temperature: 0.28, saturation: -0.14 },
      details: { vignette: 0.5, grain: 0.2 },
    },
    bars: false,
    text: { title: "soft", captions: "minimal" },
    audio: { source: 0, dialogue: false },
  },
  promo: {
    label: "Story promo",
    kind: "edit",
    description: "Best moments pieced into a story: hook line, beat cuts, flash hits and a title that sticks.",
    refs: ["ref_5e04711614", "ref_d4d0a54ee8", "ref_173e516b4d"],
    pacing: { shot: 1.0, min: 0.5, max: 2.2, snap: "beat" },
    camera: { push: 0.05, drift: 0, punch: 0.12 },
    transitions: { dissolveEvery: 0, dissolve: 0, flashes: true, monoHits: 1, lightLeaks: 0, openFade: 0, endFade: 0.5 },
    grade: {
      preset: "bright-pop",
      intensity: 0.7,
      adjust: { contrast: 0.18, saturation: 0.16, temperature: 0.06, shadows: -0.06 },
      details: { vignette: 0.22, grain: 0.06 },
    },
    bars: true,
    text: { title: "hook", captions: "bold" },
    audio: { source: 1, dialogue: true, duck: 0.22 },
  },
  talk: {
    label: "Editorial talk",
    kind: "clip",
    description: "Bright, clean talking clip: jump-cut punch-ins, word-by-word captions with italic serif emphasis.",
    refs: ["ref_ea9e868156"],
    pacing: { shot: 2.2, min: 1.4, max: 3.2, snap: "word" },
    camera: { push: 0.03, drift: 0, punch: 0.12 },
    transitions: { dissolveEvery: 0, dissolve: 0, flashes: false, lightLeaks: 1, openFade: 0, endFade: 0 },
    grade: {
      preset: "clean-studio",
      intensity: 0.8,
      adjust: { exposure: 0.04, contrast: 0.12, saturation: 0.05 },
      details: { vignette: 0.08, grain: 0 },
    },
    bars: false,
    text: { title: "none", captions: "editorial" },
    audio: { source: 1, dialogue: true },
  },
};

/**
 * The style with its numbers tuned by the measured reels it was modeled on (when they've been analyzed):
 * shot length follows their median shot, exposure follows their brightness, warmth follows their color.
 * @param id           HF_STYLES key
 * @param references   Study references with style.metrics (lib/study.js measuredReferences)
 */
export function resolveStyle(id, references = []) {
  const base = HF_STYLES[id] || HF_STYLES.cinematic;
  const style = structuredClone(base);
  style.id = HF_STYLES[id] ? id : "cinematic";
  const measured = references.filter((r) => base.refs.includes(r.id) && r.style?.metrics).map((r) => r.style.metrics);
  style.learnedFrom = references.filter((r) => base.refs.includes(r.id) && r.style?.metrics).map((r) => ({ id: r.id, who: r.info?.uploader || r.info?.title }));
  if (!measured.length) return style;

  // Hard-cut detection misses dissolves on dark footage, so only trust shot lengths from reels with real cuts.
  const shotLengths = measured.filter((m) => m.cuts >= 3).map((m) => m.medianShot);
  if (shotLengths.length) style.pacing.shot = Math.round(clamp(median(shotLengths), style.pacing.min, style.pacing.max) * 100) / 100;

  const luma = median(measured.map((m) => m.luma));
  const warmth = median(measured.map((m) => m.warmth));
  const contrast = median(measured.map((m) => m.contrast));
  const adjust = style.grade.adjust;
  adjust.exposure = Math.round(clamp((adjust.exposure ?? 0) + (luma - 90) / 700, -0.35, 0.25) * 100) / 100;
  adjust.temperature = Math.round(clamp((adjust.temperature ?? 0) * 0.5 + warmth / 45, -0.4, 0.45) * 100) / 100;
  adjust.contrast = Math.round(clamp((adjust.contrast ?? 0) * 0.5 + (contrast - 110) / 500, -0.1, 0.3) * 100) / 100;
  return style;
}

/** The HyperFrames `data-color-grading` value for a style (optionally scaled by the creator's strength slider). */
export function gradingAttr(style, strength = 1) {
  const g = style.grade;
  return JSON.stringify({ ...g, intensity: Math.round(clamp(g.intensity * strength, 0, 1) * 100) / 100 });
}

export function styleSummaries(references = []) {
  return Object.fromEntries(
    Object.keys(HF_STYLES).map((id) => {
      const s = resolveStyle(id, references);
      return [id, { label: s.label, kind: s.kind, description: s.description, learnedFrom: s.learnedFrom, shot: s.pacing.shot, refs: s.refs }];
    }),
  );
}
