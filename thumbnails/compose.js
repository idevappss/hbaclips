// The thumbnail itself: a 1280×720 page that Chrome screenshots. Layouts keep the headline off the
// speaker's face, and the accent colour comes from the Assets brand kit when the creator has one.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../lib/tools.js";

const FONTS = path.join(ROOT, "assets", "fonts");
const fontUrl = (name) => pathToFileURL(path.join(FONTS, name)).href;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const WIDTH = 1280;
export const HEIGHT = 720;

/** How the text sits against the picture. `auto` picks the side away from the speaker. */
export const LAYOUTS = [
  { id: "left", label: "Text left" },
  { id: "right", label: "Text right" },
  { id: "bottom", label: "Across the bottom" },
  { id: "panel", label: "Split panel" },
  { id: "word", label: "One big word" },
];
export const LAYOUT_IDS = new Set(LAYOUTS.map((l) => l.id));

const DEFAULT_ACCENT = "#ef3340";
const UPSTREAM = () => (process.env.CLIP_STUDIO_URL || "http://localhost:5173").replace(/\/$/, "");

let brandCache = { at: 0, brand: null };

/**
 * The creator's brand kit (Assets session, read-only). Cached for a few minutes; a studio that isn't
 * running just means the house accent colour.
 */
export async function brandKit({ fresh = false } = {}) {
  if (!fresh && brandCache.brand && Date.now() - brandCache.at < 300_000) return brandCache.brand;
  let brand = { colors: [], fonts: [], logos: [] };
  try {
    const res = await fetch(`${UPSTREAM()}/api/resources/brand`, { signal: AbortSignal.timeout(2500) });
    if (res.ok) brand = await res.json();
  } catch {
    // Assets tab not reachable — house colours are fine.
  }
  brandCache = { at: Date.now(), brand };
  return brand;
}

const absolute = (url) => (!url ? null : /^https?:/.test(url) ? url : `${UPSTREAM()}${url}`);

