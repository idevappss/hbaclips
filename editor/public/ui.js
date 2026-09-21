// Small DOM helpers and the editor's icon set (1.8px strokes, 24px grid).
export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const r3 = (n) => Math.round(n * 1000) / 1000;
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const mod = isMac ? "⌘" : "Ctrl";

/** 00:03 / 01:04 style; with frames when asked (00:03:12). */
export function tc(sec, { frames = false, fps = 30 } = {}) {
  const s = Math.max(0, sec || 0);
  const whole = Math.floor(s + 1e-6);
  const base = `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
  return frames ? `${base}:${String(Math.floor((s - whole) * fps + 1e-6)).padStart(2, "0")}` : base;
}
export const secs = (sec) => `${(Math.round(sec * 10) / 10).toFixed(1)}s`;

export async function api(url, { method = "GET", body } = {}) {
  const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

const icon = (body, fill = false) => (size = 16) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill ? "currentColor" : "none"}" stroke="${fill ? "none" : "currentColor"}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const I = {
  back: icon(`<path d="m15 5-7 7 7 7"/>`),
  chevDown: icon(`<path d="m6 9 6 6 6-6"/>`),
  chevLeft: icon(`<path d="m15 6-6 6 6 6"/>`),
  chevRight: icon(`<path d="m9 6 6 6-6 6"/>`),
  undo: icon(`<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>`),
  redo: icon(`<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>`),
  share: icon(`<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4"/>`),
  export: icon(`<path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5"/><path d="M4 15v4.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V15"/>`),
  cloud: icon(`<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1-.5 9.5z"/>`),
  check: icon(`<path d="m5 12.5 4.5 4.5L19 7.5"/>`),
  media: icon(`<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="m3.5 15 4.5-4 4 3.5 3-2.5 5.5 4.5"/><circle cx="15.5" cy="9.5" r="1.3"/>`),
  text: icon(`<path d="M5 6.5V5h14v1.5M12 5v14M9.5 19h5"/>`),
  captions: icon(`<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M7 12.5h3M13 12.5h4M7 15.5h6"/>`),
  elements: icon(`<circle cx="7.5" cy="7.5" r="3"/><rect x="13.5" y="4.5" width="6" height="6" rx="1.5"/><path d="m7.5 13.5 3.5 6H4z"/><circle cx="16.5" cy="16.5" r="3"/>`),
  audio: icon(`<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>`),
  transitions: icon(`<rect x="3" y="6" width="8" height="12" rx="2"/><rect x="13" y="6" width="8" height="12" rx="2"/><path d="m10 12 4 0"/>`),
  effects: icon(`<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>`),
  filters: icon(`<circle cx="9" cy="10" r="5"/><circle cx="15" cy="10" r="5"/><circle cx="12" cy="15" r="5"/>`),
  brand: icon(`<path d="M12 3.5 14.6 9l6 .6-4.5 4 1.3 5.9L12 16.4 6.6 19.5 7.9 13.6l-4.5-4 6-.6z"/>`),
  upload: icon(`<path d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5"/><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"/>`),
  plus: icon(`<path d="M12 5v14M5 12h14"/>`),
  play: icon(`<path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.6-7.2a.8.8 0 0 0 0-1.4L8.2 4.1a.8.8 0 0 0-1.2.7z"/>`, true),
  pause: icon(`<rect x="6" y="4.5" width="4" height="15" rx="1.2"/><rect x="14" y="4.5" width="4" height="15" rx="1.2"/>`, true),
  prevFrame: icon(`<path d="M6 5v14"/><path d="M18 5.8v12.4a.6.6 0 0 1-.9.5L9 12.5a.6.6 0 0 1 0-1l8.1-6.2a.6.6 0 0 1 .9.5z" fill="currentColor"/>`),
  nextFrame: icon(`<path d="M18 5v14"/><path d="M6 5.8v12.4a.6.6 0 0 0 .9.5l8.1-6.2a.6.6 0 0 0 0-1L6.9 5.3a.6.6 0 0 0-.9.5z" fill="currentColor"/>`),
  volume: icon(`<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>`),
  volumeOff: icon(`<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>`),
  fullscreen: icon(`<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>`),
  split: icon(`<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M20 4 8.1 16.2M14.5 14.5 20 20M8.1 7.8l3.4 3.4"/>`),
  ripple: icon(`<path d="M4 7h7M4 12h11M4 17h16"/><path d="m17 5-3 3 3 3"/>`),
  trash: icon(`<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.9 12.2a1 1 0 0 0 1 .8h7.2a1 1 0 0 0 1-.8L17.5 7"/>`),
  duplicate: icon(`<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.5"/><path d="M15.5 8.5V5.5A1.5 1.5 0 0 0 14 4H5.5A1.5 1.5 0 0 0 4 5.5V14a1.5 1.5 0 0 0 1.5 1.5h3"/>`),
  link: icon(`<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>`),
  detach: icon(`<path d="M4 12h3l2-5 3 10 2-7 1.5 2H20"/>`),
  sparkle: icon(`<path d="M12 3.5 13.8 9a2 2 0 0 0 1.2 1.2l5.5 1.8-5.5 1.8a2 2 0 0 0-1.2 1.2L12 20.5 10.2 15A2 2 0 0 0 9 13.8L3.5 12 9 10.2A2 2 0 0 0 10.2 9z"/>`),
  zoomIn: icon(`<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2M11 8.5v5M8.5 11h5"/>`),
  zoomOut: icon(`<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2M8.5 11h5"/>`),
  fit: icon(`<path d="M4 12h16M4 12l3-3M4 12l3 3M20 12l-3-3M20 12l-3 3"/>`),
  eye: icon(`<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>`),
  eyeOff: icon(`<path d="M3 3l18 18M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.7M6.4 6.9C4 8.6 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9 9 0 0 0 4.3-1.1"/><path d="M9.9 10a2.8 2.8 0 0 0 4 4"/>`),
  lock: icon(`<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>`),
  unlock: icon(`<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 7.7-1.5"/>`),
  video: icon(`<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="m16 10.5 5-3v9l-5-3z"/>`),
  magnet: icon(`<path d="M6 4v7a6 6 0 0 0 12 0V4"/><path d="M6 8h3M15 8h3"/>`),
  more: icon(`<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>`, true),
  keyboard: icon(`<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14h8"/>`),
  close: icon(`<path d="M6 6l12 12M18 6 6 18"/>`),
  reset: icon(`<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/>`),
  classic: icon(`<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M13 4.5v15M15.5 8.5h2.5M15.5 12h2.5"/>`),
};

/** Tooltip text with an optional shortcut, used as title="" everywhere. */
export const tip = (label, keys) => esc(keys ? `${label}  (${keys})` : label);
