// Director layers on top of a clip composition (lib/compose.js buildCompositionHtml): slides that pop in while
// the speaker is pushed aside or into a corner, phone screen recordings side by side, B-roll cutaways, and
// emphasis captions glowing behind the speaker (a person cutout plays over them). Everything is added to the
// composition's own GSAP timeline, so it previews and renders the same way and stays seek-safe.
import { ASPECTS, normalizeDesign } from "../../lib/compose.js";

const r3 = (n) => Math.round(n * 1000) / 1000;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const overlayClips = (doc) => doc.tracks.filter((t) => t.kind === "overlay" && !t.hidden).flatMap((t) => t.clips).sort((a, b) => a.start - b.start);
export const emphasisClips = (doc) => doc.tracks.filter((t) => t.kind === "emphasis" && !t.hidden).flatMap((t) => t.clips).sort((a, b) => a.start - b.start);

/**
 * Where the speaker and the panel sit for a layout, in canvas pixels. `content` is the part of the frame that shows
 * the speaker (the whole canvas for full-bleed looks, the framed band for Podcast Frame); it's scaled into `box`
 * without cropping. Returns { box, stage: { x, y, s }, panel: { x, y, w, h }, radius }.
 */
export function geometry(layout, side, W, H, media = {}, content = { x: 0, y: 0, w: W, h: H }) {
  const landscape = W >= H;
  const m = Math.round(Math.min(W, H) * 0.045);
  const right = side !== "left";
  const a = content.h / content.w;
  const sized = (maxW, maxH) => {
    let w = maxW;
    let h = w * a;
    if (h > maxH) [h, w] = [maxH, maxH / a];
    return { w, h };
  };
  const place = (box, panel, radius, extra = {}) => {
    const s = box.w / content.w;
    return { box, stage: { x: box.x - content.x * s, y: box.y - content.y * s, s }, panel, radius, ...extra };
  };
  if (layout === "card") return { box: { ...content }, stage: { x: 0, y: 0, s: 1 }, panel: { x: W * 0.12, y: H * (landscape ? 0.12 : 0.22), w: W * 0.76, h: H * (landscape ? 0.76 : 0.44) }, dim: true, radius: 30 };
  if (layout === "full" || layout === "pip") {
    const { w, h } = sized(W * (landscape ? 0.24 : 0.36), H * 0.2);
    const top = layout === "pip";
    const box = { x: right ? m : W - w - m, y: top ? m : H - h - m, w, h };
    const reserve = landscape || top ? 0 : h + m;
    return place(box, { x: m * 1.5, y: top && !landscape ? h + m * 2 : m * 1.5, w: W - m * 3, h: H - m * 3 - (top && !landscape ? h + m : reserve) }, 28);
  }
  // split
  if (landscape) {
    const { w, h } = sized(W * (media.portrait ? 0.56 : 0.5) - m, H - m * 2);
    const box = { x: right ? m : W - w - m, y: (H - h) / 2, w, h };
    return place(box, { x: right ? box.x + w + m : m, y: m * 1.4, w: W - w - m * 3, h: H - m * 2.8 }, 32);
  }
  if (media.portrait) {
    const { w, h } = sized(W * 0.5 - m, H * 0.7);
    const box = { x: right ? m * 0.7 : W - w - m * 0.7, y: (H - h) / 2, w, h };
    return place(box, { x: right ? box.x + w + m * 0.6 : m * 0.7, y: H * 0.14, w: W - w - m * 2, h: H * 0.72 }, 28);
  }
  // Portrait with a landscape slide: slide on top, speaker below.
  const { w, h } = sized(W - m * 2, H * 0.46);
  const box = { x: (W - w) / 2, y: H - h - m * 2, w, h };
  return place(box, { x: m, y: m * 2, w: W - m * 2, h: box.y - m * 3 }, 30);
}

/**
 * Add the director layers to composition HTML.
 * @param resolve  { slide(assetId, page) → { src, width, height, rebuilt? }, video(assetId) → { src, width, height }, matte(clipId) → { src, at, until } | null }
 */
