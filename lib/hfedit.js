// Composes a planned edit (lib/hfplan.js) as a HyperFrames page. The footage gets HyperFrames color grading
// (media-treatment `data-color-grading`); camera motion uses the registry's yt-camera-move and camera-shake
// helpers; flash cuts and light leaks mount the registry's editorial-flash-overlay and organic-light-leak-overlay
// blocks (vendored in assets/registry/).
import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./tools.js";
import { ASPECTS } from "./compose.js";
import { normalizeHfDesign } from "./hfplan.js";
import { objectPositionFor } from "./subject.js";

const ASSETS = path.join(ROOT, "assets");
const DISSOLVE = 0.5;
const FLASH_SLOT = 0.8; // the flash block peaks at 58% of its slot
const LEAK_SLOT = 2.2;

const r3 = (n) => Math.round(n * 1000) / 1000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Short caption chunks for a spoken line: a word or two for bold styles, a phrase for editorial ones. */
function chunkWords(words, maxWords, maxSpan) {
  const groups = [];
  let cur = [];
  for (const w of words) {
    const prev = cur.at(-1);
    if (prev && (w.s - prev.e > 0.35 || w.e - cur[0].s > maxSpan || cur.length >= maxWords)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
    if (/[.?!,]$/.test(w.text)) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** Words worth an accent: numbers, money, and the longest word of a chunk. */
function accentIndex(group) {
  const numeric = group.findIndex((w) => /\d|\$/.test(w.text));
  if (numeric >= 0) return numeric;
  let best = -1;
  group.forEach((w, i) => {
    if (w.text.replace(/\W/g, "").length >= 6 && (best < 0 || w.text.length > group[best].text.length)) best = i;
  });
  return best;
}

/**
 * @param plan           from buildHfPlan
 * @param design         edit design (normalizeHfDesign)
 * @param videoSrcFor    (segment) => media URL for that segment
 * @param mediaStartFor  (segment) => where in that URL the segment starts
 * @param music          { src, start } or null
 */
export function buildHfEditHtml({ plan, design, videoSrcFor, mediaStartFor, music = null, assetBase = "assets/", runtimeSrc = null }) {
  const d = normalizeHfDesign(design);
  const { width: W, height: H } = ASPECTS[d.aspect];
  const D = r3(plan.duration);
  const style = plan.style;
  const segs = plan.segments;

  const baseGrade = { ...style.grade, intensity: r3(clamp(style.grade.intensity * d.strength, 0, 1)) };
  const grade = JSON.stringify(baseGrade);
  const monoGrade = JSON.stringify({ ...baseGrade, adjust: { ...baseGrade.adjust, saturation: -1, contrast: r3((baseGrade.adjust.contrast || 0) + 0.15) } });

  // Transitions ease off as the pace relaxes: longer dissolves, softer flashes, gentler punch-ins.
  const dissolve = { relaxed: 0.9, balanced: 0.7, energetic: DISSOLVE }[plan.pace] ?? DISSOLVE;
  const flashSlot = { relaxed: 1.2, balanced: 1.1, energetic: FLASH_SLOT }[plan.pace] ?? FLASH_SLOT;
  const punch = {
    scale: r3((style.camera.punch || 0) * ({ relaxed: 0.45, balanced: 0.65, energetic: 1 }[plan.pace] ?? 1)),
    dur: { relaxed: 0.95, balanced: 0.75, energetic: 0.45 }[plan.pace] ?? 0.45,
    ease: plan.pace === "energetic" || !plan.pace ? "expo.out" : "power3.out",
  };

  const shots = segs.map((s, i) => {
    const tail = segs[i + 1]?.transition === "dissolve" ? dissolve : 0;
    return { ...s, i, vdur: r3(Math.min(D - s.t, s.dur + tail)) };
  });

  // Each shot's crop centers its subject (auto-frame), or sits where the creator put it.
  const framing = (s) => (d.autoFrame && s.focusX != null ? objectPositionFor(s.focusX, plan.source, { width: W, height: H }) : d.cropX);

  const shotsHtml = shots
    .map((s) => {
      const media = `src="${esc(videoSrcFor(s))}" data-start="${s.t}" data-duration="${s.vdur}" data-media-start="${r3(mediaStartFor(s))}"${s.rate !== 1 ? ` data-playback-rate="${s.rate}"` : ""}`;
      return `<div class="shot" id="sh${s.i}" style="z-index:${s.i + 1}">
        <div class="camera-shake-frame"><div class="camera-shake-rig" id="rig${s.i}" data-layout-allow-overflow><div class="move" id="mv${s.i}" data-layout-allow-overflow>
          <video id="v${s.i}" class="clip" ${media} data-track-index="${s.i % 2}" muted playsinline style="object-position:${framing(s)}% 50%" data-color-grading="${esc(s.fx === "mono" ? monoGrade : grade)}"></video>
        </div></div></div>
      </div>`;
    })
    .join("\n      ");

  // Registry overlay blocks, one mount per cut.
  const overlays = [];
  shots.forEach((s) => {
    if (!s.i) return;
    if (s.transition === "flash") {
      const start = r3(Math.max(0, s.t - flashSlot * 0.58));
      overlays.push(
        `<div class="clip fx" id="fl${s.i}" data-composition-id="editorial-flash-overlay" data-composition-src="${assetBase}registry/editorial-flash-overlay.html" data-start="${start}" data-duration="${r3(Math.min(flashSlot, D - start))}" data-width="${W}" data-height="${H}" data-track-index="40"></div>`,
      );
    }
    if (s.transition === "leak") {
      const start = r3(Math.max(0, s.t - LEAK_SLOT * 0.4));
      overlays.push(
        `<div class="clip fx" id="lk${s.i}" data-composition-id="organic-light-leak-overlay" data-composition-src="${assetBase}registry/organic-light-leak-overlay.html" data-start="${start}" data-duration="${r3(Math.min(LEAK_SLOT, D - start))}" data-width="${W}" data-height="${H}" data-track-index="41"></div>`,
      );
    }
  });

  // Captions on spoken lines.
  const captionMode = d.captions ? style.text.captions : "none";
  const caps = [];
  if (captionMode !== "none") {
    shots
      .filter((s) => s.kind === "line" && s.words?.length)
      .forEach((s) => {
        const groups = chunkWords(s.words, captionMode === "bold" ? 2 : captionMode === "minimal" ? 1 : 3, captionMode === "bold" ? 0.9 : 1.4);
        groups.forEach((g, gi) => {
          const start = r3(s.t + Math.max(0, g[0].s - 0.04));
          const nextStart = groups[gi + 1] ? s.t + groups[gi + 1][0].s - 0.04 : s.t + s.dur;
          const end = r3(Math.min(nextStart, s.t + g.at(-1).e + 0.35, s.t + s.dur));
          if (end - start < 0.12) return;
          const accent = accentIndex(g);
          caps.push({
            id: `c${caps.length}`,
            start,
            dur: r3(end - start),
            html: g
              .map((w, wi) => {
                const text = esc(captionMode === "bold" ? w.text.replace(/[.,;:!?]+$/, "").toUpperCase() : captionMode === "minimal" ? w.text.replace(/[.,;:!?]+$/, "").toLowerCase() : w.text);
                return `<span class="w${wi === accent ? " em" : ""}">${text}</span>`;
              })
              .join(" "),
          });
        });
      });
  }
  const capsHtml = caps
    .map((c, i) => `<div class="cap clip ${captionMode}" id="${c.id}" data-start="${c.start}" data-duration="${c.dur}" data-track-index="${50 + (i % 4)}"><div class="cap-in">${c.html}</div></div>`)
    .join("\n      ");

  // Title in the style's voice: a soft lowercase card for cinematic, a hook that stays up for promos.
  // An empty title falls back to the plan's own (a promo's hook title).
  const titleText = d.title || plan.title || "";
  const titleMode = titleText ? (style.text.title === "hook" ? "hook" : "soft") : "none";
  const titleWords = titleText.split(/\s+/);
  const titleHtml =
    titleMode === "hook"
      ? `<h1 id="title" class="hook">${titleWords.length > 1 ? `${esc(titleWords.slice(0, -1).join(" "))} <em>${esc(titleWords.at(-1))}</em>` : `<em>${esc(titleText)}</em>`}</h1>`
      : titleMode === "soft"
        ? `<h1 id="title" class="soft">${esc(titleText)}</h1>`
        : "";

  // Audio: music ducks under spoken lines; without music the shots keep their own sound.
  const lines = shots.filter((s) => s.kind === "line");
  const audio = [];
  // The song comes in when the opening line ends (musicAt), on its first bar (music.start).
  const musicAt = plan.musicAt || 0;
  if (music) audio.push(`<audio id="music" src="${esc(music.src)}" data-start="${musicAt}" data-duration="${r3(D - musicAt)}" data-media-start="${r3(music.start || 0)}" data-track-index="20" data-volume="1"></audio>`);
  shots.forEach((s) => {
    const spoken = s.kind === "line";
    if (!spoken && music) return;
    const volume = spoken ? d.originalAudio : 0.85;
    if (volume <= 0) return;
    audio.push(`<audio id="au${s.i}" src="${esc(videoSrcFor(s))}" data-start="${s.t}" data-duration="${r3(s.dur)}" data-media-start="${r3(mediaStartFor(s))}"${s.rate !== 1 ? ` data-playback-rate="${s.rate}"` : ""} data-track-index="${30 + s.i}" data-volume="${r3(volume)}"></audio>`);
  });

  // Only the active title's tweens are emitted, from a set baseline, so seeks are stable and lint stays clean.
  const titleOut = titleMode === "hook" ? r3(D - 0.35) : r3(Math.min(3.4, D * 0.4));
  const titleScript =
    titleMode === "hook"
      ? `gsap.set("#title", { opacity: 0, scale: 1.25 });
        tl.fromTo("#title", { opacity: 0, scale: 1.25 }, { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(2)", immediateRender: false }, 0.12);
        tl.fromTo("#title", { opacity: 1 }, { opacity: 0, duration: 0.3, ease: "power2.in", immediateRender: false }, ${titleOut});`
      : titleMode === "soft"
        ? `gsap.set("#title", { opacity: 0, y: 28, filter: "blur(18px)" });
        tl.fromTo("#title", { opacity: 0, y: 28, filter: "blur(18px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.9, ease: "power3.out", immediateRender: false }, 0.35);
        tl.fromTo("#title", { opacity: 1, filter: "blur(0px)" }, { opacity: 0, filter: "blur(10px)", duration: 0.6, ease: "power2.in", immediateRender: false }, ${titleOut});`
        : "";

  const barPx = d.bars ? Math.round(W >= H ? (H - W / 2.39) / 2 : H * 0.085) : 0;
  const titlePx = Math.round(Math.min(W, H) * (titleMode === "hook" ? (titleText.length <= 14 ? 0.12 : 0.09) : 0.06));
  const capPx = { bold: Math.round(Math.min(W, H) * 0.115), minimal: Math.round(Math.min(W, H) * 0.042), editorial: Math.round(Math.min(W, H) * 0.075) }[captionMode] || 0;

  const data = {
    duration: D,
    width: W,
    camera: style.camera,
    shake: style.camera.punch ? "hits" : "float",
    openFade: style.transitions.openFade || 0,
    endFade: style.transitions.endFade || 0,
    dissolve,
    punch,
    musicIn: music && musicAt ? musicAt : null,
    shots: shots.map((s) => {
      // Camera-shake hits follow the pace: strong beats when energetic, only the biggest when balanced, none when relaxed.
      const hitStrength = { energetic: 0.7, balanced: 0.88, relaxed: 2 }[plan.pace] ?? 0.7;
      const hits = (plan.beats || []).filter((b) => b.t > s.t + 0.15 && b.t < s.t + s.dur - 0.45 && b.strength >= hitStrength);
      return { i: s.i, t: s.t, dur: s.dur, vdur: s.vdur, kind: s.kind, transition: s.transition, punch: s.fx === "punch", hit: hits.length ? hits.sort((a, b) => b.strength - a.strength)[0].t : null };
    }),
    caps: caps.map((c) => ({ id: c.id, start: c.start, dur: c.dur })),
    captionMode,
    // Lines after the music has come in duck it; the opening line plays before the song starts.
    ducks: music ? lines.filter((s) => s.t >= musicAt - 0.01).map((s) => ({ t: s.t, end: r3(s.t + s.dur) })) : [],
    musicFade: music ? r3(Math.max(0, D - 1.1)) : null,
  };

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <title>${esc(titleText || style.label)}</title>
    ${runtimeSrc ? `<script src="${esc(runtimeSrc)}"></script>` : ""}
    <script src="${assetBase}vendor/gsap.min.js"></script>
    <script src="${assetBase}registry/camera-shake.js"></script>
    <script src="${assetBase}registry/yt-camera-move.js"></script>
    <style>
      @font-face { font-family: "Anton"; src: url("${assetBase}fonts/anton-latin-400-normal.woff2") format("woff2"); font-weight: 400; }
      @font-face { font-family: "Inter"; src: url("${assetBase}fonts/inter-latin-600-normal.woff2") format("woff2"); font-weight: 600; }
      @font-face { font-family: "Inter"; src: url("${assetBase}fonts/inter-latin-800-normal.woff2") format("woff2"); font-weight: 800; }
      @font-face { font-family: "Inter"; src: url("${assetBase}fonts/inter-latin-900-normal.woff2") format("woff2"); font-weight: 900; }
      @font-face { font-family: "Editorial Serif"; src: local("Didot Italic"), local("Didot-Italic"), local("Bodoni 72 Book Italic"), local("Georgia Italic"), local("Georgia-Italic"); font-style: italic; }
      html, body { margin: 0; background: #000; }
      #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #000; font-family: "Inter", system-ui, sans-serif; }
      .shot { position: absolute; inset: 0; }
      .camera-shake-frame { position: absolute; inset: 0; overflow: hidden; }
      .camera-shake-rig { position: absolute; inset: 0; transform-style: preserve-3d; will-change: transform; }
      .camera-shake-rig > * { transform-style: preserve-3d; }
      .move { position: absolute; inset: 0; transform-origin: 50% 50%; }
      .move video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: ${d.cropX}% 50%; }
      .fx { position: absolute; inset: 0; z-index: 600; pointer-events: none; }
      .bar { position: absolute; left: 0; right: 0; height: ${barPx}px; background: #000; z-index: 700; }
      #bar-top { top: 0; } #bar-bottom { bottom: 0; }
      #fade { position: absolute; inset: 0; background: #000; opacity: 0; z-index: 900; }

      #title { position: absolute; left: 70px; right: 70px; margin: 0; text-align: center; z-index: 800; color: #fff; text-wrap: balance; opacity: 0; }
      #title.hook { top: 42%; transform: translateY(-50%); font-weight: 900; font-size: ${titlePx}px; line-height: 1; letter-spacing: -0.03em; text-shadow: 0 8px 40px rgba(0,0,0,.55); }
      #title.hook em { font-family: "Editorial Serif", Georgia, serif; font-style: italic; font-weight: 400; color: ${d.accentColor}; font-size: 1.12em; letter-spacing: 0; }
      #title.soft { top: 50%; transform: translateY(-50%); font-weight: 600; font-size: ${titlePx}px; letter-spacing: 0.34em; text-transform: lowercase; text-shadow: 0 4px 30px rgba(0,0,0,.6); }

      .cap { position: absolute; left: 60px; right: 60px; z-index: 820; display: flex; justify-content: center; }
      /* Word spacing comes from the gap: the renderer collapses whitespace between inline tags. */
      .cap-in { display: flex; flex-wrap: wrap; justify-content: center; align-items: baseline; column-gap: ${Math.max(10, Math.round(capPx * 0.26))}px; row-gap: ${Math.round(capPx * 0.04)}px; max-width: ${Math.round(W * 0.86)}px; }
      .cap.bold { top: 66%; }
      .cap.bold .w { font-family: "Inter", sans-serif; font-weight: 900; font-size: ${capPx}px; line-height: 1.02; letter-spacing: -0.02em; color: #fff; text-shadow: 0 6px 28px rgba(0,0,0,.65); }
      .cap.bold .em { color: ${d.accentColor}; }
      .cap.minimal { top: 50%; }
      .cap.minimal .w { font-weight: 600; font-size: ${capPx}px; color: rgba(255,255,255,.92); letter-spacing: 0.02em; text-shadow: 0 2px 16px rgba(0,0,0,.7); }
      .cap.editorial { top: 60%; }
      .cap.editorial .w { font-weight: 800; font-size: ${capPx}px; color: #fff; letter-spacing: -0.02em; text-shadow: 0 4px 24px rgba(0,0,0,.45); }
      .cap.editorial .em { font-family: "Editorial Serif", Georgia, serif; font-style: italic; font-weight: 400; font-size: 1.28em; letter-spacing: 0; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="hfedit" data-start="0" data-width="${W}" data-height="${H}" data-duration="${D}" data-fps="30">
      ${shotsHtml}
      ${overlays.join("\n      ")}
      ${barPx ? `<div class="bar" id="bar-top"></div><div class="bar" id="bar-bottom"></div>` : ""}
      ${titleHtml}
      ${capsHtml}
      <div id="fade"></div>
      ${audio.join("\n      ")}
    </div>
    <script>
      (function () {
        var DATA = ${JSON.stringify(data).replace(/</g, "\\u003c")};
        var D = DATA.duration;
        var tl = gsap.timeline({ paused: true });

        DATA.shots.forEach(function (s) {
          var mv = "#mv" + s.i;
          if (s.transition === "dissolve") tl.fromTo("#sh" + s.i, { opacity: 0 }, { opacity: 1, duration: DATA.dissolve, ease: "power1.inOut", immediateRender: false }, s.t);
          if (s.punch) {
            // Creator punch-in on the cut, then a slow push through the rest of the shot.
            var settle = Math.min(DATA.punch.dur, s.dur * 0.6);
            gsap.set(mv, { scale: 1 + DATA.punch.scale });
            window.ytCameraReset(tl, mv, s.t, { dur: settle, ease: DATA.punch.ease });
            if (s.dur > settle + 0.45 && DATA.camera.push) window.ytCameraMove(tl, mv, s.t + settle, { zoom: DATA.camera.push * 0.6, dur: s.vdur - settle, ease: "none" });
          } else if (DATA.camera.push) {
            window.ytCameraMove(tl, mv, s.t, { zoom: DATA.camera.push, slideX: (s.i % 2 ? 1 : -1) * DATA.camera.drift * DATA.width, dur: s.vdur, ease: "none" });
          }
          if (DATA.shake === "float") window.cameraShake(tl, "#rig" + s.i, { profile: "handheld-tele-mild", intensity: 0.3, frequency: 0.8, duration: s.vdur, at: s.t, fps: 30 });
          else if (s.hit !== null) window.cameraShake(tl, "#rig" + s.i, { profile: "handheld-normal-strong", intensity: 0.5, duration: 0.4, at: s.hit, fps: 30 });
        });

        if (DATA.openFade) tl.fromTo("#fade", { opacity: 1 }, { opacity: 0, duration: DATA.openFade, ease: "power1.out" }, 0);
        if (DATA.endFade) tl.fromTo("#fade", { opacity: 0 }, { opacity: 1, duration: DATA.endFade, ease: "power1.in", immediateRender: false }, Math.max(0, D - DATA.endFade));

        ${titleScript}

        DATA.caps.forEach(function (c, i) {
          var sel = "#" + c.id + " .cap-in";
          if (DATA.captionMode === "bold") tl.fromTo(sel, { scale: 1.3, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.12, ease: "back.out(2.4)" }, c.start);
          else tl.fromTo(sel, { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.22, ease: "power2.out" }, c.start);
        });

        if (DATA.musicIn !== null) tl.fromTo("#music", { volume: 0 }, { volume: 1, duration: 0.35, ease: "power1.out" }, DATA.musicIn);
        DATA.ducks.forEach(function (k) {
          tl.fromTo("#music", { volume: 1 }, { volume: 0.22, duration: 0.25, ease: "power1.inOut", immediateRender: false }, Math.max(0, k.t - 0.2));
          tl.fromTo("#music", { volume: 0.22 }, { volume: 1, duration: 0.35, ease: "power1.inOut", immediateRender: false }, k.end);
        });
        if (DATA.musicFade !== null) tl.fromTo("#music", { volume: 1 }, { volume: 0, duration: D - DATA.musicFade, ease: "none", immediateRender: false }, DATA.musicFade);

        window.__timelines = window.__timelines || {};
        window.__timelines["hfedit"] = tl;
      })();
    </script>
  </body>
</html>
`;
  return { html, width: W, height: H, duration: D };
}

/** Write a renderable folder: index.html plus fonts, GSAP and the vendored registry pieces (segment files must already be in assets/). */
export async function writeHfEditComposition(dir, options) {
  const result = buildHfEditHtml(options);
  await fs.mkdir(path.join(dir, "assets"), { recursive: true });
  for (const sub of ["fonts", "vendor", "registry"]) await fs.cp(path.join(ASSETS, sub), path.join(dir, "assets", sub), { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), result.html);
  return result;
}