/** Accent + logo the composition should use, from the brand kit. */
export async function brandStyle({ accent, logo = false } = {}) {
  const brand = await brandKit();
  const picked = accent || brand.colors?.find((c) => /accent|brand|primary|main/i.test(c.name || ""))?.hex || brand.colors?.[0]?.hex || DEFAULT_ACCENT;
  const mark = logo ? brand.logos?.find((l) => /png|jpe?g|svg|webp/i.test(l.mime || l.url || "")) : null;
  return { accent: /^#[0-9a-f]{3,8}$/i.test(picked) ? picked : DEFAULT_ACCENT, logoUrl: absolute(mark?.url) || null };
}

/** The layout that leaves the speaker visible: text opposite the face, bottom bar when they're centred. */
export function autoLayout(face) {
  if (!face) return "bottom";
  if (face.x >= 0.58) return "left";
  if (face.x <= 0.42) return "right";
  return "bottom";
}

/** Keep the subject inside the 16:9 crop (percent for object-position). */
function objectPosition(face, layout) {
  if (!face) return 50;
  const pull = layout === "left" ? 0.06 : layout === "right" ? -0.06 : 0;
  return Math.round(Math.min(100, Math.max(0, (face.x + pull) * 100)));
}

/**
 * The page Chrome screenshots.
 * shot: { url } — a file:// or http URL for the still. headline/sub: the words. accent: hex.
 */
export function thumbnailHtml({ imageUrl, headline, sub = "", layout = "bottom", accent = DEFAULT_ACCENT, face = null, logoUrl = null, badge = "", hit = "" }) {
  const words = String(headline || "").trim().split(/\s+/).filter(Boolean);
  const bare = (w) => String(w || "").toLowerCase().replace(/[^\w$%]+/g, "");
  const pos = objectPosition(face, layout);
  const body = layout === "word"
    ? `<div class="word">${esc(words[0] || "")}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}`
    : `<h1>${words.map((w) => `<span${bare(w) && bare(w) === bare(hit) ? ' data-hit="1"' : ""}>${esc(w)}</span>`).join(" ")}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}`;

  return `<!doctype html>
<meta charset="utf-8" />
<style>
  @font-face { font-family: "Anton"; src: url("${fontUrl("anton-latin-400-normal.woff2")}") format("woff2"); font-weight: 400; font-display: block; }
  @font-face { font-family: "Inter"; src: url("${fontUrl("inter-latin-900-normal.woff2")}") format("woff2"); font-weight: 900; font-display: block; }
  @font-face { font-family: "Inter"; src: url("${fontUrl("inter-latin-600-normal.woff2")}") format("woff2"); font-weight: 600; font-display: block; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; background: #000; }
  .frame { position: relative; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; --accent: ${esc(accent)}; }
  .shot { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: ${pos}% 42%; }
  .grade { position: absolute; inset: 0; background: linear-gradient(transparent 35%, rgba(0,0,0,.28)), radial-gradient(120% 90% at 50% 40%, transparent 40%, rgba(0,0,0,.45)); }
  .scrim { position: absolute; inset: 0; }
  .text { position: absolute; display: flex; flex-direction: column; justify-content: center; gap: 18px; }
  h1 { color: #fff; font: 400 96px/0.92 "Anton", "Inter", sans-serif; text-transform: uppercase; letter-spacing: -0.01em; text-wrap: balance; text-shadow: 0 6px 30px rgba(0,0,0,.55); }
  h1 span { box-decoration-break: clone; -webkit-box-decoration-break: clone; }
  h1 span.hit { background: var(--accent); color: #fff; padding: 0 12px 4px; margin: 0 -4px; border-radius: 8px; }
  .sub { color: rgba(255,255,255,.88); font: 600 30px/1.2 "Inter", sans-serif; letter-spacing: -0.01em; text-shadow: 0 3px 16px rgba(0,0,0,.6); }
  .bar { width: 96px; height: 10px; border-radius: 99px; background: var(--accent); }

  .left .text  { left: 64px;  top: 0; bottom: 0; width: 620px; }
  .left .scrim { background: linear-gradient(100deg, rgba(0,0,0,.88) 12%, rgba(0,0,0,.62) 44%, transparent 68%); }
  .right .text  { right: 64px; top: 0; bottom: 0; width: 620px; text-align: right; align-items: flex-end; }
  .right .scrim { background: linear-gradient(260deg, rgba(0,0,0,.88) 12%, rgba(0,0,0,.62) 44%, transparent 68%); }
  .bottom .text  { left: 64px; right: 64px; bottom: 56px; height: 300px; justify-content: flex-end; }
  .bottom .scrim { background: linear-gradient(transparent 34%, rgba(0,0,0,.72) 72%, rgba(0,0,0,.92)); }
  .bottom h1 { font-size: 86px; }
  .panel .shot { left: 44%; width: 56%; object-position: ${pos}% 40%; }
  .panel .scrim { background: linear-gradient(90deg, #0b0b0d 0 44%, rgba(11,11,13,.85) 44%, transparent 58%); }
  .panel .text { left: 60px; top: 0; bottom: 0; width: 470px; }
  .panel h1 { font-size: 84px; }
  .word { position: absolute; inset: 0; display: grid; place-items: center; color: #fff; font: 400 240px/1 "Anton", sans-serif; text-transform: uppercase; text-shadow: 0 10px 50px rgba(0,0,0,.6); -webkit-text-stroke: 3px rgba(0,0,0,.25); }
  .word ~ .sub { position: absolute; left: 0; right: 0; bottom: 66px; text-align: center; font-size: 34px; }
  .word-l .scrim { background: radial-gradient(70% 70% at 50% 50%, rgba(0,0,0,.6), rgba(0,0,0,.35)); }
  .edge { position: absolute; inset: 0; box-shadow: inset 0 0 0 10px var(--accent); }
  .logo { position: absolute; right: 44px; bottom: 40px; max-width: 190px; max-height: 74px; filter: drop-shadow(0 4px 16px rgba(0,0,0,.6)); }
  .badge { position: absolute; left: 64px; top: 48px; padding: 9px 18px 11px; border-radius: 99px; background: var(--accent); color: #fff; font: 900 24px/1 "Inter", sans-serif; letter-spacing: .04em; text-transform: uppercase; }
</style>
<div class="frame ${layout === "word" ? "word-l" : layout}">
  <img class="shot" src="${esc(imageUrl)}" />
  <div class="grade"></div>
  <div class="scrim"></div>
  ${badge ? `<div class="badge">${esc(badge)}</div>` : ""}
  ${layout === "word" ? body : `<div class="text"><div class="bar"></div>${body}</div>`}
  ${logoUrl ? `<img class="logo" src="${esc(logoUrl)}" />` : ""}
</div>
<script>
  // One word carries the accent, and the headline shrinks until it fits its box — never a clipped line.
  (() => {
    const h1 = document.querySelector("h1");
    if (h1) {
      const spans = [...h1.querySelectorAll("span")];
      // The word Claude called the strongest carries the accent; failing that, the longest one.
      const hit = h1.querySelector("span[data-hit]") || spans.slice().sort((a, b) => b.textContent.length - a.textContent.length)[0];
      if (spans.length > 1 && hit && hit.textContent.replace(/[^A-Za-z0-9$%]/g, "").length >= 3) hit.classList.add("hit");
      const box = h1.parentElement;
      for (let size = parseFloat(getComputedStyle(h1).fontSize); size > 34; size -= 2) {
        h1.style.fontSize = size + "px";
        if (h1.scrollHeight <= box.clientHeight - 60 && h1.scrollWidth <= box.clientWidth) break;
      }
    }
    const word = document.querySelector(".word");
    if (word) for (let size = 240; size > 60 && word.scrollWidth > ${WIDTH} - 120; size -= 6) word.style.fontSize = size + "px";
    document.documentElement.dataset.ready = "1";
  })();
</script>`;
}