export function injectLayers(html, doc, resolve) {
  const overlays = overlayClips(doc);
  const emphasis = emphasisClips(doc);
  if (!overlays.length && !emphasis.length) return html;

  const d = normalizeDesign({ ...doc.design, aspect: doc.aspect });
  const { width: W, height: H } = ASPECTS[d.aspect];
  const accent = d.accentColor || "#ffffff";
  const panelsHtml = [];
  const cues = [];
  // Podcast Frame shows the speaker in a band: move that band, and let the blurred backdrop fade out.
  const framed = html.match(/<div id="frame" style="top:(\d+)px;height:(\d+)px">/);
  const content = framed ? { x: 0, y: Number(framed[1]), w: W, h: Number(framed[2]) } : { x: 0, y: 0, w: W, h: H };

  for (const c of overlays) {
    const id = `dx-${c.id}`;
    const t0 = r3(c.start);
    const t1 = r3(c.start + c.duration);
    if (c.source === "slide") {
      const slide = resolve.slide(c.asset, c.page);
      if (!slide) continue;
      const g = geometry(c.layout, c.side, W, H, {}, content);
      const fit = fitBox(slide.width || 1600, slide.height || 900, g.panel);
      const focus = c.focus && slide.src ? focusTransform(c.focus, fit) : null;
      const inner = slide.rebuilt
        ? `<div class="dx-rebuilt">${slide.image ? `<img src="${esc(slide.image)}" alt="" />` : ""}<h2>${esc(slide.title)}</h2><ul>${(slide.bullets || []).map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>`
        : `<img class="dx-img" src="${esc(slide.src)}" alt="" style="width:${Math.round(fit.w)}px;height:${Math.round(fit.h)}px" />`;
      const box = slide.rebuilt ? g.panel : { x: g.panel.x + (g.panel.w - fit.w) / 2, y: g.panel.y + (g.panel.h - fit.h) / 2, w: fit.w, h: fit.h };
      panelsHtml.push(`<div id="${id}" class="dx-panel dx-slide${slide.rebuilt ? " is-rebuilt" : ""}" style="left:${Math.round(box.x)}px;top:${Math.round(box.y)}px;width:${Math.round(box.w)}px;height:${Math.round(box.h)}px;border-radius:${g.radius}px"><div class="dx-zoom">${inner}</div></div>`);
      cues.push({ kind: "panel", id, t0, t1, stage: g.stage, box: g.box, radius: g.radius, dim: Boolean(g.dim), framed: Boolean(framed), side: c.side === "left" ? -1 : 1, focus, layout: c.layout, captions: captionBand(c.layout, g, W, H) });
    } else {
      const media = resolve.video(c.asset);
      if (!media) continue;
      const portrait = media.height > media.width;
      const vid = `<video id="${id}-v" class="clip" src="${esc(media.src)}" data-start="${t0}" data-duration="${r3(c.duration)}" data-media-start="${r3(c.sourceStart || 0)}" data-track-index="${60 + (cues.length % 8)}" muted playsinline></video>`;
      if (c.source === "broll") {
        panelsHtml.push(`<div id="${id}" class="dx-panel dx-broll">${vid}</div>`);
        cues.push({ kind: "broll", id, t0, t1 });
        continue;
      }
      const g = geometry("split", c.side, W, H, { portrait }, content);
      const fit = fitBox(media.width, media.height, { ...g.panel, w: g.panel.w - 28, h: g.panel.h - 28 });
      const bw = fit.w + 28;
      const bh = fit.h + 28;
      panelsHtml.push(`<div id="${id}" class="dx-panel ${portrait ? "dx-phone" : "dx-screen"}" style="left:${Math.round(g.panel.x + (g.panel.w - bw) / 2)}px;top:${Math.round(g.panel.y + (g.panel.h - bh) / 2)}px;width:${Math.round(bw)}px;height:${Math.round(bh)}px">${vid}</div>`);
      cues.push({ kind: "panel", id, t0, t1, stage: g.stage, box: g.box, radius: g.radius, framed: Boolean(framed), side: c.side === "left" ? -1 : 1, phone: portrait, captions: captionBand("split", g, W, H) });
    }
  }

  const emphHtml = [];
  for (const c of emphasis) {
    const id = `dx-${c.id}`;
    const words = String(c.text || "").trim().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!words.length) continue;
    const matte = resolve.matte(c.id);
    const longest = Math.max(...words.map((w) => w.length));
    const perLine = words.length > 3 ? Math.ceil(words.length / 2) : words.length;
    const lineChars = words.slice(0, perLine).join(" ").length;
    const px = Math.round(Math.min(W * (W >= H ? 0.15 : 0.22), (W * 0.9) / Math.max(4, lineChars * 0.56), (W * 0.9) / Math.max(3, longest * 0.62)));
    const t0 = r3(c.start);
    const t1 = r3(c.start + c.duration);
    emphHtml.push({
      id,
      matte,
      html: `<div id="${id}-shade" class="dx-emph-shade"></div><div id="${id}" class="dx-emph${matte ? " behind" : ""}" style="font-size:${px}px">${words.map((w, i) => `<span class="dx-ew" id="${id}-w${i}">${esc(w)}</span>`).join(" ")}</div>`,
      cut: matte ? `<video id="${id}-cut" class="clip dx-cut" src="${esc(matte.src)}" data-start="${r3(matte.at)}" data-duration="${r3(matte.until - matte.at)}" data-media-start="0" data-track-index="${80 + (emphHtml.length % 8)}" muted playsinline></video>` : "",
    });
    cues.push({ kind: "emphasis", id, t0, t1, words: words.length, behind: Boolean(matte) });
  }

  const css = `
      #root { isolation: isolate; }
      #dx-bg { position: absolute; inset: 0; z-index: -1; background: radial-gradient(90% 70% at 70% 40%, color-mix(in srgb, ${accent} 26%, #0b0c10), #07080b 70%); }
      #dx-stage { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; overflow: hidden; transform-origin: 0 0; }
      .dx-panel { position: absolute; z-index: 40; visibility: hidden; opacity: 0; will-change: transform, opacity, filter; }
      .dx-slide { overflow: hidden; background: #fff; box-shadow: 0 40px 120px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.18); }
      .dx-slide .dx-zoom { position: absolute; inset: 0; transform-origin: 0 0; }
      .dx-slide .dx-img { display: block; }
      .dx-slide.is-rebuilt { background: linear-gradient(160deg, #15171d, #0b0c10); color: #fff; }
      .dx-rebuilt { position: absolute; inset: 0; padding: 7% 8%; display: flex; flex-direction: column; justify-content: center; gap: 3%; font-family: "Inter", sans-serif; }
      .dx-rebuilt img { position: absolute; right: 6%; top: 50%; width: 38%; transform: translateY(-50%); border-radius: 18px; object-fit: cover; }
      .dx-rebuilt h2 { margin: 0; max-width: 58%; font-weight: 900; font-size: ${Math.round(Math.min(W, H) * 0.07)}px; line-height: 1.05; letter-spacing: -0.02em; }
      .dx-rebuilt h2::after { content: ""; display: block; width: 120px; height: 8px; margin-top: 22px; border-radius: 4px; background: ${accent}; }
      .dx-rebuilt ul { margin: 0; padding: 0; list-style: none; max-width: 58%; display: flex; flex-direction: column; gap: 14px; }
      .dx-rebuilt li { font-weight: 600; font-size: ${Math.round(Math.min(W, H) * 0.034)}px; line-height: 1.25; opacity: .9; padding-left: 34px; position: relative; }
      .dx-rebuilt li::before { content: ""; position: absolute; left: 0; top: .5em; width: 14px; height: 14px; border-radius: 50%; background: ${accent}; }
      .dx-phone { padding: 14px; box-sizing: border-box; border-radius: 64px; background: #0a0a0c; box-shadow: 0 0 0 2px rgba(255,255,255,.14), 0 50px 140px rgba(0,0,0,.6), 0 0 160px color-mix(in srgb, ${accent} 35%, transparent); }
      .dx-phone video { width: 100%; height: 100%; object-fit: cover; border-radius: 50px; display: block; background: #000; }
      .dx-screen { padding: 14px; box-sizing: border-box; border-radius: 30px; background: rgba(14,15,19,.92); box-shadow: 0 0 0 1px rgba(255,255,255,.14), 0 40px 120px rgba(0,0,0,.55); }
      .dx-screen video { width: 100%; height: 100%; object-fit: contain; border-radius: 18px; display: block; background: #000; }
      .dx-broll { inset: 0; }
      .dx-broll video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      .dx-emph-shade { position: absolute; inset: 0; z-index: 50; opacity: 0; visibility: hidden; background: radial-gradient(75% 60% at 50% 42%, rgba(0,0,0,.25), rgba(0,0,0,.72)); pointer-events: none; }
      .dx-emph { position: absolute; z-index: 60; left: 4%; right: 4%; top: ${framed ? 46 : W >= H ? 44 : 36}%; transform: translateY(-50%); display: flex; flex-wrap: wrap; justify-content: center; align-content: center; gap: 0 .24em;
        font-family: "Inter", sans-serif; font-weight: 900; line-height: .96; letter-spacing: -0.035em; color: #fff; text-align: center; visibility: hidden; opacity: 0; pointer-events: none;
        text-shadow: 0 0 .06em #fff, 0 0 .22em color-mix(in srgb, ${accent} 90%, #fff), 0 0 .6em ${accent}, 0 0 1.2em color-mix(in srgb, ${accent} 60%, transparent); }
      .dx-emph:not(.behind) { top: ${framed ? 80 : W >= H ? 72 : 70}%; }
      .dx-ew { display: inline-block; will-change: transform, opacity, filter; }
      #dx-emph-layer { position: absolute; left: 0; width: ${W}px; pointer-events: none; }
      #dx-emph-layer .dx-emph-shade { top: ${framed ? -content.y : 0}px; bottom: auto; height: ${H}px; }
      .dx-cutbox { position: absolute; inset: 0; overflow: hidden; z-index: 70; }
      .dx-cz, .dx-cp { position: absolute; inset: 0; }
      .dx-cut { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: var(--fx, 50%) 50%; }`;

  const script = `
        // ---- director layers (editor/director/layers.js) ----
        (function () {
          var CUES = ${JSON.stringify(cues).replace(/</g, "\\u003c")};
          var W = ${W}, H = ${H};
          var root = document.getElementById("root");
          var bg = document.createElement("div"); bg.id = "dx-bg";
          var stage = document.createElement("div"); stage.id = "dx-stage";
          var firstVideo = root.querySelector("#bg-wrap, #video-zoom");
          root.insertBefore(bg, firstVideo); root.insertBefore(stage, firstVideo);
          ["#bg-wrap", "#bg-shade", "#frame", "#video-zoom", "#shade-top", "#shade-bottom"].forEach(function (s) { var el = root.querySelector(s); if (el) stage.appendChild(el); });
          // Cutouts follow the footage's own framing moves: copy every tween on the video wrappers onto their twins.
          var twins = [["#video-zoom", "#dx-cz"], ["#video-punch", "#dx-cp"], ["#frame-punch", "#dx-cp"]].filter(function (p) { return document.querySelector(p[0]) && document.querySelector(p[1]); });
          if (twins.length) {
            twins.forEach(function (p) {
              var src = document.querySelector(p[0]);
              var css = getComputedStyle(src);
              gsap.set(p[1], { transformOrigin: css.transformOrigin, "--fx": src.style.getPropertyValue("--fx") || "50%" });
              if (src._gsap) gsap.set(p[1], { scale: gsap.getProperty(src, "scaleX") });
            });
            tl.getChildren(true, true, false).forEach(function (t) {
              var targets = t.targets ? t.targets() : [];
              twins.forEach(function (p) {
                var src = document.querySelector(p[0]);
                if (targets.indexOf(src) < 0) return;
                var vars = Object.assign({}, t.vars);
                delete vars.startAt;
                var from = t.vars.startAt ? Object.assign({}, t.vars.startAt) : null;
                if (from) delete from.immediateRender;
                tl.add(from ? gsap.fromTo(p[1], from, Object.assign(vars, { immediateRender: false })) : gsap.to(p[1], vars), t.startTime());
              });
            });
          }
          // Big captions shrink until they fit in two lines inside the frame (size only, so it stays seek-safe).
          function fitEmphasis() {
            document.querySelectorAll(".dx-emph").forEach(function (el) {
              var box = el.parentNode.getBoundingClientRect().width * 0.9;
              var px = parseFloat(el.dataset.px || el.style.fontSize);
              el.dataset.px = px;
              for (; px > 40; px -= 4) {
                el.style.fontSize = px + "px";
                var spans = el.querySelectorAll(".dx-ew"), lines = 0, top = -1e9, wide = false;
                for (var k = 0; k < spans.length; k++) {
                  if (spans[k].offsetTop > top + px * 0.5) { lines++; top = spans[k].offsetTop; }
                  if (spans[k].offsetWidth > box) wide = true;
                }
                if (lines <= 2 && !wide && el.scrollWidth <= el.clientWidth + 2) break;
              }
            });
          }
          fitEmphasis();
          if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitEmphasis);
          gsap.set(stage, { x: 0, y: 0, scale: 1, clipPath: "inset(0px 0px 0px 0px round 0px)" });
          var capsOrig = null;
          var home = { x: 0, y: 0, scale: 1, clipPath: "inset(0px 0px 0px 0px round 0px)" };

          CUES.forEach(function (c) {
            var el = "#" + c.id;
            if (c.kind === "panel") {
              var dur = Math.min(0.75, (c.t1 - c.t0) / 3);
              var s = c.stage.s, bx = c.box;
              // The stage scales as a whole; a clip-path trims it to the speaker's box (in unscaled stage pixels).
              var inset = "inset(" + ((bx.y - c.stage.y) / s) + "px " + (W - (bx.x + bx.w - c.stage.x) / s) + "px " + (H - (bx.y + bx.h - c.stage.y) / s) + "px " + ((bx.x - c.stage.x) / s) + "px round " + (c.radius / s) + "px)";
              var to = { x: c.stage.x, y: c.stage.y, scale: s, clipPath: s < 1 ? inset : "inset(0px 0px 0px 0px round 0px)" };
              if (c.dim) tl.fromTo("#dx-stage", { filter: "brightness(1) blur(0px)" }, { filter: "brightness(.55) blur(6px)", duration: dur, ease: "power2.out", immediateRender: false }, c.t0);
              else tl.fromTo(stage, home, Object.assign({ duration: dur, ease: "power3.inOut", immediateRender: false }, to), c.t0);
              var fromX = c.layout === "full" || c.layout === "card" ? 0 : 140 * c.side;
              tl.fromTo(el, { autoAlpha: 0, x: fromX, y: c.layout === "full" || c.layout === "card" ? 90 : 0, scale: 0.86, rotation: c.phone ? 7 * c.side : 0, filter: "blur(16px)" },
                { autoAlpha: 1, x: 0, y: 0, scale: 1, rotation: 0, filter: "blur(0px)", duration: 0.8, ease: "back.out(1.5)", immediateRender: false }, c.t0 + dur * 0.35);
              if (c.focus) tl.fromTo(el + " .dx-zoom", { x: 0, y: 0, scale: 1 }, { x: c.focus.x, y: c.focus.y, scale: c.focus.s, duration: 1.1, ease: "power2.inOut", immediateRender: false }, c.t0 + 0.95);
              tl.fromTo(el, { scale: 1 }, { scale: 1.025, duration: Math.max(0.1, c.t1 - c.t0 - 1.6), ease: "sine.inOut", immediateRender: false }, c.t0 + 1.1);
              tl.fromTo("#title-zone", { autoAlpha: 1 }, { autoAlpha: 0, duration: 0.25, immediateRender: false }, c.t0);
              tl.fromTo("#title-zone", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3, immediateRender: false }, c.t1);
              if (c.framed && !c.dim) {
                tl.fromTo("#bg-wrap, #bg-shade", { autoAlpha: 1 }, { autoAlpha: 0, duration: dur, immediateRender: false }, c.t0);
                tl.fromTo("#bg-wrap, #bg-shade", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.6, immediateRender: false }, Math.max(c.t0 + 1.2, c.t1 - 0.55) + 0.12);
              }
              if (c.captions) {
                tl.set(".cap", c.captions, c.t0);
                tl.set(".cap", { left: 50, right: 50, top: null, clearProps: "left,right,top" }, c.t1);
              }
              var out = Math.max(c.t0 + 1.2, c.t1 - 0.55);
              tl.fromTo(el, { autoAlpha: 1, x: 0, y: 0, filter: "blur(0px)" }, { autoAlpha: 0, x: fromX * 0.6, y: fromX ? 0 : 60, filter: "blur(10px)", duration: 0.45, ease: "power2.in", immediateRender: false }, out);
              if (c.dim) tl.fromTo("#dx-stage", { filter: "brightness(.55) blur(6px)" }, { filter: "brightness(1) blur(0px)", duration: 0.6, ease: "power2.inOut", immediateRender: false }, out + 0.1);
              else tl.fromTo(stage, to, Object.assign({ duration: 0.65, ease: "power3.inOut", immediateRender: false }, home), out + 0.12);
            } else if (c.kind === "broll") {
              tl.fromTo(el, { autoAlpha: 0, scale: 1.12, filter: "blur(10px)" }, { autoAlpha: 1, scale: 1, filter: "blur(0px)", duration: 0.45, ease: "power3.out", immediateRender: false }, c.t0);
              tl.fromTo(el, { autoAlpha: 1 }, { autoAlpha: 0, duration: 0.35, ease: "power2.in", immediateRender: false }, Math.max(c.t0 + 0.6, c.t1 - 0.35));
            } else if (c.kind === "emphasis") {
              var words = [];  // selector list, in reading order
              for (var i = 0; i < c.words; i++) words.push(el + "-w" + i);
              tl.set(el, { autoAlpha: 1 }, c.t0);
              tl.set(".cap", { autoAlpha: 0 }, c.t0);
              tl.fromTo(el + "-shade", { autoAlpha: 0 }, { autoAlpha: c.behind ? 1 : 0.6, duration: 0.35, ease: "power2.out", immediateRender: false }, c.t0 - 0.1);
              tl.fromTo(words.join(","), { autoAlpha: 0, scale: 1.55, y: 40, filter: "blur(22px)" }, { autoAlpha: 1, scale: 1, y: 0, filter: "blur(0px)", duration: 0.55, ease: "expo.out", stagger: 0.09, immediateRender: false }, c.t0);
              tl.fromTo(el, { scale: 1 }, { scale: 1.04, duration: Math.max(0.2, c.t1 - c.t0), ease: "sine.inOut", immediateRender: false }, c.t0);
              tl.fromTo(words.join(","), { autoAlpha: 1, y: 0, filter: "blur(0px)" }, { autoAlpha: 0, y: -30, filter: "blur(14px)", duration: 0.4, ease: "power2.in", stagger: 0.04, immediateRender: false }, c.t1 - 0.2);
              tl.fromTo(el + "-shade", { autoAlpha: c.behind ? 1 : 0.6 }, { autoAlpha: 0, duration: 0.4, ease: "power2.inOut", immediateRender: false }, c.t1);
              tl.set(el, { autoAlpha: 0 }, c.t1 + 0.4);
              tl.set(".cap", { autoAlpha: 1 }, c.t1 + 0.3);
            }
          });
        })();
`;

  // Big captions live in their own layer over the video (the renderer draws video frames above anything placed
  // among them). The layer covers the speaker's picture; the cutouts inside copy the video's zoom moves.
  const band = framed ? `top:${content.y}px;height:${content.h}px` : "top:0;height:100%";
  const emphHold = emphHtml.length
    ? `<div id="dx-emph-layer" style="${band}">${emphHtml.map((e) => e.html).join("")}<div class="dx-cutbox"><div id="dx-cz" class="dx-cz"><div id="dx-cp" class="dx-cp">${emphHtml.map((e) => e.cut).join("")}</div></div></div></div>`
    : "";
  let out = html.replace("</style>", `${css}\n    </style>`);
  const close = out.lastIndexOf("</div>\n    <script>");
  if (close < 0) throw new Error("Unexpected composition layout");
  out = `${out.slice(0, close)}${emphHold}\n      ${panelsHtml.join("\n      ")}\n    ${out.slice(close)}`;
  const hook = out.lastIndexOf("window.__timelines = window.__timelines || {};");
  return `${out.slice(0, hook)}${script}\n        ${out.slice(hook)}`;
}

