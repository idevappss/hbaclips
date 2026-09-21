// "Dope edits": the best-looking shots of a video cut to a music track, with beat-synced effects,
// composed as a HyperFrames page for rendering or live preview.
import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./tools.js";
import { ASPECTS } from "./compose.js";

const ASSETS = path.join(ROOT, "assets");
const HEX = /^#[0-9a-f]{6}$/i;

export const VIBES = {
  hype: {
    label: "Hype",
    description: "Crash zooms, white flashes on every cut, shake on the big hits.",
    grade: "contrast(1.14) saturate(1.28) brightness(1.02)",
  },
  cinematic: {
    label: "Cinematic",
    description: "Slow push-ins, dips to black, a filmic grade and slow-mo on the best shot.",
    grade: "contrast(1.12) saturate(0.88) sepia(0.12) brightness(0.96)",
  },
  smooth: {
    label: "Smooth",
    description: "Soft fades and gentle motion that lets the footage breathe.",
    grade: "contrast(1.05) saturate(1.08)",
  },
};

export const LENGTHS = [15, 30, 45];

/** Fill in and validate an edit design. */
export function normalizeEditDesign(input = {}) {
  const num = (value, min, max, fallback) => {
    const n = Number(value);
    return value !== undefined && value !== null && value !== "" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    aspect: ASPECTS[input.aspect] ? input.aspect : "9:16",
    vibe: VIBES[input.vibe] ? input.vibe : "hype",
    length: LENGTHS.includes(Number(input.length)) ? Number(input.length) : 30,
    title: String(input.title ?? "").trim().slice(0, 60),
    accentColor: HEX.test(input.accentColor || "") ? input.accentColor.toUpperCase() : "#FFFFFF",
    originalAudio: num(input.originalAudio, 0, 1, 0.25),
    musicVolume: num(input.musicVolume, 0, 1, 1),
    flash: typeof input.flash === "boolean" ? input.flash : true,
    shake: typeof input.shake === "boolean" ? input.shake : true,
    cropX: num(input.cropX, 0, 100, 50),
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const r3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Lay shots onto the timeline. Shot i plays from cuts[i] to cuts[i + 1] (the last one to `duration`).
 * Cinematic edits play their best shot in slow motion.
 * @returns [{ index, t, dur, mediaStart, rate, sourceLength }]
 */
export function planTimeline({ shots, cuts, duration, vibe }) {
  const count = Math.min(shots.length, cuts.length);
  const best = vibe === "cinematic" ? shots.slice(0, count).reduce((b, s, i) => ((s.score ?? 0) > (shots[b].score ?? 0) ? i : b), 0) : -1;
  return Array.from({ length: count }, (_, i) => {
    const t = r3(cuts[i]);
    const end = i + 1 < count ? cuts[i + 1] : duration;
    const dur = r3(Math.max(0.2, end - t));
    const rate = i === best ? 0.6 : 1;
    return { index: i, t, dur, mediaStart: r3(shots[i].start), rate, sourceLength: r3(dur * rate) };
  });
}

/**
 * @param timeline      from planTimeline
 * @param duration      total edit length (seconds)
 * @param beats         [{ t, strength }] beat times on the edit timeline, for shake hits (optional)
 * @param music         { src, volume } or null
 * @param design        normalized edit design
 * @param videoSrcFor   (item) => media URL for that shot
 * @param mediaStartFor (item) => where in that URL the shot begins
 */
export function buildEditHtml({ timeline, duration, beats = [], music, design, videoSrcFor, mediaStartFor, assetBase = "assets/", runtimeSrc = null }) {
  const d = normalizeEditDesign(design);
  const { width: W, height: H } = ASPECTS[d.aspect];
  const D = r3(duration);
  const vibe = VIBES[d.vibe];

  const shotsHtml = timeline
    .map((item) => {
      const media = `src="${esc(videoSrcFor(item))}" data-start="${item.t}" data-duration="${item.dur}" data-media-start="${r3(mediaStartFor(item))}"${item.rate !== 1 ? ` data-playback-rate="${item.rate}"` : ""}`;
      return `<div class="shot" id="s${item.index}"><div class="shot-inner"><video id="v${item.index}" ${media} data-track-index="${item.index % 2}" muted playsinline></video></div></div>`;
    })
    .join("\n        ");

  const originalAudio =
    d.originalAudio > 0
      ? timeline
          .map(
            (item) =>
              `<audio id="a${item.index}" src="${esc(videoSrcFor(item))}" data-start="${item.t}" data-duration="${item.dur}" data-media-start="${r3(mediaStartFor(item))}"${item.rate !== 1 ? ` data-playback-rate="${item.rate}"` : ""} data-track-index="11" data-volume="${d.originalAudio}"></audio>`,
          )
          .join("\n      ")
      : "";

  const data = {
    duration: D,
    vibe: d.vibe,
    flash: d.flash,
    shake: d.shake,
    hasTitle: Boolean(d.title),
    shots: timeline.map(({ index, t, dur }) => ({ index, t, dur })),
    hits: d.shake ? beats.filter((b) => b.strength >= 0.75 && b.t > 0.3 && b.t < D - 0.5).map((b) => r3(b.t)) : [],
    musicFade: music ? Math.max(0, D - 1.2) : null,
  };

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <title>${esc(d.title || "Edit")}</title>
    ${runtimeSrc ? `<script src="${esc(runtimeSrc)}"></script>` : ""}
    <script src="${assetBase}vendor/gsap.min.js"></script>
    <style>
      @font-face { font-family: "Anton"; src: url("${assetBase}fonts/anton-latin-400-normal.woff2") format("woff2"); font-weight: 400; }
      html, body { margin: 0; background: #000; }
      #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
      #grade { position: absolute; inset: -24px; filter: ${vibe.grade}; }
      .shot, .shot-inner { position: absolute; inset: 0; }
      .shot-inner { transform-origin: 50% 50%; }
      .shot video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: ${d.cropX}% 50%; }
      #vignette { position: absolute; inset: 0; pointer-events: none; background: radial-gradient(120% 90% at 50% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,${d.vibe === "cinematic" ? 0.6 : 0.35}) 100%); }
      #flash { position: absolute; inset: 0; background: #fff; opacity: 0; }
      #fade { position: absolute; inset: 0; background: #000; opacity: 0; }
      #title { position: absolute; left: 60px; right: 60px; top: 50%; transform: translateY(-50%); margin: 0; text-align: center;
        font-family: "Anton", sans-serif; font-weight: 400; font-size: ${Math.round(Math.min(W, H) * (d.title.length <= 12 ? 0.19 : d.title.length <= 22 ? 0.14 : 0.1))}px; line-height: 1.02;
        text-transform: uppercase; color: ${d.accentColor}; letter-spacing: 0.01em; text-wrap: balance;
        -webkit-text-stroke: 6px rgba(0,0,0,.85); paint-order: stroke fill; text-shadow: 0 10px 40px rgba(0,0,0,.6); opacity: 0; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="edit" data-start="0" data-width="${W}" data-height="${H}" data-duration="${D}" data-fps="30">
      <div id="grade">
        ${shotsHtml}
      </div>
      <div id="vignette"></div>
      <div id="flash"></div>
      ${d.title ? `<h1 id="title">${esc(d.title)}</h1>` : ""}
      <div id="fade"></div>
      ${music ? `<audio id="music" src="${esc(music.src)}" data-start="0" data-duration="${D}" data-track-index="10" data-volume="1"></audio>` : ""}
      ${originalAudio}
    </div>
    <script>
      (function () {
        const DATA = ${JSON.stringify(data).replace(/</g, "\\u003c")};
        const D = DATA.duration;
        const tl = gsap.timeline({ paused: true });

        tl.fromTo("#fade", { opacity: 1 }, { opacity: 0, duration: 0.35, ease: "power1.out" }, 0);

        DATA.shots.forEach(function (s, i) {
          const inner = "#s" + s.index + " .shot-inner";
          if (DATA.vibe === "hype") {
            tl.fromTo(inner, { scale: 1.28, rotation: i % 2 ? 1.2 : -1.2 }, { scale: 1.04, rotation: 0, duration: 0.38, ease: "expo.out" }, s.t);
            tl.fromTo(inner, { scale: 1.04 }, { scale: 1.1, duration: Math.max(0.1, s.dur - 0.38), ease: "none", immediateRender: false }, s.t + 0.38);
            if (DATA.flash && i > 0) tl.fromTo("#flash", { opacity: 0.8 }, { opacity: 0, duration: 0.14, ease: "power2.out", immediateRender: false }, s.t);
          } else if (DATA.vibe === "cinematic") {
            tl.fromTo(inner, { scale: 1.02 }, { scale: 1.12, duration: s.dur, ease: "none" }, s.t);
            if (i > 0 && i % 3 === 0) {
              tl.fromTo("#fade", { opacity: 0.9 }, { opacity: 0, duration: 0.45, ease: "power2.out", immediateRender: false }, s.t);
            } else if (DATA.flash && i > 0) {
              tl.fromTo("#flash", { opacity: 0.25 }, { opacity: 0, duration: 0.25, ease: "power1.out", immediateRender: false }, s.t);
            }
          } else {
            tl.fromTo(inner, { scale: 1.06, opacity: i > 0 ? 0.001 : 1 }, { scale: 1, opacity: 1, duration: Math.min(0.5, s.dur), ease: "power2.out" }, s.t);
          }
        });

        DATA.hits.forEach(function (t) {
          tl.fromTo("#grade", { x: -18, y: 8 }, { x: 0, y: 0, duration: 0.3, ease: "elastic.out(1, 0.35)", immediateRender: false }, t);
        });

        if (DATA.hasTitle) {
          tl.fromTo("#title", { opacity: 0, scale: 1.35 }, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2)" }, 0.15);
          tl.fromTo("#title", { opacity: 1, scale: 1 }, { opacity: 0, scale: 0.92, duration: 0.3, ease: "power2.in", immediateRender: false }, Math.min(2.2, D * 0.4));
        }

        tl.fromTo("#fade", { opacity: 0 }, { opacity: 1, duration: 0.4, ease: "power1.in", immediateRender: false }, Math.max(0, D - 0.4));
        if (DATA.musicFade !== null) tl.fromTo("#music", { volume: 1 }, { volume: 0, duration: D - DATA.musicFade, ease: "none", immediateRender: false }, DATA.musicFade);

        window.__timelines = window.__timelines || {};
        window.__timelines["edit"] = tl;
      })();
    </script>
  </body>
</html>
`;
  return { html, width: W, height: H, duration: D };
}

/** Write a renderable edit folder: index.html plus fonts and GSAP (shot files and music must already be in assets/). */
export async function writeEditComposition(dir, options) {
  const result = buildEditHtml(options);
  await fs.mkdir(path.join(dir, "assets"), { recursive: true });
  await fs.cp(path.join(ASSETS, "fonts"), path.join(dir, "assets", "fonts"), { recursive: true });
  await fs.cp(path.join(ASSETS, "vendor"), path.join(dir, "assets", "vendor"), { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), result.html);
  return result;
}