/** Largest size an image of w×h takes inside box without cropping. */
function fitBox(w, h, box) {
  const s = Math.min(box.w / w, box.h / h);
  return { w: w * s, h: h * s };
}

/** Transform (for .dx-zoom, origin top-left) that makes the focus region (in % of the slide) fill the panel. */
function focusTransform(f, fit) {
  const fw = (f.w / 100) * fit.w;
  const fh = (f.h / 100) * fit.h;
  const s = Math.min(3.2, Math.max(1, Math.min(fit.w / fw, fit.h / fh)));
  if (s < 1.08) return null;
  const cx = (f.x / 100) * fit.w + fw / 2;
  const cy = (f.y / 100) * fit.h + fh / 2;
  const x = Math.min(0, Math.max(fit.w - fit.w * s, fit.w / 2 - cx * s));
  const y = Math.min(0, Math.max(fit.h - fit.h * s, fit.h / 2 - cy * s));
  return { s: r3(s), x: Math.round(x), y: Math.round(y) };
}

/** Where captions go while a panel is up: under the speaker's box, clear of the panel. */
function captionBand(layout, g, W, H) {
  if (layout !== "split") return { autoAlpha: 0 };
  const b = g.box;
  // Across the lower part of the speaker's box, inside it.
  return { left: Math.round(b.x + 24), right: Math.round(W - b.x - b.w + 24), top: `${r3(((b.y + b.h * 0.82) / H) * 100)}%` };
}
