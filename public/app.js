const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const app = $("#app");

const state = {
  config: null,
  project: null,
  poll: null,
  clipKeys: {},
  library: [],
  accounts: [],
  posts: [],
  reviewFilter: "all",
  week: null,
  titleTab: "titles",
  igAccounts: [],
  seek: null,
  modes: {},
  tracks: [],
  editKeys: {},
  editDraft: null,
};

const STEPS = ["Upload", "Transcribe", "Find moments", "Ready"];
const STEP_OF = { queued: 1, downloading: 0, probing: 1, preparing: 1, transcribing: 1, analyzing: 2, ready: 3 };
const LIVE = ["queued", "downloading", "probing", "preparing", "transcribing", "analyzing"];
const RENDER_BUSY = ["queued", "rendering"];

const PLATFORMS = {
  tiktok: { label: "TikTok", short: "TT", color: "#2DE2E6" },
  instagram: { label: "Instagram", short: "IG", color: "#F0508C" },
  youtube: { label: "YouTube Shorts", short: "YT", color: "#FF5A5A" },
  x: { label: "X", short: "X", color: "#E6E6EA" },
  facebook: { label: "Facebook", short: "FB", color: "#5B95FF" },
  linkedin: { label: "LinkedIn", short: "in", color: "#3AA0E8" },
};
const STATUS_LABEL = { scheduled: "Scheduled", publishing: "Publishing…", due: "Due now", published: "Posted", failed: "Failed" };

const svg = (body, size = 15) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  upload: svg(`<path d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5"/><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"/>`, 22),
  copy: svg(`<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15"/>`),
  play: `<svg width="13" height="13" viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>`,
  stop: `<svg width="12" height="12" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor"/></svg>`,
  download: svg(`<path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M5 20h14"/>`),
  close: svg(`<path d="M6 6l12 12M18 6 6 18"/>`),
  edit: svg(`<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>`),
  heart: svg(`<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/>`, 14),
  calendar: svg(`<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>`),
  plus: svg(`<path d="M12 5v14M5 12h14"/>`),
  trash: svg(`<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>`),
  left: svg(`<path d="m15 5-7 7 7 7"/>`),
  right: svg(`<path d="m9 5 7 7-7 7"/>`),
  check: svg(`<path d="m5 12.5 4.5 4.5L19 7.5"/>`),
  link: svg(`<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>`, 17),
};

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
const fmtLen = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s` : `${Math.round(sec)}s`);
const fileUrl = (p, rel) => `/files/${p.id}/${rel}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const pad = (n) => String(n).padStart(2, "0");
const dateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeInput = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const timeLabel = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const whenLabel = (d) => d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const startOfWeek = (d) => {
  const x = startOfDay(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const sameDay = (a, b) => a.toDateString() === b.toDateString();

async function api(url, { method = "GET", body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2400);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    toast("Couldn't access the clipboard");
  }
}

function statusChip(status) {
  if (LIVE.includes(status)) return `<span class="chip live">Processing</span>`;
  if (status === "error") return `<span class="chip error">Failed</span>`;
  if (status === "stopped") return `<span class="chip">Stopped</span>`;
  return `<span class="chip done">Ready</span>`;
}

function avatar(account, size = "") {
  const p = PLATFORMS[account?.platform] || { short: "?", color: "#888", label: "Removed account" };
  return `<span class="avatar ${size}" style="--c:${p.color}" title="${esc(account?.name ? `${account.name} · ${p.label}` : p.label)}">${p.short}</span>`;
}

const captionFor = (item) => [item.postTitle, item.caption, (item.hashtags || []).join(" ")].filter(Boolean).join("\n\n");

function stopPolling() {
  clearInterval(state.poll);
  state.poll = null;
}

// ---------- modal ----------
function openModal(html, { wide = false, className = "" } = {}) {
  closeModal();
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal ${wide ? "wide" : ""} ${className}" role="dialog" aria-modal="true">${html}</div>`;
  backdrop.addEventListener("mousedown", (e) => e.target === backdrop && closeModal());
  document.body.append(backdrop);
  document.body.classList.add("no-scroll");
  const modal = $(".modal", backdrop);
  $$("[data-close]", modal).forEach((b) => (b.onclick = closeModal));
  return modal;
}

function closeModal() {
  $(".modal-backdrop")?.remove();
  document.body.classList.remove("no-scroll");
}
document.addEventListener("keydown", (e) => e.key === "Escape" && closeModal());

// ---------- routing ----------
// Timeline editor (editor/, Timeline session): a full-screen workspace at #/edit/<project>/<clip>.
let unmountEditor = null;

async function route() {
  stopPolling();
  closeModal();
  unmountEditor?.();
  unmountEditor = null;
  const [pathPart, query = ""] = (location.hash || "#/").slice(1).split("?");
  const editMatch = pathPart.match(/^\/edit\/([\w-]+)\/([\w-]+)/);
  if (editMatch) {
    const { mountEditor } = await import("/api/editor/ui/editor.js");
    unmountEditor = await mountEditor(app, { projectId: editMatch[1], clipId: editMatch[2] });
    return;
  }
  // Intentional reels: the questions to ask him on camera, from everything the system has read.
  if (pathPart.startsWith("/reels")) {
    $$("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === "reels"));
    await showReels();
    window.scrollTo(0, 0);
    return;
  }
  // Analytics: how posted clips and channels are doing (analytics/, owned by the Analytics session).
  if (pathPart.startsWith("/analytics")) {
    $$("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === "analytics"));
    const { mountAnalytics } = await import("/api/analytics/ui/analytics.js");
    await mountAnalytics(app);
    window.scrollTo(0, 0);
    return;
  }
  // Assets: brand kit and resources (resources/, owned by the Assets session).
  if (pathPart.startsWith("/assets")) {
    $$("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === "assets"));
    const { mountAssets } = await import("/api/resources/ui/assets.js");
    await mountAssets(app);
    window.scrollTo(0, 0);
    return;
  }
  // Thumbnails: the thumbnail made for every video (thumbnails/, owned by the Thumbnails session).
  if (pathPart.startsWith("/thumbnails")) {
    $$("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === "thumbnails"));
    const { mountThumbnails } = await import("/api/thumbnails/ui/thumbnails.js");
    await mountThumbnails(app);
    window.scrollTo(0, 0);
    return;
  }
  const projectMatch = pathPart.match(/^\/p\/([\w-]+)/);
  const section =
    projectMatch || pathPart.startsWith("/projects")
      ? "projects"
      : pathPart.startsWith("/scheduler")
        ? "scheduler"
        : pathPart.startsWith("/study")
          ? "study"
          : pathPart.startsWith("/sounds")
            ? "sounds"
            : pathPart.startsWith("/titles")
              ? "titles"
              : "home";
  $$("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === section));

  if (projectMatch) {
    await showProject(projectMatch[1]);
    // "Classic editor" from the timeline editor lands here with ?edit=<clip>.
    const classic = new URLSearchParams(query).get("edit");
    if (classic && state.project?.clips?.some((c) => c.id === classic)) openEditor(classic);
  }
  else if (section === "projects") await showProjects();
  else if (section === "study") await showStudy();
  else if (section === "sounds") await showSounds();
  else if (section === "titles") await showTitles();
  else if (section === "scheduler") await showScheduler(new URLSearchParams(query).get("tab") || "review");
  else await showHome();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

// ---------- saved titles (titles/ module: every ♥'d title, by kind) ----------
const TITLE_KIND_LABEL = { youtube: "YouTube titles", hook: "Clip hooks", idea: "Title ideas", opener: "Openers", post: "Post titles" };

async function savedTitles() {
  const lib = await api("/api/titles").catch(() => ({ liked: [] }));
  state.savedTitles = [...(lib.liked || [])].reverse(); // newest first
  return state.savedTitles;
}

/** A "Saved titles" dropdown grouped by kind, for filling a title field. Empty when nothing is saved. */
function savedTitlesSelect(saved = state.savedTitles || []) {
  if (!saved.length) return "";
  const kinds = [...new Set(saved.map((t) => t.kind || "idea"))];
  return `<label class="field"><span>Saved titles</span><select data-saved-title>
    <option value="">Use one you ♥'d…</option>
    ${kinds
      .map((k) => `<optgroup label="${esc(TITLE_KIND_LABEL[k] || k)}">${saved.filter((t) => (t.kind || "idea") === k).map((t) => `<option>${esc(t.title)}</option>`).join("")}</optgroup>`)
      .join("")}
  </select></label>`;
}

function bindSavedTitles(root, onPick) {
  const select = $("[data-saved-title]", root);
  if (!select) return;
  select.onchange = () => {
    if (select.value) onPick(select.value);
    select.value = "";
  };
}

// ---------- what should this become? ----------
/** Asked right after picking a video: one finished Dope edit or several clips, with the options for that path. */
async function openIntent({ notes = "", onStart }) {
  const [tracks, styles, saved] = await Promise.all([api("/api/sounds").catch(() => []), api("/api/styles").catch(() => ({})), savedTitles()]);
  const draft = (state.intentDraft ??= {
    edit: { style: "promo", length: 15, pace: "balanced", trackId: "shuffle", voiceIntro: true, title: "" },
    clips: { style: "podcast", aspect: "9:16", notes: "" },
  });
  draft.long ??= { format: "youtube", tight: true, captions: false, callouts: false, slides: false };
  draft.mode = null; // always ask
  draft.clips.notes = notes || draft.clips.notes || "";
  if (!tracks.length) draft.edit.trackId = "none";
  const editStyles = Object.entries(styles).filter(([, s]) => s.kind === "edit");
  const paces = state.config.hfPaces || {};

  const modal = openModal(`
    <div class="modal-head">
      <div><h2>What should this become?</h2><p class="muted">Pick one — you can always make the other from the project page later.</p></div>
      <button type="button" class="icon-btn" data-close title="Close">${ICON.close}</button>
    </div>
    <div class="vibe-pick intent-pick">
      <button type="button" data-mode="edit"><b>Edit this footage</b><span>One finished 9:16 reel: your best moments cut to music in a style you studied.</span></button>
      <button type="button" data-mode="clips"><b>Cut clips from it</b><span>Several standalone shorts with captions and hook titles.</span></button>
      <button type="button" data-mode="long"><b>Edit the full video</b><span>The whole talk, tightened — as a YouTube video or a presentation.</span></button>
    </div>
    <div class="intent-body" data-for="long" hidden>
      <div class="vibe-pick format-pick" data-set="long.format">
        ${Object.entries(state.config.longFormats || { youtube: { label: "YouTube video", hint: "" }, presentation: { label: "Presentation", hint: "" } })
          .map(([id, f]) => `<button type="button" data-v="${id}"><b>${esc(f.label)}</b><span>${esc(f.hint)}</span></button>`)
          .join("")}
      </div>
      <div class="toggle-list">
        <label class="toggle"><input type="checkbox" data-check="long.tight" /><span class="track"></span>Cut rambles and tangents too <em class="muted">· filler, long pauses and retakes always go</em></label>
        <label class="toggle"><input type="checkbox" data-check="long.captions" /><span class="track"></span>Captions</label>
        <label class="toggle"><input type="checkbox" data-check="long.callouts" /><span class="track"></span>Key points on screen</label>
        <label class="toggle"><input type="checkbox" data-check="long.slides" /><span class="track"></span>Show my slides <em class="muted">· the pictures you added, as you get to them</em></label>
      </div>
      <label class="field"><span>Anything the edit should know? <em>· optional</em></span><textarea data-field="clips.notes" rows="2" maxlength="500" placeholder="e.g. keep the story about my first clinic, cut the tech trouble at the start"></textarea></label>
    </div>
    <div class="intent-body" data-for="edit" hidden>
      <div class="field"><span>Style</span><div class="segmented seg-fill" data-set="edit.style">${editStyles.map(([id, s]) => `<button type="button" data-v="${id}">${esc(s.label)}</button>`).join("")}</div></div>
      <div class="row2">
        <div class="field"><span>Length</span><div class="segmented seg-fill" data-set="edit.length">${(state.config.hfLengths || [15, 30, 45]).map((l) => `<button type="button" data-v="${l}">${l}s</button>`).join("")}</div></div>
        <div class="field"><span>Pace</span><div class="segmented seg-fill" data-set="edit.pace">${Object.entries(paces).map(([id, p]) => `<button type="button" data-v="${id}" title="${esc(p.hint)}">${esc(p.label)}</button>`).join("")}</div></div>
      </div>
      <label class="field"><span>Music</span><select data-field="edit.trackId">
        ${tracks.length ? `<option value="shuffle">Shuffle from my sounds (${tracks.length})</option>` : ""}
        <option value="none">Original sound — no music</option>
        ${tracks.map((t) => `<option value="${t.id}">${esc(t.name)}${t.bpm ? ` · ${t.bpm} BPM` : ""}</option>`).join("")}
      </select></label>
      <label class="toggle"><input type="checkbox" data-check="edit.voiceIntro" /><span class="track"></span>Open on something you say, then the music drops</label>
      <div class="row2">
        <label class="field"><span>Title <em>· optional</em></span><input data-field="edit.title" maxlength="60" placeholder="Leave empty to use the video's best hook" /></label>
        ${savedTitlesSelect(saved)}
      </div>
    </div>
    <div class="intent-body" data-for="clips" hidden>
      <div class="field"><span>Clip style</span><div class="segmented seg-fill" data-set="clips.style">${state.config.styles.map((s) => `<button type="button" data-v="${s.id}">${esc(s.label)}</button>`).join("")}</div></div>
      <div class="field"><span>Format</span><div class="segmented seg-fill" data-set="clips.aspect">${Object.keys(state.config.aspects).map((a) => `<button type="button" data-v="${a}">${a}</button>`).join("")}</div></div>
      <label class="field"><span>What should the clips focus on? <em>· optional</em></span><textarea data-field="clips.notes" rows="2" maxlength="500" placeholder="e.g. the money moments — punchy and contrarian"></textarea></label>
    </div>
    <div class="editor-actions"><span class="spacer"></span><button type="button" class="btn primary" data-start disabled>Pick one to start</button></div>`);

  const get = (key) => key.split(".").reduce((o, k) => o?.[k], draft);
  const set = (key, value) => {
    const [group, field] = key.split(".");
    draft[group][field] = value;
  };
  const sync = () => {
    $$("[data-mode]", modal).forEach((b) => b.classList.toggle("on", b.dataset.mode === draft.mode));
    $$("[data-for]", modal).forEach((el) => (el.hidden = el.dataset.for !== draft.mode));
    $$("[data-set]", modal).forEach((g) => $$("button", g).forEach((b) => b.classList.toggle("on", String(get(g.dataset.set)) === b.dataset.v)));
    $$("[data-field]", modal).forEach((i) => document.activeElement !== i && (i.value = get(i.dataset.field) ?? ""));
    $$("[data-check]", modal).forEach((i) => (i.checked = Boolean(get(i.dataset.check))));
    const start = $("[data-start]", modal);
    start.disabled = !draft.mode;
    start.textContent = draft.mode === "edit" ? "Start — make my edit" : draft.mode === "clips" ? "Start — find my clips" : draft.mode === "long" ? `Start — edit my ${draft.long.format === "presentation" ? "presentation" : "YouTube video"}` : "Pick one to start";
  };

  modal.addEventListener("click", (e) => {
    const mode = e.target.closest("[data-mode]");
    if (mode) {
      draft.mode = mode.dataset.mode;
      sync();
    }
    const option = e.target.closest("[data-set] button");
    if (option) {
      const key = option.closest("[data-set]").dataset.set;
      set(key, key === "edit.length" ? Number(option.dataset.v) : option.dataset.v);
      if (key === "long.format") {
        // A presentation shows its points and slides; a YouTube video stays clean. Both can be changed after.
        const deck = option.dataset.v === "presentation";
        Object.assign(draft.long, { captions: deck, callouts: deck, slides: deck });
      }
      sync();
    }
  });
  $$("[data-field]", modal).forEach((i) => (i.oninput = i.onchange = () => set(i.dataset.field, i.value)));
  $$("[data-check]", modal).forEach((i) => (i.onchange = () => set(i.dataset.check, i.checked)));
  bindSavedTitles(modal, (title) => {
    set("edit.title", title.slice(0, 60));
    sync();
  });
  $("[data-start]", modal).onclick = () => {
    if (!draft.mode) return;
    const { edit, clips, long } = draft;
    const intent =
      draft.mode === "edit"
        ? { mode: "edit", design: { style: edit.style, length: edit.length, pace: edit.pace, voiceIntro: edit.voiceIntro, title: edit.title }, trackId: edit.trackId }
        : draft.mode === "long"
          ? { mode: "long", design: longDesign(long) }
          : { mode: "clips", design: { style: clips.style, aspect: clips.aspect } };
    closeModal();
    onStart(intent, draft.mode === "edit" ? undefined : clips.notes);
  };
  sync();
}

const longDesign = (l) => ({ format: l.format, tightness: l.tight ? "tight" : "light", captions: l.captions, callouts: l.callouts, slides: l.slides });

// ---------- titles page ----------
async function showTitles() {
  app.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Titles</h1>
        <p class="muted">Every title and hook you ♥'d, saved for later — YouTube videos, edits, posts. Liking them also teaches new titles your style.</p>
      </div>
    </div>
    <section class="card title-chat" id="title-chat">
      <div class="tc-head">
        <div>
          <h2>Title ideas</h2>
          <p class="muted">Describe a video, a topic or a rough title. Ask for shorter, punchier, more like one you liked — it learns from everything you ♥.</p>
        </div>
        <div class="seg tc-kinds" id="tc-kinds">
          ${[["", "Any"], ["hook", "Clip hook"], ["post", "Post"], ["youtube", "YouTube"], ["idea", "Idea"]].map(([k, l]) => `<button type="button" data-k="${k}" class="${(state.titleChatKind || "") === k ? "on" : ""}">${l}</button>`).join("")}
        </div>
      </div>
      <div class="tc-log" id="tc-log"></div>
      <form class="tc-input" id="tc-form">
        <textarea id="tc-text" rows="2" maxlength="4000" placeholder="e.g. A video on why patients quit care after 3 visits and what we changed to keep them"></textarea>
        <button class="btn primary" id="tc-send">Get titles</button>
      </form>
    </section>
    <div id="titles-lib"><div class="loading">Loading…</div></div>`;
  bindTitleChat(() => render());

  const render = async () => {
    const liked = await savedTitles();
    const kinds = [...new Set(liked.map((t) => t.kind || "idea"))];
    const tab = state.titlesKind === "all" || kinds.includes(state.titlesKind) ? state.titlesKind : "all";
    const shown = tab === "all" ? liked : liked.filter((t) => (t.kind || "idea") === tab);
    const box = $("#titles-lib");
    if (!box) return;
    box.innerHTML = liked.length
      ? `<section class="card titles-card">
          <div class="tab-strip" id="lib-tabs">
            <button data-kind="all" class="${tab === "all" ? "on" : ""}">All<span class="count">${liked.length}</span></button>
            ${kinds.map((k) => `<button data-kind="${k}" class="${tab === k ? "on" : ""}">${esc(TITLE_KIND_LABEL[k] || k)}<span class="count">${liked.filter((t) => (t.kind || "idea") === k).length}</span></button>`).join("")}
          </div>
          <ol class="title-grid">
            ${shown
              .map(
                (t, i) => `<li class="title-row" data-i="${i}">
                  <div class="t-body"><div class="t-title">${esc(t.title)}</div><div class="t-meta">${esc([TITLE_KIND_LABEL[t.kind] || t.kind, t.editedFrom ? `edited from “${t.editedFrom}”` : "", t.addedAt ? new Date(t.addedAt).toLocaleDateString() : ""].filter(Boolean).join(" · "))}</div></div>
                  <div class="t-actions">
                    <button class="icon-btn" data-act="copy" title="Copy">${ICON.copy}</button>
                    <button class="icon-btn" data-act="remove" title="Remove from saved titles">${ICON.trash}</button>
                  </div>
                </li>`,
              )
              .join("")}
          </ol>
        </section>`
      : `<div class="empty">Nothing saved yet. Tap ♥ on titles and hooks in any project and they'll collect here.</div>`;
    $("#lib-tabs", box)?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-kind]");
      if (!b) return;
      state.titlesKind = b.dataset.kind;
      render();
    });
    $(".title-grid", box)?.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const t = shown[Number(b.closest("[data-i]").dataset.i)];
      if (b.dataset.act === "copy") return copy(t.title);
      try {
        await api("/api/titles/remove", { method: "POST", body: { title: t.title } });
        toast("Removed from saved titles");
        render();
      } catch (err) {
        toast(err.message);
      }
    });
  };
  render();
}

/**
 * Transcript editor inside the clip editor: the clip's words with what happens to each one. Click seeks the
 * preview; drag or shift-click selects; Cut strikes the selection out of the video; double-click fixes spelling.
 */
function bindTranscriptEditor(modal, clipId, player, onChange) {
  if (!document.querySelector("link[data-te-css]")) {
    document.head.insertAdjacentHTML("beforeend", '<link rel="stylesheet" href="/transcript-editor.css" data-te-css />');
  }
  const box = $("[data-te-words]", modal);
  const bar = $("[data-te-bar]", modal);
  const route = `/api/projects/${state.project.id}/clips/${clipId}`;
  let data = null;
  let flat = [];
  let anchor = null;
  let selection = null; // [from, to] indexes into flat
  let dragging = false;

  const paintSelection = () => {
    $$(".tw", box).forEach((el) => {
      const i = Number(el.dataset.i);
      el.classList.toggle("sel", Boolean(selection) && i >= selection[0] && i <= selection[1]);
    });
    bar.hidden = !selection;
    if (selection) $("[data-te-count]", bar).textContent = `${selection[1] - selection[0] + 1} word${selection[1] > selection[0] ? "s" : ""} selected`;
  };
  const draw = () => {
    if (!data) return;
    flat = [];
    box.innerHTML = data.sections
      .map((section) => {
        const spans = section.words
          .map((w) => {
            const i = flat.push(w) - 1;
            const cls = ["tw", w.cut ? "cut" : "", w.removed ? "auto" : "", w.said ? "fixed" : ""].filter(Boolean).join(" ");
            const tip = w.said ? `said: ${w.said}` : w.removed ? "trimmed automatically" : w.cut ? "cut by you" : "";
            return `<span class="${cls}" data-i="${i}"${tip ? ` title="${esc(tip)}"` : ""}>${esc(w.text)}</span>`;
          })
          .join(" ");
        return `<div class="te-section${section.hook ? " hook" : ""}">${section.hook ? '<div class="te-label">Hook</div>' : ""}<p>${spans}</p></div>`;
      })
      .join("");
    paintSelection();
  };
  const load = async () => {
    try {
      data = await api(`${route}/words`);
      draw();
    } catch (err) {
      box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  };
  const patch = async (body) => {
    const updated = await api(route, { method: "PATCH", body });
    Object.assign(state.project.clips.find((c) => c.id === clipId), updated);
    selection = null;
    await load();
    onChange?.();
  };

  box.onmousedown = (e) => {
    const el = e.target.closest(".tw");
    if (!el || e.detail > 1) return;
    const i = Number(el.dataset.i);
    if (e.shiftKey && anchor !== null) {
      selection = [Math.min(anchor, i), Math.max(anchor, i)];
    } else {
      anchor = i;
      selection = null;
      dragging = true;
    }
    paintSelection();
  };
  box.onmouseover = (e) => {
    if (!dragging) return;
    const el = e.target.closest(".tw");
    if (!el) return;
    const i = Number(el.dataset.i);
    selection = i === anchor ? null : [Math.min(anchor, i), Math.max(anchor, i)];
    paintSelection();
  };
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    const el = e.target.closest?.(".tw");
    // A plain click (no drag) jumps the preview to that word.
    if (!selection && el) {
      const w = flat[Number(el.dataset.i)];
      if (w?.t != null) {
        try {
          player.seek?.(w.t);
          player.play?.();
        } catch {
          // preview still loading
        }
      }
    }
  };
  modal.addEventListener("mouseup", endDrag);

  box.ondblclick = (e) => {
    const el = e.target.closest(".tw");
    if (!el) return;
    const w = flat[Number(el.dataset.i)];
    selection = null;
    paintSelection();
    const input = document.createElement("input");
    input.className = "te-fix";
    input.value = w.text;
    input.maxLength = 60;
    el.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const text = input.value.trim();
      if (!commit || text === w.text) return draw();
      try {
        await patch({ wordFixes: { [w.key]: text || null } });
        toast(text ? "Word fixed" : "Word reset");
      } catch (err) {
        toast(err.message);
        draw();
      }
    };
    input.onkeydown = (ev) => {
      if (ev.key === "Enter") finish(true);
      if (ev.key === "Escape") finish(false);
    };
    input.onblur = () => finish(true);
  };

  bar.onclick = async (e) => {
    const b = e.target.closest("[data-te-act]");
    if (!b || !selection) return;
    if (b.dataset.teAct === "clear") {
      selection = null;
      return paintSelection();
    }
    const picked = flat.slice(selection[0], selection[1] + 1);
    const from = picked[0].start - 0.02;
    const to = picked.at(-1).end + 0.02;
    let cuts = [...(data.cuts || [])];
    if (b.dataset.teAct === "cut") cuts.push({ start: from, end: to });
    else {
      cuts = cuts.flatMap((c) =>
        c.end <= from || c.start >= to ? [c] : [...(c.start < from ? [{ start: c.start, end: from }] : []), ...(c.end > to ? [{ start: to, end: c.end }] : [])],
      );
    }
    cuts = cuts.filter((c) => c.end - c.start >= 0.05);
    cuts.sort((a, b2) => a.start - b2.start);
    const merged = [];
    for (const c of cuts) {
      const last = merged.at(-1);
      if (last && c.start <= last.end + 0.05) last.end = Math.max(last.end, c.end);
      else merged.push({ ...c });
    }
    try {
      await patch({ cuts: merged });
      toast(b.dataset.teAct === "cut" ? "Cut from the clip" : "Restored");
    } catch (err) {
      toast(err.message);
    }
  };

  // Follow along: the word being spoken is underlined as the preview plays.
  player.addEventListener("timeupdate", () => {
    const now = player.currentTime;
    if (!Number.isFinite(now) || !flat.length) return;
    let playing = -1;
    flat.forEach((w, i) => {
      if (w.t != null && w.t <= now + 0.05) playing = i;
    });
    $$(".tw.now", box).forEach((el) => el.classList.remove("now"));
    if (playing >= 0) box.querySelector(`.tw[data-i="${playing}"]`)?.classList.add("now");
  });
  load();
}

/** The title ideas chat: the conversation lives in state for the session; ♥ saves a title to the library. */
function bindTitleChat(onSaved) {
  state.titleChat ??= [];
  const log = $("#tc-log");
  const form = $("#tc-form");
  const text = $("#tc-text");
  const draw = () => {
    log.innerHTML = state.titleChat.length
      ? state.titleChat
          .map((m, mi) =>
            m.role === "user"
              ? `<div class="tc-msg me">${esc(m.content)}</div>`
              : `<div class="tc-msg them">
                  ${m.error ? `<p class="tc-error">${esc(m.error)}</p>` : `<p>${esc(m.reply || "")}</p>`}
                  ${(m.titles || []).length ? `<ol class="tc-titles">${m.titles.map((t, ti) => `<li class="title-row" data-m="${mi}" data-t="${ti}">
                      <div class="t-body"><div class="t-title">${esc(t.title)}</div><div class="t-meta">${esc([TITLE_KIND_LABEL[t.kind] || t.kind, t.why].filter(Boolean).join(" · "))}</div></div>
                      <div class="t-actions tc-actions">
                        <button class="icon-btn${t.saved ? " on" : ""}" data-act="save" title="${t.saved ? "Saved" : "Save to titles"}">♥</button>
                        <button class="icon-btn" data-act="copy" title="Copy">${ICON.copy}</button>
                      </div></li>`).join("")}</ol>` : ""}
                </div>`,
          )
          .join("")
      : `<div class="tc-empty muted">Your ideas and the titles for them show up here.</div>`;
    log.scrollTop = log.scrollHeight;
  };
  const send = async () => {
    const content = text.value.trim();
    if (!content || form.classList.contains("busy")) return;
    state.titleChat.push({ role: "user", content });
    text.value = "";
    form.classList.add("busy");
    $("#tc-send").disabled = true;
    $("#tc-send").textContent = "Thinking…";
    draw();
    try {
      // The model sees its earlier answers as the titles it gave, so "more like the third one" works.
      const messages = state.titleChat.map((m) =>
        m.role === "user" ? m : { role: "assistant", content: m.error ? "(no titles)" : `${m.reply || ""}\n${(m.titles || []).map((t, i) => `${i + 1}. ${t.title}`).join("\n")}` },
      );
      const res = await api("/api/title-chat", { method: "POST", body: { messages, kind: state.titleChatKind || null } });
      state.titleChat.push({ role: "assistant", reply: res.reply, titles: res.titles });
    } catch (err) {
      state.titleChat.push({ role: "assistant", error: err.message });
    } finally {
      form.classList.remove("busy");
      $("#tc-send").disabled = false;
      $("#tc-send").textContent = "Get titles";
      draw();
      text.focus();
    }
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    send();
  };
  text.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  $("#tc-kinds").onclick = (e) => {
    const b = e.target.closest("[data-k]");
    if (!b) return;
    state.titleChatKind = b.dataset.k;
    $$("#tc-kinds [data-k]").forEach((x) => x.classList.toggle("on", x === b));
  };
  log.onclick = async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const row = b.closest("[data-m]");
    const t = state.titleChat[Number(row.dataset.m)].titles[Number(row.dataset.t)];
    if (b.dataset.act === "copy") return copy(t.title);
    if (t.saved) return;
    try {
      await api("/api/titles/liked", { method: "POST", body: { title: t.title, kind: t.kind, source: "title-chat" } });
      t.saved = true;
      toast("Saved to titles");
      draw();
      onSaved?.();
    } catch (err) {
      toast(err.message);
    }
  };
  draw();
}

// ---------- home ----------
const sizeLabel = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`);

async function showHome() {
  state.project = null;
  const icon = (path, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  app.innerHTML = `
    <div class="home">
      <div class="home-main">
        <section class="card home-hero">
          <div class="hh-top">
            <div class="hh-copy">
              <h1>One video in.<br /><span>Viral clips out.</span></h1>
              <p class="lede">Upload a long video or drop a link. We'll find the best moments, add captions, and get them ready to post — in minutes.</p>
              <div class="source-row">
                <button type="button" class="source-btn yt" data-source="YouTube" title="Paste a YouTube link"><svg viewBox="0 0 24 24" width="22" height="22"><rect x="2" y="5" width="20" height="14" rx="4.5" fill="#FF0033"/><path d="m10 9 5 3-5 3z" fill="#fff"/></svg></button>
                <button type="button" class="source-btn" data-source="TikTok" title="Paste a TikTok link"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M14.5 3h2.7a4.6 4.6 0 0 0 3.8 3.9v2.8a7.3 7.3 0 0 1-3.8-1.2v6.6A5.6 5.6 0 1 1 11.6 9.5v2.9a2.8 2.8 0 1 0 2.9 2.8z" fill="#25F4EE" transform="translate(-.6 -.4)"/><path d="M14.5 3h2.7a4.6 4.6 0 0 0 3.8 3.9v2.8a7.3 7.3 0 0 1-3.8-1.2v6.6A5.6 5.6 0 1 1 11.6 9.5v2.9a2.8 2.8 0 1 0 2.9 2.8z" fill="#FE2C55" transform="translate(.6 .4)"/><path d="M14.5 3h2.7a4.6 4.6 0 0 0 3.8 3.9v2.8a7.3 7.3 0 0 1-3.8-1.2v6.6A5.6 5.6 0 1 1 11.6 9.5v2.9a2.8 2.8 0 1 0 2.9 2.8z" fill="#fff"/></svg></button>
                <button type="button" class="source-btn" data-source="Instagram" title="Paste an Instagram link"><svg viewBox="0 0 24 24" width="22" height="22"><defs><radialGradient id="ig-g" cx="30%" cy="107%" r="150%"><stop offset="0" stop-color="#fdf497"/><stop offset=".1" stop-color="#fdf497"/><stop offset=".5" stop-color="#fd5949"/><stop offset=".68" stop-color="#d6249f"/><stop offset="1" stop-color="#285AEB"/></radialGradient></defs><rect x="2" y="2" width="20" height="20" rx="6" fill="url(#ig-g)"/><rect x="6.5" y="6.5" width="11" height="11" rx="3.5" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="12" cy="12" r="2.6" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="16.4" cy="7.6" r="1" fill="#fff"/></svg></button>
                <button type="button" class="source-btn" data-source="link" title="Paste any video link">${icon(`<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>`)}</button>
                <label class="btn upload-file" for="file">${icon(`<path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>`, 17)} Upload file</label>
              </div>
            </div>
            <div class="hh-art" id="hero-art" aria-hidden="true"></div>
          </div>

          <form id="upload" class="upload">
            <div class="upload-drop">
              <label id="dropzone" class="dropzone">
                <input id="file" type="file" accept="video/*,.mov,.mkv,.m4v,image/*,.heic,.heif,application/pdf,.pdf" multiple hidden />
                <div class="dz-icon">${ICON.upload}</div>
                <div class="dz-title">Drop your videos here</div>
                <div class="dz-sub">one or several videos · add pictures or PDFs for context · or click to browse</div>
              </label>
              <div id="chip" class="file-chip" hidden></div>
            </div>
            <div class="link-row">
              <span class="link-icon">${ICON.link}</span>
              <input id="link" type="url" inputmode="url" autocomplete="off" placeholder="Paste a YouTube, TikTok or Instagram link…" />
              <button id="submit" class="btn primary" disabled>Generate clips ${icon(`<path d="M5 12h14m-5-5 5 5-5 5"/>`, 16)}</button>
            </div>
            <div id="progress" class="upload-progress" hidden><div class="bar"><i></i></div><span>0%</span></div>
            <div class="options">
              <label class="opt">
                <span class="opt-icon">${icon(`<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.3 3.5 5 3.5 8s-1 5.7-3.5 8c-2.5-2.3-3.5-5-3.5-8s1-5.7 3.5-8z"/>`, 16)}</span>
                <span class="opt-body"><small>Language</small>
                  <select name="language">
                    <option value="en">English</option>
                    <option value="auto">Auto-detect</option>
                    <option value="es">Spanish</option>
                    <option value="fr">French</option>
                    <option value="de">German</option>
                    <option value="pt">Portuguese</option>
                  </select>
                </span>
              </label>
              <label class="opt">
                <span class="opt-icon">${icon(`<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M10.5 10.2a2.2 2.2 0 1 0 0 3.6M16.5 10.2a2.2 2.2 0 1 0 0 3.6"/>`, 16)}</span>
                <span class="opt-body"><small>Captions</small>
                  <select name="captionQuality">
                    ${Object.entries(state.config?.captionQuality || { standard: { label: "Standard", hint: "Fast", installed: true } })
                      .map(([id, l]) => `<option value="${id}">${esc(l.label)} · ${esc(l.hint)}${l.installed ? "" : ` · downloads ${sizeLabel(l.sizeMb)} once`}</option>`)
                      .join("")}
                  </select>
                </span>
              </label>
              <label class="opt opt-wide">
                <span class="opt-icon">${icon(`<path d="M12 3.5 14 9l5.5 2-5.5 2-2 5.5-2-5.5-5.5-2L10 9z"/>`, 16)}</span>
                <span class="opt-body"><small>Notes for the AI · optional</small>
                  <input name="notes" maxlength="500" placeholder="Audience, niche or tone — e.g. chiropractors, calm and expert" />
                </span>
              </label>
            </div>
          </form>
        </section>

        <section class="recent">
          <div class="section-head"><h2>Recent projects</h2><a class="link-btn" href="#/projects">View all →</a></div>
          <div id="projects" class="project-grid recent-grid"></div>
        </section>
      </div>

      <aside class="home-rail">
        <section class="card rail-card" id="week-card"><div class="rail-head"><h3>This week</h3></div><div class="stat-list"><div class="loading-row"></div></div></section>
        <section class="card rail-card" id="cal-card"></section>
        <section class="card rail-card" id="activity-card"><div class="rail-head"><h3>Recent activity</h3></div><div class="loading-row"></div></section>
      </aside>
    </div>`;

  bindUpload();
  $$("[data-source]").forEach(
    (b) =>
      (b.onclick = () => {
        const link = $("#link");
        const kind = b.dataset.source;
        link.placeholder = kind === "link" ? "Paste any video link…" : `Paste a ${kind} link…`;
        link.focus();
      }),
  );

  const projects = await api("/api/projects").catch(() => []);
  $("#projects").innerHTML = projects.length ? projects.slice(0, 4).map(projectCard).join("") : `<div class="empty">Your projects will show up here.</div>`;
  bindProjectDeletes($("#projects"));
  renderHeroArt(projects);
  loadDashboard(projects);
}

/** Tilted stack of the latest videos beside the headline — real posters, or nothing. */
function renderHeroArt(projects) {
  const art = $("#hero-art");
  if (!art) return;
  const shots = projects.filter((p) => p.status !== "error").slice(0, 3);
  if (!shots.length) return art.remove();
  const lead = shots[0];
  art.innerHTML = `
    <span class="hh-note hh-note-1">Turn this…</span>
    <svg class="hh-arrow hh-arrow-1" viewBox="0 0 60 40"><path d="M4 8c16 2 30 10 44 24m0 0-2-11m2 11-11-2" /></svg>
    <span class="hh-note hh-note-2">Into this.</span>
    <svg class="hh-arrow hh-arrow-2" viewBox="0 0 40 60"><path d="M8 4c-4 18 2 34 22 48m0 0-11 1m11-1-2-11" /></svg>
    <div class="hh-stack">
      ${shots
        .slice(1)
        .reverse()
        .map((p, i) => `<div class="hh-card hh-back hh-back-${i + 1}"><img src="/files/${p.id}/poster.jpg" alt="" onerror="this.remove()" /></div>`)
        .join("")}
      <a class="hh-card hh-front" href="#/p/${lead.id}">
        <img src="/files/${lead.id}/poster.jpg" alt="" onerror="this.remove()" />
        <span class="hh-caption">${esc(lead.name)}</span>
        <span class="hh-play">${ICON.play}${lead.duration ? `<b>${fmt(lead.duration)}</b>` : ""}</span>
      </a>
    </div>
    <span class="hh-pill"><i></i>Auto captions. AI clips. Ready to post.</span>`;
}

const dayLabel = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 864e5);
  if (days === 0) return `Today, ${timeLabel(d)}`;
  if (days === 1) return `Yesterday, ${timeLabel(d)}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
};

const agoLabel = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/** Right rail on Home: this week's numbers, the posting calendar and recent activity — all from real data. */
async function loadDashboard(projects) {
  const [posts, accounts, pubs] = await Promise.all([
    api("/api/posts").catch(() => []),
    api("/api/accounts").catch(() => []),
    api("/api/integrations/instagram/publications").catch(() => []),
  ]);
  if (!$("#week-card")) return;
  const now = Date.now();
  const week = 7 * 864e5;
  const inRange = (iso, from, to) => {
    const t = new Date(iso).getTime();
    return t >= from && t < to;
  };
  const stat = (iconPath, value, label, delta, href) => `
    <a class="stat" ${href ? `href="${href}"` : ""}>
      <span class="stat-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconPath}</svg></span>
      <span class="stat-text"><b>${value}</b><small>${label}</small></span>
      ${delta || ""}
    </a>`;
  const deltaOf = (cur, prev) => (prev > 0 ? `<span class="delta ${cur >= prev ? "up" : "down"}">${cur >= prev ? "↑" : "↓"} ${Math.abs(Math.round((100 * (cur - prev)) / prev))}%</span>` : "");
  const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));

  // This week
  const clipsIn = (from, to) => projects.filter((p) => inRange(p.createdAt, from, to)).reduce((n, p) => n + (p.clipCount || 0), 0);
  const clipsNow = clipsIn(now - week, now + 1);
  const clipsPrev = clipsIn(now - 2 * week, now - week);
  const targets = posts.flatMap((p) => p.targets.map((t) => ({ ...t, post: p })));
  const upcoming = targets.filter((t) => ["scheduled", "due", "publishing"].includes(t.status) && new Date(t.post.scheduledAt).getTime() < now + week).length;
  const postedNow = targets.filter((t) => t.status === "published" && inRange(t.publishedAt || t.post.scheduledAt, now - week, now + 1)).length;
  const withInsights = pubs.filter((x) => x.insights);
  const views = withInsights.reduce((n, x) => n + (Number(x.insights.views ?? x.insights.plays ?? x.insights.reach) || 0), 0);
  const likes = withInsights.reduce((n, x) => n + (Number(x.insights.likes) || 0), 0);
  $("#week-card .stat-list").innerHTML = [
    stat(`<path d="M5 20V13M10 20V8M15 20v-5M20 20V4"/>`, clipsNow, "Clips generated", deltaOf(clipsNow, clipsPrev), "#/projects"),
    stat(`<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>`, upcoming, postedNow ? `Scheduled · ${postedNow} posted` : "Posts scheduled", "", "#/scheduler?tab=calendar"),
    withInsights.length
      ? stat(`<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>`, compact(views), likes ? `Views · ${compact(likes)} likes` : "Total views", "", "#/scheduler?tab=accounts")
      : stat(`<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>`, "—", "Views · connect Instagram", "", "/api/integrations/instagram/connect"),
  ].join("");

  // Calendar
  const month = (state.homeMonth ??= startOfDay(new Date(new Date().getFullYear(), new Date().getMonth(), 1)));
  const renderCal = () => {
    const m = state.homeMonth;
    const first = new Date(m.getFullYear(), m.getMonth(), 1);
    const daysIn = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7;
    const postDays = new Set(posts.map((p) => startOfDay(new Date(p.scheduledAt)).toDateString()));
    const today = new Date();
    const cells = [
      ...Array.from({ length: lead }, () => `<span></span>`),
      ...Array.from({ length: daysIn }, (_, i) => {
        const d = new Date(m.getFullYear(), m.getMonth(), i + 1);
        const cls = [sameDay(d, today) ? "today" : "", postDays.has(d.toDateString()) ? "has-post" : ""].join(" ");
        return `<a class="${cls}" href="#/scheduler?tab=calendar">${i + 1}</a>`;
      }),
    ];
    const next = posts.filter((p) => new Date(p.scheduledAt).getTime() >= now && p.targets.some((t) => t.status !== "published"))[0];
    const acctOf = (id) => accounts.find((a) => a.id === id);
    $("#cal-card").innerHTML = `
      <div class="rail-head">
        <h3>${m.toLocaleDateString([], { month: "long", year: "numeric" })}</h3>
        <div class="cal-nav"><button class="icon-btn" data-cal="-1" title="Previous month">${ICON.left}</button><button class="icon-btn" data-cal="1" title="Next month">${ICON.right}</button></div>
      </div>
      <div class="mini-cal">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<b>${d}</b>`).join("")}${cells.join("")}</div>
      ${
        next
          ? `<a class="next-post" href="#/scheduler?tab=calendar">
              <img src="/files/${next.projectId}/poster.jpg" alt="" onerror="this.style.visibility='hidden'" />
              <span class="np-text"><b>${esc(next.title || "Scheduled clip")}</b><small>${dayLabel(next.scheduledAt)}</small></span>
              <span class="avatars">${next.targets.map((t) => avatar(acctOf(t.accountId), "sm")).join("")}</span>
            </a>`
          : `<p class="rail-empty">Nothing scheduled yet. Render a clip, then schedule it.</p>`
      }
      <a class="btn rail-btn" href="#/scheduler">Open Scheduler ${ICON.right}</a>`;
    $$("[data-cal]", $("#cal-card")).forEach(
      (b) =>
        (b.onclick = () => {
          state.homeMonth = new Date(m.getFullYear(), m.getMonth() + Number(b.dataset.cal), 1);
          renderCal();
        }),
    );
  };
  if (month) renderCal();

  // Recent activity
  const ICONS = {
    check: `<path d="m5 12.5 4.5 4.5L19 7.5"/>`,
    upload: `<path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>`,
    cal: `<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>`,
    send: `<path d="M20.5 3.5 10 14M20.5 3.5 14 20.5l-4-6.5-6.5-4z"/>`,
    alert: `<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5M12 16h.01"/>`,
    spin: `<path d="M12 4a8 8 0 1 0 8 8"/>`,
  };
  const events = [
    ...projects.map((p) =>
      p.status === "ready"
        ? { icon: "check", tone: "ok", text: `${plural(p.clipCount, "clip")} ready`, sub: p.name, at: p.createdAt, href: `#/p/${p.id}` }
        : p.status === "error"
          ? { icon: "alert", tone: "bad", text: "Processing failed", sub: p.name, at: p.createdAt, href: `#/p/${p.id}` }
          : { icon: "spin", tone: "live", text: "Processing video", sub: p.name, at: p.createdAt, href: `#/p/${p.id}` },
    ),
    ...posts.map((p) => ({ icon: "cal", text: "Post scheduled", sub: p.title || p.projectName, at: p.createdAt, href: "#/scheduler?tab=calendar" })),
    ...targets.filter((t) => t.status === "published").map((t) => ({ icon: "send", tone: "ok", text: `Posted to ${PLATFORMS[acctOf(t.accountId)?.platform]?.label || "account"}`, sub: t.post.title, at: t.publishedAt || t.post.scheduledAt, href: "#/scheduler?tab=calendar" })),
  ]
    .filter((e) => e.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 5);
  function acctOf(id) {
    return accounts.find((a) => a.id === id);
  }
  $("#activity-card").innerHTML = `
    <div class="rail-head"><h3>Recent activity</h3></div>
    ${
      events.length
        ? `<ul class="activity">${events
            .map(
              (e) => `<li><a href="${e.href}">
                <span class="act-icon ${e.tone || ""}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[e.icon]}</svg></span>
                <span class="act-text"><b>${esc(e.text)}</b><small>${esc(e.sub || "")}</small></span>
                <time>${agoLabel(e.at)}</time>
              </a></li>`,
            )
            .join("")}</ul>`
        : `<p class="rail-empty">Upload a video to get started.</p>`
    }
    <a class="btn rail-btn" href="#/projects">View all ${ICON.right}</a>`;
}

function bindUpload() {
  const form = $("#upload");
  const input = $("#file");
  const zone = $("#dropzone");
  const chip = $("#chip");
  const link = $("#link");
  let files = [];
  const updateSubmit = () => ($("#submit").disabled = !files.length && !/^https?:\/\/\S+\.\S+/i.test(link.value.trim()));
  // The hero's "Upload file" button opens the same picker; drops anywhere on the upload card count too.
  form.addEventListener("dragover", (e) => e.preventDefault());
  form.addEventListener("drop", (e) => {
    if (e.target.closest("#dropzone")) return;
    e.preventDefault();
    choose(e.dataTransfer.files);
  });
  link.oninput = updateSubmit;

  // Videos (one or a batch: each becomes its own project, processed one after another) plus any pictures and PDFs,
  // which go along with every video as context for Claude. Picking again adds to what's already chosen.
  let materials = [];
  const isVideo = (f) => f.type.startsWith("video/") || /\.(mov|mkv|mp4|webm|m4v|avi)$/i.test(f.name);
  const isMaterial = (f) => f.type.startsWith("image/") || f.type === "application/pdf" || /\.(jpe?g|png|gif|webp|heic|heif|tiff?|bmp|pdf)$/i.test(f.name);
  const same = (a, b) => a.name === b.name && a.size === b.size;
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const drawChip = () => {
    if (!files.length && !materials.length) {
      chip.hidden = true;
      zone.hidden = false;
      return updateSubmit();
    }
    zone.hidden = true;
    chip.hidden = false;
    const pics = materials.filter((f) => !/pdf/i.test(f.type) && !/\.pdf$/i.test(f.name)).length;
    const pdfs = materials.length - pics;
    const total = [...files, ...materials].reduce((sum, f) => sum + f.size, 0);
    const summary = [files.length && count(files.length, "video", "videos"), pics && count(pics, "picture", "pictures"), pdfs && count(pdfs, "PDF", "PDFs")].filter(Boolean).join(" · ");
    const first = files[0] || materials.find((f) => f.type.startsWith("image/"));
    chip.innerHTML = `
      ${files[0] ? `<video src="${URL.createObjectURL(files[0])}#t=1" muted preload="metadata"></video>` : first ? `<img src="${URL.createObjectURL(first)}" alt="" />` : ""}
      <div class="grow">
        <div class="name">${files.length === 1 && !materials.length ? esc(files[0].name) : summary}</div>
        <div class="meta">${files.length ? "" : "Add a video too — pictures and PDFs go along with it · "}${esc([...files, ...materials].map((f) => f.name).join(", ")).slice(0, 120)} · ${(total / 1e6).toFixed(1)} MB</div>
      </div>
      <button type="button" class="btn sm ghost" data-add-more>${ICON.plus} Add more</button>
      <button type="button" class="icon-btn" data-clear title="Remove all">${ICON.close}</button>`;
    $("[data-add-more]", chip).onclick = () => input.click();
    $("[data-clear]", chip).onclick = () => {
      files = [];
      materials = [];
      input.value = "";
      drawChip();
    };
    updateSubmit();
  };
  const choose = (list) => {
    const all = [...(list || [])];
    const videos = all.filter(isVideo);
    const extras = all.filter((f) => !isVideo(f) && isMaterial(f));
    const skipped = all.length - videos.length - extras.length;
    if (skipped) toast(`${count(skipped, "file", "files")} skipped — use videos, pictures or PDFs`);
    if (!videos.length && !extras.length) return;
    files = [...files, ...videos.filter((f) => !files.some((g) => same(f, g)))];
    materials = [...materials, ...extras.filter((f) => !materials.some((g) => same(f, g)))].slice(0, 20);
    input.value = "";
    drawChip();
  };

  input.onchange = () => choose(input.files);
  zone.ondragover = (e) => {
    e.preventDefault();
    zone.classList.add("over");
  };
  zone.ondragleave = () => zone.classList.remove("over");
  zone.ondrop = (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    choose(e.dataTransfer.files);
  };

  // Ask what this video should become before anything uploads.
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!files.length && !link.value.trim()) return;
    openIntent({ notes: form.elements.notes.value, onStart: (intent, notes) => startImport(intent, notes) });
  };

  const startImport = (intent, notes) => {
    const progress = $("#progress");
    const url = link.value.trim();
    if (!files.length && !url) return;
    if (notes !== undefined) form.elements.notes.value = notes;
    $("#submit").disabled = true;
    progress.hidden = false;

    // Dropped files win; otherwise import the pasted link.
    if (!files.length) {
      $("span", progress).textContent = "Fetching video…";
      api("/api/projects/import", { method: "POST", body: { url, language: form.elements.language.value, notes: form.elements.notes.value, captionQuality: form.elements.captionQuality.value, intent } })
        .then(async (res) => {
          if (materials.length) {
            $("span", progress).textContent = "Adding your pictures and PDFs…";
            const data = new FormData();
            for (const f of materials) data.append("materials", f);
            await fetch(`/api/projects/${res.id}/materials`, { method: "POST", body: data }).catch(() => toast("The video is importing, but the pictures and PDFs didn't upload"));
          }
          location.hash = `#/p/${res.id}`;
        })
        .catch((err) => {
          toast(err.message);
          progress.hidden = true;
          updateSubmit();
        });
      return;
    }

    const sendOne = (file, n) =>
      new Promise((resolve, reject) => {
        const data = new FormData(form);
        data.append("video", file);
        for (const m of materials) data.append("materials", m);
        data.append("intent", JSON.stringify(intent));
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/projects");
        xhr.upload.onprogress = (ev) => {
          const pct = Math.round((100 * ev.loaded) / ev.total);
          const overall = Math.round((100 * (n + ev.loaded / ev.total)) / files.length);
          $("i", progress).style.width = `${overall}%`;
          $("span", progress).textContent = files.length > 1 ? `Uploading ${n + 1} of ${files.length} · ${pct}%` : pct < 100 ? `Uploading ${pct}%` : "Starting…";
        };
        xhr.onload = () => {
          const res = JSON.parse(xhr.responseText || "{}");
          if (xhr.status >= 300) reject(new Error(`${file.name}: ${res.error || "upload failed"}`));
          else resolve(res);
        };
        xhr.onerror = () => reject(new Error(`${file.name}: upload failed`));
        xhr.send(data);
      });

    (async () => {
      const made = [];
      for (const [n, file] of files.entries()) {
        try {
          made.push(await sendOne(file, n));
        } catch (err) {
          toast(err.message);
        }
      }
      if (!made.length) {
        $("#submit").disabled = false;
        progress.hidden = true;
        return;
      }
      if (made.length > 1) toast(`${made.length} videos queued — they'll process one after another`);
      location.hash = made.length === 1 ? `#/p/${made[0].id}` : "#/projects";
    })();
  };
}

function projectCard(p) {
  const busy = LIVE.includes(p.status);
  return `
    <article class="card project-card">
      <a class="project-link" href="#/p/${p.id}">
        <div class="thumb">
          <img src="/files/${p.id}/poster.jpg" alt="" onerror="this.remove()" />
          ${busy || p.status === "error" || p.status === "stopped" ? `<span class="thumb-status">${statusChip(p.status)}</span>` : ""}
          ${p.duration ? `<span class="thumb-time">${fmt(p.duration)}</span>` : ""}
        </div>
        <div class="info">
          <div class="name">${esc(p.name)}</div>
          <div class="meta">${[dayLabel(p.createdAt), p.clipCount ? `${plural(p.clipCount, "clip")}${p.renderedCount ? ` · ${p.renderedCount} rendered` : ""}` : busy ? "Processing" : ""].filter(Boolean).join(" · ")}</div>
        </div>
      </a>
      <button class="icon-btn card-delete" data-delete-project="${p.id}" data-name="${esc(p.name)}" title="Delete project">${ICON.trash}</button>
    </article>`;
}

function bindProjectDeletes(root = document) {
  $$("[data-delete-project]", root).forEach((b) => (b.onclick = () => removeProject(b.dataset.deleteProject, b.dataset.name)));
}

async function removeProject(id, name) {
  if (!confirm(`Delete "${name}"?\n\nThis removes the video, its clips and renders, and any posts scheduled from it. It can't be undone.`)) return;
  try {
    await api(`/api/projects/${id}`, { method: "DELETE" });
    toast("Project deleted");
    refreshBadge();
    if (location.hash.startsWith(`#/p/${id}`)) location.hash = "#/projects";
    else route();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- projects ----------
async function showProjects() {
  app.innerHTML = `
    <div class="page-head">
      <div><h1>Projects</h1><p class="muted">Every video you've turned into clips.</p></div>
      <a class="btn primary" href="#/">${ICON.plus} New project</a>
    </div>
    <section class="card audience" id="audience"></section>
    <section class="card yt-watch" id="yt-watch"></section>
    <div id="projects" class="project-grid"></div>`;
  renderAudience();
  renderChannelWatch();
  const projects = await api("/api/projects").catch(() => []);
  $("#projects").innerHTML = projects.length
    ? projects.map(projectCard).join("")
    : `<div class="empty">No projects yet. <a class="link-btn" href="#/">Upload a video →</a></div>`;
  bindProjectDeletes($("#projects"));
}

/** Connected YouTube channels: every new long video is clipped automatically and its best clips rendered for review. */
async function renderChannelWatch() {
  const box = $("#yt-watch");
  if (!box) return;
  const channels = await api("/api/youtube/channels").catch(() => []);
  const ago = (iso) => {
    if (!iso) return "not checked yet";
    const min = Math.round((Date.now() - new Date(iso)) / 60000);
    return min < 1 ? "checked just now" : min < 60 ? `checked ${min} min ago` : `checked ${Math.round(min / 60)} h ago`;
  };
  box.innerHTML = `
    <div class="yt-head">
      <div>
        <h2>Auto-clip your YouTube channel</h2>
        <p class="muted">Connect your channel and every new video you publish gets clipped automatically — the best clips are rendered and reviewed, ready for you. Checked every 15 minutes. Shorts are skipped.</p>
      </div>
      ${channels.length ? `<button type="button" class="btn ghost" data-yt-check>Check now</button>` : ""}
    </div>
    ${channels
      .map(
        (c) => `<div class="yt-channel" data-channel="${esc(c.id)}">
          ${c.avatar ? `<img class="yt-avatar" src="${esc(c.avatar)}" alt="" />` : ""}
          <div class="grow">
            <div class="yt-title">${esc(c.title)} ${c.handle ? `<span class="muted">${esc(c.handle)}</span>` : ""}${c.paused ? ` <span class="chip">Paused</span>` : ""}</div>
            <div class="muted yt-meta">${esc(ago(c.lastCheckedAt))}${c.lastError ? ` · <span class="yt-error">${esc(c.lastError)}</span>` : ""} · renders the top ${c.autoRender} clip${c.autoRender === 1 ? "" : "s"}${
              c.imported?.length ? ` · latest: <a class="link-btn" href="#/p/${esc(c.imported[0].projectId || "")}">${esc(c.imported[0].title)}</a>` : ""
            }</div>
          </div>
          <label class="field yt-count"><span>Auto-render</span><select data-yt-render>${[0, 1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${n === c.autoRender ? "selected" : ""}>${n ? `Top ${n}` : "None"}</option>`).join("")}</select></label>
          <button type="button" class="btn ghost" data-yt-pause>${c.paused ? "Resume" : "Pause"}</button>
          <button type="button" class="icon-btn" data-yt-remove title="Disconnect">${ICON.trash}</button>
        </div>`,
      )
      .join("")}
    <form class="yt-connect" id="yt-connect">
      <label class="field grow"><span>${channels.length ? "Add another channel" : "Your channel"}</span><input name="channel" placeholder="youtube.com/@yourchannel or @yourchannel" autocomplete="off" /></label>
      <label class="field yt-count"><span>Auto-render</span><select name="autoRender">${[0, 1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${n === 3 ? "selected" : ""}>${n ? `Top ${n}` : "None"}</option>`).join("")}</select></label>
      <label class="toggle yt-latest"><input type="checkbox" name="clipLatest" /><span class="track"></span>Also clip my latest video now</label>
      <button class="btn primary">Connect</button>
    </form>`;

  $("#yt-connect", box).onsubmit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const button = $("button", form);
    button.disabled = true;
    button.textContent = "Connecting…";
    try {
      const channel = await api("/api/youtube/channels", { method: "POST", body: { channel: form.elements.channel.value, autoRender: Number(form.elements.autoRender.value), clipLatest: form.elements.clipLatest.checked } });
      toast(form.elements.clipLatest.checked ? `${channel.title} connected — clipping your latest video now` : `${channel.title} connected — new videos will be clipped automatically`);
      renderChannelWatch();
      if (form.elements.clipLatest.checked) setTimeout(() => route(), 8000);
    } catch (err) {
      toast(err.message);
      button.disabled = false;
      button.textContent = "Connect";
    }
  };
  box.onclick = async (e) => {
    const row = e.target.closest("[data-channel]");
    try {
      if (e.target.closest("[data-yt-check]")) {
        const { found } = await api("/api/youtube/check", { method: "POST" });
        toast(found.length ? `Found ${found.length} new video${found.length === 1 ? "" : "s"} — clipping now` : "No new videos since the last check");
        if (found.length) setTimeout(() => route(), 3000);
        return renderChannelWatch();
      }
      if (!row) return;
      const id = encodeURIComponent(row.dataset.channel);
      if (e.target.closest("[data-yt-pause]")) {
        await api(`/api/youtube/channels/${id}`, { method: "PATCH", body: { paused: e.target.closest("[data-yt-pause]").textContent.trim() === "Pause" } });
        return renderChannelWatch();
      }
      if (e.target.closest("[data-yt-remove]")) {
        if (!confirm("Disconnect this channel? Videos already clipped stay in your projects.")) return;
        await api(`/api/youtube/channels/${id}`, { method: "DELETE" });
        return renderChannelWatch();
      }
    } catch (err) {
      toast(err.message);
    }
  };
  box.onchange = async (e) => {
    const select = e.target.closest("[data-yt-render]");
    const row = e.target.closest("[data-channel]");
    if (!select || !row) return;
    await api(`/api/youtube/channels/${encodeURIComponent(row.dataset.channel)}`, { method: "PATCH", body: { autoRender: Number(select.value) } }).catch((err) => toast(err.message));
    toast(Number(select.value) ? `New videos will render their top ${select.value} clips` : "New videos will be clipped but not rendered");
  };
}

// ---------- project ----------
async function showProject(id) {
  app.innerHTML = `<div class="loading">Loading…</div>`;
  try {
    state.project = await api(`/api/projects/${id}`);
  } catch {
    app.innerHTML = `<div class="loading">Project not found. <a class="link-btn" href="#/projects">Back to projects</a></div>`;
    return;
  }
  state.clipKeys = {};
  renderProject();

  state.poll = setInterval(async () => {
    const current = state.project;
    const next = await api(`/api/projects/${id}`).catch(() => null);
    if (!next || state.project?.id !== id) return;
    state.project = next;
    if (next.status !== current.status || (current.repick?.status === "picking" && next.repick?.status !== "picking")) {
      renderProject();
      if (next.repick?.status !== current.repick?.status && next.repick?.message) toast(next.repick.message);
    } else if (next.repick?.status === "picking" && $("#repick")) $("#repick").title = next.repick.message;
    else if (next.status === "ready" && $(".clips") && $$("[data-clip]").length !== next.clips.length && !$(".modal-backdrop")) {
      // "More like this" added clips.
      renderProject();
      toast("New clips like the one you loved are ready");
    } else if (next.status === "ready") {
      next.clips.forEach(patchClip);
      patchHead();
      syncEdits(current, next);
      if (JSON.stringify(current.long || null) !== JSON.stringify(next.long || null)) renderLong(next);
    } else if (LIVE.includes(next.status) && $("#status-msg")) $("#status-msg").textContent = next.message || "";
  }, 1500);
}

function renderProject() {
  const p = state.project;
  if (p.status === "ready") renderReady(p);
  else renderProcessing(p);
}

function renderProcessing(p) {
  const step = p.status === "error" ? -1 : STEP_OF[p.status] ?? 1;
  app.innerHTML = `
    <div class="page-head">
      <div><a class="back" href="#/projects">← All projects</a><h1>${esc(p.name)}</h1></div>
      ${
        LIVE.includes(p.status)
          ? `<button id="stop-processing" class="btn danger">${ICON.stop} ${p.status === "downloading" ? "Stop download" : "Stop"}</button>`
          : `<button class="btn danger" data-delete-project="${p.id}" data-name="${esc(p.name)}">${ICON.trash} Delete project</button>`
      }
    </div>
    <div class="card processing">
      <div class="poster"><img src="${fileUrl(p, "poster.jpg")}" alt="" onerror="this.remove()" /></div>
      <ol class="stepper">
        ${(p.source?.url ? ["Download", ...STEPS.slice(1)] : STEPS)
          .map((label, i) => `<li class="${i < step || (i === 0 && step !== 0) ? "done" : i === step ? "active" : ""}"><span class="dot"></span>${label}</li>`)
          .join("")}
      </ol>
      <p id="status-msg" class="status-msg">${esc(p.status === "error" ? "" : p.message)}</p>
      ${p.status === "error" ? `<div class="error-box">${esc(p.error || "Something went wrong.")}<br /><button id="retry" class="btn">Try again</button></div>` : ""}
      ${p.status === "stopped" ? `<div class="stopped-box"><p class="muted">You stopped this video. Start it again, or delete it.</p><button id="retry" class="btn primary">Start again</button></div>` : ""}
    </div>`;
  bindProjectDeletes(app);
  $("#stop-processing")?.addEventListener("click", async (e) => {
    if (!confirm(p.status === "downloading" ? "Stop downloading this video?" : "Stop processing this video?")) return;
    e.currentTarget.disabled = true;
    try {
      state.project = await api(`/api/projects/${p.id}/stop`, { method: "POST" });
      toast("Stopping…");
    } catch (err) {
      toast(err.message);
      e.currentTarget.disabled = false;
    }
  });
  $("#retry")?.addEventListener("click", async () => {
    state.project = await api(`/api/projects/${p.id}/retry`, { method: "POST" });
    state.project.status = "queued";
    renderProject();
  });
}

/** "Improve captions": redo the transcript with a bigger speech model on this Mac, in the background. */
function openCaptionsRedo(p) {
  const levels = state.config.captionQuality || {};
  const current = p.captions?.quality || p.options?.captionQuality || "standard";
  const suggested = current === "standard" ? "high" : current;
  const modal = openModal(`
    <div class="modal-head">
      <div><h2>Improve captions</h2><p class="muted">Redo the transcript with a bigger speech model running on this Mac. Clips, titles and edits stay as they are — captions and word timings get more accurate.</p></div>
      <button type="button" class="icon-btn" data-close title="Close">${ICON.close}</button>
    </div>
    <div class="caption-levels">
      ${Object.entries(levels)
        .map(
          ([id, l]) => `<label class="caption-level">
            <input type="radio" name="quality" value="${id}" ${id === suggested ? "checked" : ""} />
            <span><b>${esc(l.label)}</b> · ${esc(l.hint)}<em class="muted small">${l.installed ? "Ready to use" : `One-time download · ${sizeLabel(l.sizeMb)} from Hugging Face`}${id === current ? " · what you have now" : ""}</em></span>
          </label>`,
        )
        .join("")}
    </div>
    <div class="editor-actions"><span class="spacer"></span><button type="button" class="btn primary" data-go>Redo captions</button></div>`);
  $("[data-go]", modal).onclick = async () => {
    const quality = $('input[name="quality"]:checked', modal)?.value || suggested;
    try {
      await api(`/api/projects/${p.id}/retranscribe`, { method: "POST", body: { quality } });
      closeModal();
      const button = $("#captions-redo");
      if (button) {
        button.disabled = true;
        button.textContent = "Improving captions…";
      }
      toast("Redoing captions in the background — keep working");
      watchCaptions(p.id);
    } catch (err) {
      toast(err.message);
    }
  };
}

function watchCaptions(projectId) {
  clearInterval(state.captionsPoll);
  state.captionsPoll = setInterval(async () => {
    const next = await api(`/api/projects/${projectId}`).catch(() => null);
    if (!next || next.captions?.status === "running") return;
    clearInterval(state.captionsPoll);
    if (state.project?.id !== projectId) return;
    if (next.captions?.status === "done") {
      toast(`Captions improved — ${next.captions.words.toLocaleString()} words`);
      state.project = next;
      renderProject();
    } else if (next.captions?.status === "error") {
      toast(`Couldn't improve captions: ${next.captions.error}`);
      const button = $("#captions-redo");
      if (button) {
        button.disabled = false;
        button.textContent = "Improve captions";
      }
    }
  }, 5000);
}

function renderReady(p) {
  const words = p.segments?.reduce((n, s) => n + s.text.split(" ").length, 0) || 0;
  app.innerHTML = `
    <div class="page-head">
      <div>
        <a class="back" href="#/projects">← All projects</a>
        <h1>${esc(p.name)}</h1>
        <p class="muted">${fmtLen(p.source.duration)} · ${words.toLocaleString()} words · ${p.clips.length} clips</p>
      </div>
      <div class="head-actions">
        <button id="stop-all" class="btn danger" hidden>${ICON.stop} Stop all</button>
        ${
          p.source.hasAudio
            ? `<button id="captions-redo" class="btn ghost" ${p.captions?.status === "running" ? "disabled" : ""}>${p.captions?.status === "running" ? "Improving captions…" : "Improve captions"}</button>`
            : ""
        }
        <button id="retitle" class="btn ghost" title="Rewrite every clip's headline and posting copy from what the clip says, for practice owners. The cuts stay as they are.">Rewrite titles</button>
        <button id="repick" class="btn ghost" title="Pick this video's clips again with the latest engine, check each one makes sense, and render the ones that hold up. Clips you edited on the timeline stay." ${p.repick?.status === "picking" ? "disabled" : ""}>${p.repick?.status === "picking" ? "Re-picking…" : "Re-pick clips"}</button>
        <button id="render-all" class="btn primary">Render all</button>
        <button class="icon-btn head-delete" data-delete-project="${p.id}" data-name="${esc(p.name)}" title="Delete project">${ICON.trash}</button>
      </div>
    </div>

    ${
      p.analysis.warning
        ? `<div class="banner warn">${esc(p.analysis.warning)}</div>`
        : p.analysis.mode === "demo"
          ? `<div class="banner">Demo mode — clips were picked by a simple heuristic. Add <code>ANTHROPIC_API_KEY</code> to <code>.env</code> and restart for Claude-powered picks and titles.</div>`
          : ""
    }

    <div class="layout">
      <aside class="side">
        <div class="card source-card">
          <video id="source" src="${fileUrl(p, p.work ? "work.mp4" : p.source.file)}" controls playsinline preload="metadata"></video>
          <p class="summary">${esc(p.analysis.summary)}</p>
        </div>
        ${titlesSection(p)}
      </aside>
      <div class="main-col">
        ${modeTabs(p)}
        <section class="clips" data-mode-panel="clips" ${projectMode(p) === "clips" ? "" : "hidden"}>
          ${p.clips.length ? `<div class="taste-panel" id="clip-taste" hidden></div>` : ""}
          ${
            p.clips.length
              ? p.clips.map((c) => clipCard(c)).join("")
              : `<div class="empty">No talking clips in this video. Switch to <b>Dope edits</b> to cut its best moments to music.</div>`
          }
        </section>
        <section class="edits" id="edits" data-mode-panel="edits" ${projectMode(p) === "edits" ? "" : "hidden"}></section>
        <section class="long-video" id="long" data-mode-panel="long" ${projectMode(p) === "long" ? "" : "hidden"}></section>
      </div>
    </div>

    <details class="card transcript">
      <summary>Transcript</summary>
      <div class="transcript-body">
        ${(p.segments || []).map((s) => `<div class="seg" data-seek="${s.start}"><time>${fmt(s.start)}</time><span>${esc(s.text)}</span></div>`).join("")}
      </div>
    </details>`;

  $("#captions-redo")?.addEventListener("click", () => openCaptionsRedo(p));
  if (p.captions?.status === "running") watchCaptions(p.id);
  p.clips.forEach(patchClip);
  patchHead();
  bindReady(p);
  renderClipTaste();
  bindTitles(p);
  renderTitleList(p);
  bindModes();
  renderEdits(p);
  renderLong(p);
}

// ---------- clips vs. dope edits ----------
function projectMode(p) {
  // Open on what the creator asked for at upload.
  return (state.modes[p.id] ??= p.options?.intent?.mode === "long" || p.long ? "long" : p.options?.intent?.mode === "edit" || !p.clips.length ? "edits" : "clips");
}

function modeTabs(p) {
  const mode = projectMode(p);
  const edits = p.edits?.length || 0;
  return `
    <div class="mode-tabs" id="mode-tabs">
      <button class="mode-tab ${mode === "clips" ? "on" : ""}" data-mode="clips" title="Talking moments with captions and hook titles">Clips<span>${p.clips.length || ""}</span></button>
      <button class="mode-tab ${mode === "edits" ? "on" : ""}" data-mode="edits" title="The best-looking moments cut to music">Dope edits<span>${edits || ""}</span></button>
      <button class="mode-tab ${mode === "long" ? "on" : ""}" data-mode="long" title="The whole talk, tightened — as a YouTube video or a presentation">Full video<span>${p.long?.render?.status === "done" ? "1" : ""}</span></button>
    </div>`;
}

function bindModes() {
  $("#mode-tabs").onclick = (e) => {
    const tab = e.target.closest("[data-mode]");
    if (!tab) return;
    state.modes[state.project.id] = tab.dataset.mode;
    $$("#mode-tabs [data-mode]").forEach((b) => b.classList.toggle("on", b === tab));
    $$("[data-mode-panel]").forEach((panel) => (panel.hidden = panel.dataset.modePanel !== tab.dataset.mode));
    $("#render-all").hidden = $("#stop-all").hidden || tab.dataset.mode !== "clips";
  };
}

// ---------- full video (lib/longedit.js) ----------

function renderLong(p) {
  const box = $("#long");
  if (!box) return;
  const L = p.long;
  const r = L?.render || {};
  const busy = ["queued", "rendering"].includes(r.status);
  const plan = L?.plan;
  const formats = state.config.longFormats || {};
  const draft = (state.longDraft ??= { format: "youtube", tight: true, captions: false, callouts: false, slides: false });
  if (L?.design && !state.longDraftFrom) {
    state.longDraftFrom = true;
    Object.assign(draft, { format: L.design.format, tight: L.design.tightness === "tight", captions: L.design.captions, callouts: L.design.callouts, slides: L.design.slides });
  }
  const pictures = (p.materials || []).filter((m) => m.kind === "image").length;
  const stamp = (sec) => fmt(sec);
  const keepOpen = $("details.long-copy", box)?.open;

  const maker = `
    <section class="card long-maker">
      <div class="edit-maker-head">
        <h3>${L ? "Edit it again" : "Edit the full video"}</h3>
        <p class="muted">The whole talk, tightened: filler words, long pauses and retakes come out${draft.tight ? ", plus rambles and tangents" : ""}. Chapters, title and description are written for you.</p>
      </div>
      <div class="vibe-pick format-pick" data-long-set="format">
        ${Object.entries(formats).map(([id, f]) => `<button type="button" data-v="${id}" class="${draft.format === id ? "on" : ""}"><b>${esc(f.label)}</b><span>${esc(f.hint)}</span></button>`).join("")}
      </div>
      <div class="toggle-list">
        <label class="toggle"><input type="checkbox" data-long-check="tight" ${draft.tight ? "checked" : ""} /><span class="track"></span>Cut rambles and tangents too</label>
        <label class="toggle"><input type="checkbox" data-long-check="captions" ${draft.captions ? "checked" : ""} /><span class="track"></span>Captions</label>
        <label class="toggle"><input type="checkbox" data-long-check="callouts" ${draft.callouts ? "checked" : ""} /><span class="track"></span>Key points on screen</label>
        <label class="toggle"><input type="checkbox" data-long-check="slides" ${draft.slides ? "checked" : ""} /><span class="track"></span>Show my slides <em class="muted">· ${pictures ? plural(pictures, "picture") + " attached" : "no pictures attached to this video"}</em></label>
      </div>
      <div class="clip-actions"><button type="button" class="btn primary" data-long-start ${L?.status === "planning" || busy ? "disabled" : ""}>${L ? "Re-edit and render" : "Edit and render"}</button></div>
    </section>`;

  const status = !L
    ? ""
    : L.status === "planning"
      ? `<section class="card long-status"><div class="long-progress"><span class="spinner"></span><div><b>Editing the full video</b><p class="muted">${esc(L.message || "")} · this takes a minute or two</p></div></div></section>`
      : L.status === "error"
        ? `<section class="card long-status"><p class="err-text">${esc(L.message)}</p></section>`
        : `
    <section class="card long-result">
      <div class="long-player">
        ${
          r.status === "done"
            ? `<video src="${fileUrl(p, r.file)}?v=${encodeURIComponent(r.renderedAt || "")}" controls playsinline preload="metadata"></video>`
            : `<div class="placeholder">${busy ? "" : r.status === "error" ? "Render failed" : "Not rendered yet"}</div>`
        }
        ${busy ? `<div class="overlay"><div class="ring" style="--p:${r.progress || 0}"><span>${r.status === "queued" ? "…" : `${r.progress || 0}%`}</span></div></div>` : ""}
      </div>
      <div class="long-body">
        <div class="clip-top"><span class="rank">${esc(formats[L.design.format]?.label || "Full video")}</span><span>${plan ? `${stamp(p.source.duration)} → ${stamp(plan.duration)}` : ""}</span></div>
        <h3 class="long-title">${esc(plan?.youtube.title || "")}</h3>
        ${
          plan
            ? `<p class="muted">Cut ${stamp(plan.removed.rambles || 0)} of retakes and rambles, ${plural(plan.removed.filler || 0, "filler word")}, ${plural(plan.removed.pauses || 0, "long pause")}${plan.slides.length ? ` · ${plural(plan.slides.length, "slide")}` : ""}${plan.callouts.length ? ` · ${plural(plan.callouts.length, "key point")}` : ""}</p>`
            : ""
        }
        <p class="render-msg ${r.status === "error" ? "err" : ""}">${esc(r.status === "error" ? r.error || r.message : r.message || L.message || "")}</p>
        ${
          plan
            ? `<details class="long-copy" ${keepOpen ? "open" : ""}>
                <summary>Title, description and chapters</summary>
                <div class="post-body">
                  <strong>${esc(plan.youtube.title)}</strong>
                  <p class="long-desc">${esc(plan.youtube.description)}</p>
                  <div class="tags">Thumbnail: ${esc(plan.youtube.thumbnail)}</div>
                </div>
              </details>
              ${plan.cuts.length ? `<details class="long-copy"><summary>What was cut (${plan.cuts.length})</summary><ul class="long-cuts">${plan.cuts.map((c) => `<li><time>${esc(c.at)}</time> ${esc(c.reason)}</li>`).join("")}</ul></details>` : ""}`
            : ""
        }
        <div class="clip-actions">
          ${plan ? `<button type="button" class="btn" data-long-copy>${ICON.copy} Copy title &amp; description</button>` : ""}
          ${busy ? `<button type="button" class="btn danger" data-long-cancel>${ICON.stop} Stop</button>` : plan ? `<button type="button" class="btn" data-long-render>${r.status === "done" ? "Render again" : "Render"}</button>` : ""}
          ${r.status === "done" ? `<a class="btn ghost" href="${fileUrl(p, r.file)}" download="${esc((plan?.youtube.title || p.name).replace(/[^\w -]+/g, "").trim() || "full-video")}.mp4">${ICON.download} Download</a>` : ""}
        </div>
      </div>
    </section>`;

  box.innerHTML = status + maker;

  const act = async (url, body) => {
    try {
      state.project.long = await api(url, { method: "POST", body: body || {} });
      renderLong(state.project);
    } catch (err) {
      toast(err.message);
    }
  };
  $$("[data-long-set] button", box).forEach((b) => (b.onclick = () => {
    draft.format = b.dataset.v;
    const deck = draft.format === "presentation";
    Object.assign(draft, { captions: deck, callouts: deck, slides: deck });
    renderLong(state.project);
  }));
  $$("[data-long-check]", box).forEach((i) => (i.onchange = () => (draft[i.dataset.longCheck] = i.checked)));
  $("[data-long-start]", box).onclick = () => act(`/api/projects/${p.id}/long`, { design: longDesign(draft) });
  $("[data-long-render]", box)?.addEventListener("click", () => act(`/api/projects/${p.id}/long/render`));
  $("[data-long-cancel]", box)?.addEventListener("click", () => act(`/api/projects/${p.id}/long/cancel`));
  $("[data-long-copy]", box)?.addEventListener("click", () => copy(`${plan.youtube.title}\n\n${plan.youtube.description}`));
}

const editLabel = (e) =>
  e.engine === "hf" ? `${state.styles?.[e.design.style]?.label || "HyperFrames"} edit` : `${state.config.vibes[e.design.vibe]?.label || "Dope"} edit`;

/** "xpeleu, ashtinvonge +2" — the studied reels a style was tuned on. */
const learnedNames = (list = []) => {
  const names = [...new Set(list.map((l) => l.who).filter(Boolean))];
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
};

async function renderEdits(p) {
  const box = $("#edits");
  if (!box) return;
  [state.tracks, state.styles] = await Promise.all([api("/api/sounds").catch(() => []), api("/api/styles").catch(() => state.styles || {}), savedTitles()]);
  const lengths = state.config.hfLengths || [15, 30, 45];
  const styles = Object.entries(state.styles).filter(([, s]) => s.kind === "edit");
  const draft = (state.hfDraft ??= { style: "cinematic", length: 15, aspect: "9:16", trackId: "shuffle", pace: "balanced", title: "", captions: true, bars: false });
  draft.pace ||= "balanced";
  if (!["shuffle", "none"].includes(draft.trackId) && !state.tracks.some((t) => t.id === draft.trackId)) draft.trackId = "shuffle";
  const paces = state.config.hfPaces || { relaxed: { label: "Relaxed" }, balanced: { label: "Balanced" }, energetic: { label: "Energetic" } };

  box.innerHTML = `
    <section class="card edit-maker">
      <div class="edit-maker-head">
        <h3>Make a dope edit</h3>
        <p class="muted">HyperFrames cuts your best moments to music in the styles you studied — their pacing, transitions and color.</p>
      </div>
      <div class="vibe-pick style-pick">
        ${styles
          .map(
            ([id, s]) => `<button type="button" data-style="${id}" class="${id === draft.style ? "on" : ""}">
              <b>${esc(s.label)}</b><span>${esc(s.description)}</span>
              <em class="learned">${s.learnedFrom?.length ? `Learned from ${esc(learnedNames(s.learnedFrom))}` : `<a href="#/study">Analyze your Study reels</a> to tune it`}</em>
            </button>`,
          )
          .join("")}
      </div>
      <div class="edit-options">
        <div class="field"><span>Length</span>
          <div class="segmented seg-fill" data-draft="length">${lengths.map((l) => `<button type="button" data-v="${l}" class="${l === draft.length ? "on" : ""}">${l}s</button>`).join("")}</div>
        </div>
        <label class="field"><span>Music</span>
          <select id="edit-track">
            ${state.tracks.length ? `<option value="shuffle" ${draft.trackId === "shuffle" ? "selected" : ""}>Shuffle from my sounds (${state.tracks.length})</option>` : ""}
            <option value="none" ${draft.trackId === "none" || !state.tracks.length ? "selected" : ""}>Original sound — no music</option>
            ${state.tracks.map((t) => `<option value="${t.id}" ${t.id === draft.trackId ? "selected" : ""}>${esc(t.name)}${t.bpm ? ` · ${t.bpm} BPM` : ""}</option>`).join("")}
          </select>
        </label>
        <div class="field"><span>Pace <em>· cuts follow the song's beat</em></span>
          <div class="segmented seg-fill" data-draft="pace">${Object.entries(paces).map(([id, p]) => `<button type="button" data-v="${id}" class="${id === draft.pace ? "on" : ""}" title="${esc(p.hint || "")}">${esc(p.label)}</button>`).join("")}</div>
        </div>
        <label class="field"><span>Title on screen <em>· optional</em></span><input id="edit-title" maxlength="60" value="${esc(draft.title)}" placeholder="Story promos use their hook line" /></label>
        <label class="toggle edit-captions"><input type="checkbox" id="edit-intro" ${draft.voiceIntro !== false ? "checked" : ""} /><span class="track"></span>Open on something you say, then the music drops</label>
        <label class="toggle edit-captions"><input type="checkbox" id="edit-captions" ${draft.captions ? "checked" : ""} /><span class="track"></span>Captions on spoken lines</label>
        <label class="toggle edit-captions"><input type="checkbox" id="edit-bars" ${draft.bars ? "checked" : ""} /><span class="track"></span>Cinematic letterbox bars</label>
      </div>
      <div class="edit-maker-foot">
        <a class="link-btn" href="#/sounds">${state.tracks.length ? "Manage your sounds →" : "Add music to your sound library →"}</a>
        <button class="btn primary lg" id="make-edit">Create edit</button>
      </div>
    </section>
    <div class="edit-list" id="edit-list"></div>`;

  box.onclick = (e) => {
    const style = e.target.closest("[data-style]");
    if (style && !e.target.closest("a")) {
      draft.style = style.dataset.style;
      draft.bars = draft.style === "promo";
      $("#edit-bars").checked = draft.bars;
      $$("[data-style]", box).forEach((b) => b.classList.toggle("on", b === style));
    }
    const opt = e.target.closest("[data-draft] button");
    if (opt) {
      const key = opt.closest("[data-draft]").dataset.draft;
      draft[key] = key === "length" ? Number(opt.dataset.v) : opt.dataset.v;
      $$("button", opt.parentElement).forEach((b) => b.classList.toggle("on", b === opt));
    }
  };
  $("#edit-track").onchange = (e) => (draft.trackId = e.target.value);
  $("#edit-title").oninput = (e) => (draft.title = e.target.value);
  $("#edit-captions").onchange = (e) => (draft.captions = e.target.checked);
  $("#edit-intro").onchange = (e) => (draft.voiceIntro = e.target.checked);
  $("#edit-bars").onchange = (e) => (draft.bars = e.target.checked);

  $("#make-edit").onclick = async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      const edit = await api(`/api/projects/${p.id}/edits`, {
        method: "POST",
        body: {
          engine: "hf",
          design: { style: draft.style, length: draft.length, pace: draft.pace, voiceIntro: draft.voiceIntro !== false, title: draft.title, captions: draft.captions, bars: draft.bars },
          trackId: state.tracks.length ? draft.trackId : "none",
        },
      });
      state.project.edits = [edit, ...(state.project.edits || [])];
      renderEditList();
      toast(`Cutting it in the ${state.styles[draft.style]?.label || "studied"} style…`);
    } catch (err) {
      toast(err.message);
    } finally {
      button.disabled = false;
    }
  };

  renderEditList();
}

function renderEditList() {
  const list = $("#edit-list");
  if (!list) return;
  const edits = state.project.edits || [];
  list.innerHTML = edits.length ? edits.map(editCard).join("") : "";
  state.editKeys = {};
  edits.forEach((e) => {
    patchEdit(e);
    bindEditCard(e.id);
  });
  const tab = $('#mode-tabs [data-mode="edits"] span');
  if (tab) tab.textContent = edits.length || "";
}

function syncEdits(prev, next) {
  const signature = (p) => (p.edits || []).map((e) => `${e.id}:${e.status}:${e.preview?.status || ""}:${e.planVersion || 0}`).join("|");
  if (signature(prev) !== signature(next)) renderEditList();
  else (next.edits || []).forEach(patchEdit);
}

function editCard(e) {
  const ready = e.status === "ready";
  const dope = e.engine === "dope";
  const hf = e.engine === "hf";
  const chip = e.status === "scanning" ? (dope ? (e.replanning ? "Updating" : "Planning") : "Cutting") : e.status === "error" ? "Failed" : "Ready";
  const learned = hf ? learnedNames(e.plan?.style?.learnedFrom) : "";
  return `
    <article class="card clip edit-card" data-edit="${e.id}">
      <div class="clip-preview" data-slot="preview"></div>
      <div class="clip-body">
        <div class="clip-top">
          <span class="rank">${esc(editLabel(e))}</span>
          <span>${e.duration ? fmtLen(e.duration) : `${e.design.length}s`} · ${e.design.aspect}${e.shotCount ? ` · ${plural(e.shotCount, "shot")}` : ""}</span>
          <span class="chip ${e.status === "error" ? "error" : e.status === "scanning" ? "live" : ""}">${chip}</span>
        </div>
        <div class="edit-title">${esc(e.design.title || "Untitled edit")}</div>
        ${e.concept ? `<p class="edit-concept">${esc(e.concept)}</p>` : ""}
        ${learned ? `<p class="edit-learned">Style learned from ${esc(learned)}</p>` : ""}
        <p class="reason" data-slot="plan">${esc(e.status === "error" ? e.error || e.message : e.message)}</p>
        <div class="edit-progress" data-slot="progress" ${e.status === "scanning" ? "" : "hidden"}><i style="width:${e.progress || 0}%"></i></div>
        ${e.notice ? `<p class="edit-notice">${esc(e.notice)}</p>` : ""}
        ${e.updateError ? `<p class="edit-notice">Last change didn't apply: ${esc(e.updateError)}</p>` : ""}
        <p class="edit-notice" data-slot="stale" hidden>You've changed this edit since it was rendered — re-render to update the video.</p>
        <div class="clip-actions">
          <button class="btn primary" data-edit-open ${ready ? "" : "disabled"}>${ICON.play} Preview &amp; tweak</button>
          <button class="btn" data-edit-render ${ready ? "" : "disabled"}>Render</button>
          ${dope || hf ? `<button class="btn ghost" data-edit-reroll ${ready ? "" : "disabled"} title="Different moments, same style">${hf ? "New cut" : "Re-roll"}</button>` : ""}
          <button class="btn danger" data-edit-cancel hidden>${ICON.stop} Stop</button>
          <button class="btn" data-edit-schedule hidden>${ICON.calendar} Schedule</button>
          <button class="icon-btn" data-edit-delete title="Delete edit">${ICON.trash}</button>
          <span class="render-msg" data-slot="msg"></span>
        </div>
      </div>
    </article>`;
}

function patchEdit(e) {
  const p = state.project;
  const card = $(`[data-edit="${e.id}"]`);
  if (!card) return;
  const r = e.render || {};
  const busy = RENDER_BUSY.includes(r.status);
  const done = r.status === "done";

  const key = `${e.status}|${r.status}|${r.file}|${r.renderedAt}|${e.preview?.status || ""}|${e.planVersion || 0}`;
  if (state.editKeys[e.id] !== key) {
    state.editKeys[e.id] = key;
    const slot = $('[data-slot="preview"]', card);
    const still = e.previewBase
      ? `<video src="${e.previewBase}shot-0.mp4#t=0.5" muted playsinline preload="metadata"></video>`
      : e.proxy
        ? `<video src="/files/${p.id}/${e.proxy.file}#t=0.5" muted playsinline preload="metadata"></video>`
        : "";
    if (done) slot.innerHTML = `<video src="${fileUrl(p, r.file)}?v=${encodeURIComponent(r.renderedAt)}" controls playsinline loop preload="metadata"></video>`;
    else if (e.status === "scanning") slot.innerHTML = `<div class="overlay scanning"><div class="spinner"></div></div>`;
    else if (busy) slot.innerHTML = `${still}<div class="overlay"><div class="ring"><span>0%</span></div></div>`;
    else slot.innerHTML = `${still}<div class="placeholder">${e.status === "error" ? "Couldn't build" : r.status === "cancelled" ? "Render stopped" : "Not rendered yet"}</div>`;
    $("[data-download]", card)?.remove();
    if (done) {
      $('[data-slot="msg"]', card).insertAdjacentHTML(
        "beforebegin",
        `<a class="btn ghost" data-download href="${fileUrl(p, r.file)}" download="${esc((e.design.title || editLabel(e)).replace(/[^\w -]+/g, "").trim() || e.id)}.mp4">${ICON.download} Download</a>`,
      );
    }
  }
  $('[data-slot="plan"]', card).textContent = e.status === "error" ? e.error || e.message : e.message;
  const ring = $(".ring", card);
  if (ring) {
    ring.style.setProperty("--p", r.progress || 0);
    $("span", ring).textContent = r.status === "queued" ? "…" : `${r.progress || 0}%`;
  }
  const renderBtn = $("[data-edit-render]", card);
  renderBtn.hidden = busy;
  renderBtn.disabled = e.status !== "ready";
  renderBtn.textContent = done ? "Re-render" : "Render";
  const stale = $('[data-slot="stale"]', card);
  if (stale) stale.hidden = !(done && e.renderStale && !busy);
  // Planning can be stopped too, not just rendering.
  $("[data-edit-cancel]", card).hidden = !(busy || (e.engine === "dope" && e.status === "scanning"));
  $("[data-edit-schedule]", card).hidden = !done;
  const open = $("[data-edit-open]", card);
  const previewReady = e.status === "ready" && (e.engine !== "dope" || e.preview?.status === "ready");
  open.disabled = !previewReady;
  open.innerHTML = e.engine === "dope" && e.status === "ready" && e.preview?.status === "preparing" ? "Preparing preview…" : `${ICON.play} Preview &amp; tweak`;
  const reroll = $("[data-edit-reroll]", card);
  if (reroll) reroll.disabled = e.status !== "ready" || busy;
  const bar = $('[data-slot="progress"]', card);
  if (bar) {
    bar.hidden = e.status !== "scanning";
    $("i", bar).style.width = `${e.progress || 0}%`;
  }
  const msg = $('[data-slot="msg"]', card);
  msg.className = `render-msg${r.status === "error" ? " err" : ""}`;
  msg.textContent = r.status === "error" ? r.error || r.message : r.status === "queued" ? "Queued — waiting for a render slot" : r.message || "";
}

function bindEditCard(editId) {
  const card = $(`[data-edit="${editId}"]`);
  const p = state.project;
  const current = () => state.project.edits.find((e) => e.id === editId);
  const replace = (updated) => {
    Object.assign(current(), updated);
    patchEdit(current());
  };
  $("[data-edit-open]", card).onclick = () => {
    const engine = current().engine;
    if (engine === "hf") openHfEditor(editId);
    else if (engine === "dope") openDopeEditor(editId);
    else openEditEditor(editId);
  };
  $("[data-edit-reroll]", card)?.addEventListener("click", async () => {
    try {
      replace(await api(`/api/projects/${p.id}/edits/${editId}/reroll`, { method: "POST" }));
      renderEditList();
      toast(current().engine === "hf" ? "New cut — picking different moments" : "New direction — the director is re-cutting it");
    } catch (err) {
      toast(err.message);
    }
  });
  $("[data-edit-render]", card).onclick = async () => {
    try {
      replace(await api(`/api/projects/${p.id}/edits/${editId}/render`, { method: "POST", body: {} }));
    } catch (err) {
      toast(err.message);
    }
  };
  $("[data-edit-cancel]", card).onclick = async () => {
    try {
      replace(await api(`/api/projects/${p.id}/edits/${editId}/cancel`, { method: "POST" }));
      toast("Render stopped");
    } catch (err) {
      toast(err.message);
    }
  };
  $("[data-edit-schedule]", card).onclick = () => {
    const e = current();
    openComposer({
      item: { projectId: p.id, projectName: p.name, clipId: e.id, title: e.design.title || editLabel(e), postTitle: e.design.title, caption: "", hashtags: [], file: e.render.file, duration: e.duration },
    });
  };
  $("[data-edit-delete]", card).onclick = async () => {
    if (!confirm("Delete this edit and its render?")) return;
    try {
      await api(`/api/projects/${p.id}/edits/${editId}`, { method: "DELETE" });
      state.project.edits = state.project.edits.filter((e) => e.id !== editId);
      renderEditList();
    } catch (err) {
      toast(err.message);
    }
  };
}

/** Preview & tweak for HyperFrames edits: look and text update live; style, New cut and length re-cut the edit. */
function openHfEditor(editId) {
  const pid = state.project.id;
  const current = () => state.project.edits.find((e) => e.id === editId);
  const e0 = current();
  const styles = Object.entries(state.styles || {}).filter(([, s]) => s.kind === "edit");
  const aspect = state.config.aspects[e0.design.aspect] || state.config.aspects["9:16"];
  const draft = { autoFrame: true, ...e0.design };
  const learned = learnedNames(e0.plan?.style?.learnedFrom);
  const LIVE = ["strength", "bars", "cropX", "autoFrame", "title", "captions", "accentColor"];

  const modal = openModal(
    `
    <div class="editor">
      <div class="editor-stage">
        <div class="stage-frame" data-frame data-orient="${aspect.width > aspect.height ? "wide" : "tall"}" style="aspect-ratio:${aspect.width} / ${aspect.height}">
          <hyperframes-player data-player controls loop autoplay width="${aspect.width}" height="${aspect.height}"></hyperframes-player>
          <div class="stage-updating" data-updating hidden><div class="spinner"></div><span>Re-cutting your edit…</span></div>
        </div>
        <p class="stage-note" data-note>Live preview · rendered with HyperFrames · ${esc(e0.message)}</p>
      </div>
      <div class="editor-panel">
        <div class="modal-head">
          <div><h2>${esc(editLabel(e0))}</h2><p class="muted">${learned ? `Style learned from ${esc(learned)}` : "Analyze your Study reels to tune this style to them"}</p></div>
          <button type="button" class="icon-btn" data-close title="Close">${ICON.close}</button>
        </div>
        <section class="ed-section">
          <h4>Style <em class="muted">· changes the cut</em></h4>
          <div class="vibe-pick style-pick compact">${styles.map(([id, s]) => `<button type="button" data-style="${id}"><b>${esc(s.label)}</b><span>${esc(s.description)}</span></button>`).join("")}</div>
        </section>
        <section class="ed-section">
          <h4>Music &amp; pace <em class="muted">· re-cuts to the song's beat</em></h4>
          <div class="row2">
            <label class="field"><span>Song</span>
              <select data-music>
                <option value="none">Original sound — no music</option>
                ${(state.tracks || []).map((t) => `<option value="${t.id}">${esc(t.name)}${t.bpm ? ` · ${t.bpm} BPM` : ""}</option>`).join("")}
              </select>
            </label>
            <div class="field"><span>&nbsp;</span><button type="button" class="btn" data-shuffle-music ${(state.tracks || []).length > 1 ? "" : "disabled"}>Shuffle song</button></div>
          </div>
          <label class="toggle"><input type="checkbox" data-intro /><span class="track"></span>Open on something you say, then the music drops</label>
          <div class="segmented seg-fill" data-pace>${Object.entries(state.config.hfPaces || {}).map(([id, p]) => `<button type="button" data-v="${id}" title="${esc(p.hint)}">${esc(p.label)}</button>`).join("")}</div>
        </section>
        <section class="ed-section">
          <h4>Look</h4>
          <label class="range-field"><span>Color grade<b data-out="strength"></b></span><input type="range" data-num="strength" min="0" max="1.2" step="0.05" /></label>
          <label class="toggle"><input type="checkbox" data-bool="autoFrame" /><span class="track"></span>Auto-frame — follow the subject in each shot</label>
          <label class="range-field"><span>Crop position<b data-out="cropX"></b></span><input type="range" data-num="cropX" min="0" max="100" step="1" /></label>
          <label class="toggle"><input type="checkbox" data-bool="bars" /><span class="track"></span>Cinematic letterbox bars</label>
        </section>
        <section class="ed-section">
          <h4>Text</h4>
          <label class="field"><span>Title on screen</span><input data-text="title" maxlength="60" placeholder="Leave empty for no title" /></label>
          ${savedTitlesSelect()}
          <label class="toggle"><input type="checkbox" data-bool="captions" /><span class="track"></span>Captions on spoken lines</label>
          <div class="field"><span>Accent color</span>
            <div class="swatches">${EDIT_ACCENTS.map((c) => `<button type="button" class="swatch accent-swatch" data-accent="#${c}" title="#${c}"><i style="background:#${c}"></i></button>`).join("")}</div>
          </div>
        </section>
        <div class="editor-actions">
          <button type="button" class="btn ghost" data-reroll title="Different moments, same style">New cut</button>
          <span class="spacer"></span>
          <button type="button" class="btn" data-save>Save</button>
          <button type="button" class="btn primary" data-render-now>Render</button>
        </div>
      </div>
    </div>`,
    { wide: true, className: "editor-modal" },
  );

  const player = $("[data-player]", modal);
  const updating = $("[data-updating]", modal);
  let shownVersion = e0.planVersion || 0;
  let reloadTimer = null;
  let waiter = null;

  const look = () => Object.fromEntries(LIVE.map((k) => [k, draft[k]]));
  const load = () => player.setAttribute("src", `/api/projects/${pid}/edits/${editId}/preview?v=${shownVersion}&design=${encodeURIComponent(JSON.stringify(look()))}`);
  const reload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 350);
  };
  const sync = () => {
    $$("[data-style]", modal).forEach((b) => b.classList.toggle("on", b.dataset.style === draft.style));
    $$("[data-pace] button", modal).forEach((b) => b.classList.toggle("on", b.dataset.v === (draft.pace || "balanced")));
    const intro = $("[data-intro]", modal);
    if (intro) intro.checked = draft.voiceIntro !== false;
    const music = $("[data-music]", modal);
    if (music && document.activeElement !== music) music.value = current()?.trackId || "none";
    $$("[data-accent]", modal).forEach((b) => b.classList.toggle("on", b.dataset.accent.toUpperCase() === String(draft.accentColor).toUpperCase()));
    $$("[data-bool]", modal).forEach((i) => (i.checked = Boolean(draft[i.dataset.bool])));
    $$("[data-text]", modal).forEach((i) => document.activeElement !== i && (i.value = draft[i.dataset.text] || ""));
    $$("[data-num]", modal).forEach((i) => (i.value = draft[i.dataset.num]));
    $('[data-out="strength"]', modal).textContent = `${Math.round(draft.strength * 100)}%`;
    $('[data-out="cropX"]', modal).textContent = draft.cropX < 40 ? "Left" : draft.cropX > 60 ? "Right" : "Center";
  };

  // Re-cuts (style change, New cut) finish in the background; wait for the new plan before reloading.
  const waitForRecut = () => {
    clearInterval(waiter);
    updating.hidden = false;
    waiter = setInterval(() => {
      const e = current();
      if (!document.body.contains(modal) || !e) return clearInterval(waiter);
      if (e.status === "error") {
        clearInterval(waiter);
        updating.hidden = true;
        toast(e.error || "Couldn't re-cut this edit");
      } else if (e.status === "ready" && (e.planVersion || 0) > shownVersion) {
        clearInterval(waiter);
        shownVersion = e.planVersion;
        updating.hidden = true;
        $("[data-note]", modal).textContent = `Live preview · rendered with HyperFrames · ${e.message}`;
        load();
      }
    }, 1000);
  };

  const save = async () => {
    const updated = await api(`/api/projects/${pid}/edits/${editId}`, { method: "PATCH", body: { design: draft } });
    const recut = updated.status === "scanning";
    Object.assign(current(), updated);
    if (recut) waitForRecut();
    return recut;
  };

  modal.addEventListener("click", (event) => {
    const style = event.target.closest("[data-style]");
    if (style) {
      draft.style = style.dataset.style;
      sync();
      toast("Save to re-cut in this style");
    }
    const swatch = event.target.closest("[data-accent]");
    if (swatch) {
      draft.accentColor = swatch.dataset.accent.toUpperCase();
      sync();
      reload();
    }
  });
  $$("[data-bool]", modal).forEach((i) => (i.onchange = () => ((draft[i.dataset.bool] = i.checked), reload())));
  $$("[data-text]", modal).forEach((i) => (i.oninput = () => ((draft[i.dataset.text] = i.value), reload())));
  bindSavedTitles(modal, (title) => {
    draft.title = title.slice(0, 60);
    sync();
    reload();
  });
  $$("[data-num]", modal).forEach(
    (i) =>
      (i.oninput = () => {
        draft[i.dataset.num] = Number(i.value);
        // Placing the crop by hand switches auto-frame off.
        if (i.dataset.num === "cropX") draft.autoFrame = false;
        sync();
        reload();
      }),
  );

  // Song and pace re-cut right away, so the cuts land on the new beat.
  const recutWith = async (body, message) => {
    try {
      Object.assign(current(), await api(`/api/projects/${pid}/edits/${editId}`, { method: "PATCH", body: { design: draft, ...body } }));
      waitForRecut();
      toast(message);
    } catch (err) {
      toast(err.message);
      sync();
    }
  };
  $("[data-music]", modal).onchange = (event) => recutWith({ trackId: event.target.value === "none" ? null : event.target.value }, "Re-cutting to the new song…");
  $("[data-intro]", modal).onchange = (event) => {
    draft.voiceIntro = event.target.checked;
    recutWith({}, event.target.checked ? "Opening on a spoken line, then the music…" : "Straight into the music…");
  };
  $("[data-shuffle-music]", modal).onclick = async () => {
    try {
      Object.assign(current(), await api(`/api/projects/${pid}/edits/${editId}/shuffle-music`, { method: "POST" }));
      sync();
      waitForRecut();
      toast("Shuffling in another song from your sounds…");
    } catch (err) {
      toast(err.message);
    }
  };
  $$("[data-pace] button", modal).forEach(
    (b) =>
      (b.onclick = () => {
        if ((draft.pace || "balanced") === b.dataset.v) return;
        draft.pace = b.dataset.v;
        sync();
        recutWith({}, `${b.textContent} pace — re-cutting to the beat…`);
      }),
  );

  $("[data-save]", modal).onclick = async () => {
    try {
      toast((await save()) ? "Re-cutting in the new style…" : "Saved");
    } catch (err) {
      toast(err.message);
    }
  };
  $("[data-reroll]", modal).onclick = async () => {
    try {
      Object.assign(current(), await api(`/api/projects/${pid}/edits/${editId}/reroll`, { method: "POST" }));
      waitForRecut();
    } catch (err) {
      toast(err.message);
    }
  };
  $("[data-render-now]", modal).onclick = async () => {
    if (!updating.hidden) return toast("Wait for the re-cut to finish first");
    try {
      if (await save()) return toast("Re-cutting first — render once it's ready");
      Object.assign(current(), await api(`/api/projects/${pid}/edits/${editId}/render`, { method: "POST", body: {} }));
      renderEditList();
      closeModal();
      toast("Rendering your edit with HyperFrames");
    } catch (err) {
      toast(err.message);
    }
  };

  sync();
  load();
}

function openEditEditor(editId) {
  const current = () => state.project.edits.find((e) => e.id === editId);
  const e0 = current();
  const draft = { ...e0.design };
  const { aspects, vibes } = state.config;

  const modal = openModal(
    `
    <div class="editor">
      <div class="editor-stage">
        <div class="stage-frame" data-frame><hyperframes-player data-player controls loop autoplay></hyperframes-player></div>
        <p class="stage-note">Live preview · ${plural(e0.shots.length, "shot")} · Render bakes it into an MP4</p>
      </div>
      <div class="editor-panel">
        <div class="modal-head">
          <div><h2>${esc(editLabel(e0))}</h2><p class="muted">${esc(e0.message)}</p></div>
          <button type="button" class="icon-btn" data-close title="Close">${ICON.close}</button>
        </div>
        <section class="ed-section">
          <h4>Vibe</h4>
          <div class="segmented seg-fill" data-seg="vibe">${Object.entries(vibes).map(([id, v]) => `<button type="button" data-v="${id}">${esc(v.label)}</button>`).join("")}</div>
        </section>
        <section class="ed-section">
          <h4>Format</h4>
          <div class="aspect-pick">
            ${Object.entries(aspects).map(([id, a]) => `<button type="button" data-aspect="${id}"><i style="aspect-ratio:${a.width} / ${a.height}"></i><b>${a.label}</b><small>${a.hint}</small></button>`).join("")}
          </div>
        </section>
        <section class="ed-section">
          <h4>Title</h4>
          <label class="field"><span>On-screen title</span><input data-text="title" maxlength="60" placeholder="Leave empty for no title" /></label>
          <label class="color-field"><input type="color" data-color="accentColor" /><span>Title color</span></label>
        </section>
        <section class="ed-section">
          <h4>Effects & sound</h4>
          <div class="row2">
            <label class="toggle"><input type="checkbox" data-bool="flash" /><span class="track"></span>Flash on cuts</label>
            <label class="toggle"><input type="checkbox" data-bool="shake" /><span class="track"></span>Shake on beats</label>
          </div>
          <label class="range-field"><span>Original sound<b data-out="originalAudio"></b></span><input type="range" data-num="originalAudio" min="0" max="1" step="0.05" /></label>
          <label class="range-field"><span>Crop  ←  →<b data-out="cropX"></b></span><input type="range" data-num="cropX" min="0" max="100" step="1" /></label>
        </section>
        <div class="editor-actions">
          <span class="spacer"></span>
          <button type="button" class="btn" data-save>Save</button>
          <button type="button" class="btn primary" data-render-now>Render</button>
        </div>
      </div>
    </div>`,
    { wide: true, className: "editor-modal" },
  );

  const player = $("[data-player]", modal);
  const frame = $("[data-frame]", modal);
  let timer;
  const load = () => {
    const a = aspects[draft.aspect];
    frame.style.aspectRatio = `${a.width} / ${a.height}`;
    frame.dataset.orient = a.width > a.height ? "wide" : "tall";
    player.setAttribute("width", a.width);
    player.setAttribute("height", a.height);
    player.setAttribute("src", `/api/projects/${state.project.id}/edits/${editId}/preview?${new URLSearchParams({ design: JSON.stringify(draft), v: Date.now() })}`);
  };
  const refresh = (delay = 250) => {
    clearTimeout(timer);
    timer = setTimeout(load, delay);
  };
  const outLabel = { originalAudio: (v) => `${Math.round(v * 100)}%`, cropX: (v) => `${Math.round(v)}%` };
  const sync = () => {
    $$("[data-seg] button", modal).forEach((b) => b.classList.toggle("on", draft[b.closest("[data-seg]").dataset.seg] === b.dataset.v));
    $$("[data-aspect]", modal).forEach((b) => b.classList.toggle("on", b.dataset.aspect === draft.aspect));
    $$("[data-bool]", modal).forEach((i) => (i.checked = Boolean(draft[i.dataset.bool])));
    $$("[data-num]", modal).forEach((i) => {
      i.value = draft[i.dataset.num];
      $(`[data-out="${i.dataset.num}"]`, modal).textContent = outLabel[i.dataset.num](draft[i.dataset.num]);
    });
    $$("[data-color]", modal).forEach((i) => (i.value = draft[i.dataset.color].toLowerCase()));
    $$("[data-text]", modal).forEach((i) => document.activeElement !== i && (i.value = draft[i.dataset.text]));
  };
  const set = (patch, delay) => {
    Object.assign(draft, patch);
    sync();
    refresh(delay);
  };

  modal.addEventListener("click", (e) => {
    const seg = e.target.closest("[data-seg] button");
    if (seg) return set({ [seg.closest("[data-seg]").dataset.seg]: seg.dataset.v }, 0);
    const aspect = e.target.closest("[data-aspect]");
    if (aspect) return set({ aspect: aspect.dataset.aspect }, 0);
  });
  $$("[data-bool]", modal).forEach((i) => (i.onchange = () => set({ [i.dataset.bool]: i.checked }, 0)));
  $$("[data-num]", modal).forEach((i) => (i.oninput = () => set({ [i.dataset.num]: Number(i.value) }, 450)));
  $$("[data-color]", modal).forEach((i) => (i.oninput = () => set({ [i.dataset.color]: i.value.toUpperCase() }, 350)));
  $$("[data-text]", modal).forEach(
    (i) =>
      (i.oninput = () => {
        draft[i.dataset.text] = i.value;
        refresh(600);
      }),
  );

  const save = async () => {
    const updated = await api(`/api/projects/${state.project.id}/edits/${editId}`, { method: "PATCH", body: { design: draft } });
    Object.assign(current(), updated);
    renderEditList();
  };
  $("[data-save]", modal).onclick = async () => {
    try {
      await save();
      toast("Saved");
    } catch (err) {
      toast(err.message);
    }
  };
  $("[data-render-now]", modal).onclick = async () => {
    try {
      await save();
      Object.assign(current(), await api(`/api/projects/${state.project.id}/edits/${editId}/render`, { method: "POST", body: {} }));
      renderEditList();
      closeModal();
      toast("Rendering your edit");
    } catch (err) {
      toast(err.message);
    }
  };

  sync();
  load();
}

// ---------- titles & hooks ----------
const TITLE_TABS = [
  ["titles", "Viral titles", "titles"],
  ["youtube", "YouTube titles", "youtubeTitles"],
  ["hooks", "Fire hooks", "hooks"],
  ["messages", "Key messages", "messages"],
];

function titlesSection(p) {
  return `
    <section class="card titles-card">
      <div class="titles-head">
        <h3 title="The most clickable lines in this video. ♥ the ones you love to teach it your style.">Titles &amp; hooks</h3>
        <div class="titles-tools">
          ${state.config.claude ? `<button class="btn sm ghost" id="refresh-titles">Refresh</button>` : ""}
          <button class="icon-btn" id="copy-titles" title="Copy every line in this tab">${ICON.copy}</button>
        </div>
      </div>
      <div class="tab-strip" id="title-tabs">
        ${TITLE_TABS.map(([id, label, key]) => {
          const n = p.analysis?.[key]?.length || 0;
          return `<button data-ttab="${id}" class="${id === state.titleTab ? "on" : ""}">${label}${n ? `<span class="count">${n}</span>` : ""}</button>`;
        }).join("")}
      </div>
      <div id="title-list"></div>
    </section>`;
}

function titleItems(p, tab) {
  const a = p.analysis || {};
  const byScore = (list) => [...(list || [])].sort((x, y) => (y.score || 0) - (x.score || 0));
  const meta = (...parts) => parts.filter(Boolean).join(" · ");
  // Taste kinds (titles/ module): clip headline "hook", opening line "opener", "youtube", title idea "idea".
  if (tab === "youtube") return byScore(a.youtubeTitles).map((t) => ({ text: t.title, meta: t.why, score: t.score, kind: "youtube" }));
  if (tab === "hooks") return byScore(a.hooks).map((h) => ({ text: h.hook, meta: meta(h.type, h.why), score: h.score, kind: "opener" }));
  if (tab === "messages") {
    return byScore(a.messages).map((m) => ({ text: `“${m.quote}”`, copyText: m.quote, meta: meta(fmt(m.start), m.takeaway), score: m.score, seek: m.start }));
  }
  return byScore(a.titles).map((t) => ({ text: t.title, meta: meta(t.angle, t.why), score: t.score, kind: "idea" }));
}

function renderTitleList(p) {
  const list = $("#title-list");
  if (!list) return;
  const items = titleItems(p, state.titleTab);
  if (!items.length) {
    list.innerHTML = `<div class="empty small-empty">${
      state.config.claude
        ? "Not written for this video yet — hit Refresh to create them."
        : "YouTube titles, hooks and key messages are written by Claude. Add <code>ANTHROPIC_API_KEY</code> to <code>.env</code> to generate them."
    }</div>`;
    return;
  }
  list.innerHTML = `
    <ol class="title-grid">
      ${items
        .map(
          (it, i) => `
        <li class="title-row" data-i="${i}">
          <span class="score ${it.score >= 85 ? "hot" : ""}">${Math.round(it.score || 0)}</span>
          <div class="t-body"><div class="t-title">${esc(it.text)}</div>${it.meta ? `<div class="t-meta">${esc(it.meta)}</div>` : ""}</div>
          <div class="t-actions">
            ${it.seek != null ? `<button class="icon-btn" data-act="seek" title="Play this moment">${ICON.play}</button>` : ""}
            ${it.kind ? `<button class="icon-btn taste" data-act="liked" title="Love it — learn my style">♥</button><button class="icon-btn taste" data-act="avoid" title="Not my style">✕</button>` : ""}
            <button class="icon-btn" data-act="copy" title="Copy">${ICON.copy}</button>
          </div>
        </li>`,
        )
        .join("")}
    </ol>`;
  list.onclick = (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const it = items[Number(b.closest("[data-i]").dataset.i)];
    if (b.dataset.act === "copy") copy(it.copyText || it.text);
    else if (b.dataset.act === "seek") state.seek?.(it.seek);
    else tasteVote(it.kind, it.copyText || it.text, b.dataset.act, b);
  };
}

function bindTitles(p) {
  $("#title-tabs").onclick = (e) => {
    const b = e.target.closest("[data-ttab]");
    if (!b) return;
    state.titleTab = b.dataset.ttab;
    $$("#title-tabs button").forEach((x) => x.classList.toggle("on", x === b));
    renderTitleList(state.project);
  };
  $("#copy-titles").onclick = () => {
    const items = titleItems(state.project, state.titleTab);
    if (items.length) copy(items.map((it) => it.copyText || it.text).join("\n"));
  };
  $("#refresh-titles")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Writing…";
    try {
      state.project.analysis = await api(`/api/projects/${p.id}/titles/refresh`, { method: "POST" });
      renderReady(state.project);
      toast("Fresh titles and hooks are in");
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = "Refresh";
    }
  });
}

/** ♥ / ✕ a title so future titles match the creator's taste (titles/ module). */
async function tasteVote(kind, title, list, button) {
  try {
    await api(`/api/titles/${list}`, { method: "POST", body: { title, kind } });
    button?.classList.add("on");
    toast(list === "liked" ? "Saved to your title taste" : "Got it — less like that");
  } catch (err) {
    toast(err.message);
  }
}

function styleButtons(styles, active) {
  return styles.map((s) => `<button data-style="${s.id}" class="${s.id === active ? "on" : ""}" title="${esc(s.description)}"><i style="background:${s.accent}"></i>${esc(s.label)}</button>`).join("");
}

function presetDesign(styleId) {
  const s = state.config.styles.find((x) => x.id === styleId) || state.config.styles.find((x) => x.id === "podcast");
  return { style: s.id, aspect: "9:16", ...s.design };
}

/** A clip's current design; clips from before designs existed fall back to how they were last rendered. */
function clipDesign(c) {
  if (c.design) return { ...presetDesign(c.design.style), ...c.design };
  return { ...presetDesign(c.render?.style || "podcast"), ...(c.render?.cropX != null ? { cropX: c.render.cropX } : {}) };
}

function designSummary(c) {
  const d = clipDesign(c);
  return `${state.config.styles.find((s) => s.id === d.style)?.label || d.style} · ${d.aspect}`;
}

function clipCard(c) {
  return `
    <article class="card clip" data-clip="${c.id}">
      <div class="clip-preview" data-slot="preview"></div>
      <div class="clip-body">
        <div class="clip-top">
          <span class="rank">${pad(c.rank)}</span>
          <span data-slot="time">${fmt(c.start)} – ${fmt(c.end)} · ${fmtLen(c.end - c.start)}</span>
          <span class="design-chip" data-slot="design">${esc(designSummary(c))}</span>
          ${c.needsReview ? `<span class="chip" title="Nothing on this video cleared the bar — this is one of its best moments, for you to judge">Your call</span>` : ""}
          ${c.likeOf ? `<span class="chip like-of" title="Found because you loved clip ${esc(c.likeOf.replace(/\D/g, ""))}">Like ${esc(pad(Number(c.likeOf.replace(/\D/g, ""))))}</span>` : c.tasteMatch >= 3 ? `<span class="chip like-of" title="Close to the clips you've loved">Your style</span>` : ""}
          <span class="score-pill ${c.score >= 85 ? "hot" : ""}" title="Viral score">${c.score}</span>
        </div>
        <div class="title-wrap">
          <input class="title-input" data-field="title" value="${esc(c.title)}" title="On-screen hook title · click to edit" />
          <button class="icon-btn taste" data-hook-taste="liked" title="Love this hook — learn my style">♥</button>
          <button class="icon-btn taste" data-hook-taste="avoid" title="Not my style">✕</button>
        </div>
        <p class="reason">${esc(c.reason)}</p>
        <div class="clip-verdict" data-slot="verdict">
          <button type="button" class="verdict-btn" data-verdict="like" title="Love it — it learns your taste and finds more like this">${ICON.heart} Love this clip</button>
          <button type="button" class="verdict-btn" data-verdict="pass" title="Not for me — it learns to pick fewer like this">${ICON.close} Not for me</button>
          <input class="verdict-note" data-verdict-note placeholder="What makes it good? (optional)" maxlength="300" hidden />
          <span class="verdict-msg" data-slot="more"></span>
        </div>
        <div class="post">
          <details>
            <summary>Post copy</summary>
            <div class="post-body">
              <strong>${esc(c.postTitle)}</strong>
              <p>${esc(c.caption)}</p>
              <div class="tags">${esc((c.hashtags || []).join(" "))}</div>
            </div>
          </details>
          <button class="link-btn post-copy" data-copy-post>Copy</button>
        </div>
        <div class="clip-actions">
          <button class="btn primary" data-preview>${ICON.play} Preview</button>
          <button class="btn" data-edit>${ICON.edit} Edit</button>
          <button class="btn" data-render>Render clip</button>
          <button class="btn danger" data-cancel hidden>${ICON.stop} Stop</button>
          <button class="btn" data-schedule hidden>${ICON.calendar} Schedule</button>
          <span class="render-msg" data-slot="msg"></span>
        </div>
      </div>
    </article>`;
}

/** Update the live parts of a clip card (preview + render status) without touching inputs. */
function patchClip(clip) {
  const p = state.project;
  const card = $(`[data-clip="${clip.id}"]`);
  if (!card) return;
  const r = clip.render || {};
  const busy = RENDER_BUSY.includes(r.status);
  const done = r.status === "done";

  const key = `${r.status}|${r.file}|${r.renderedAt}|${clip.start}`;
  if (state.clipKeys[clip.id] !== key) {
    state.clipKeys[clip.id] = key;
    const slot = $('[data-slot="preview"]', card);
    if (done) {
      slot.innerHTML = `<video src="${fileUrl(p, r.file)}?v=${encodeURIComponent(r.renderedAt)}" controls playsinline loop preload="metadata"></video>`;
    } else {
      slot.innerHTML = `
        <video src="${fileUrl(p, p.work ? "work.mp4" : p.source.file)}#t=${clip.start + 0.5}" muted playsinline preload="metadata"></video>
        ${
          busy
            ? `<div class="overlay"><div class="ring"><span>0%</span></div></div>`
            : `<div class="placeholder">${r.status === "cancelled" ? "Render stopped" : r.status === "error" ? "Render failed" : "Not rendered yet"}</div>`
        }`;
    }
    $("[data-download]", card)?.remove();
    if (done) {
      $('[data-slot="msg"]', card).insertAdjacentHTML(
        "beforebegin",
        `<a class="btn ghost" data-download href="${fileUrl(p, r.file)}" download="${esc(clip.title.replace(/[^\w -]+/g, "").trim() || clip.id)}.mp4">${ICON.download} Download</a>`,
      );
    }
  }

  const ring = $(".ring", card);
  if (ring) {
    ring.style.setProperty("--p", r.progress || 0);
    $("span", ring).textContent = r.status === "queued" ? "…" : `${r.progress || 0}%`;
  }

  const renderBtn = $("[data-render]", card);
  renderBtn.hidden = busy;
  renderBtn.textContent = done ? "Re-render" : "Render clip";
  $("[data-cancel]", card).hidden = !busy;
  $("[data-schedule]", card).hidden = !done;
  $('[data-slot="design"]', card).textContent = designSummary(clip);
  patchVerdict(card, clip);

  const msg = $('[data-slot="msg"]', card);
  msg.className = `render-msg${r.status === "error" ? " err" : ""}`;
  msg.textContent = r.status === "error" ? r.error || r.message : r.status === "queued" ? "Queued — waiting for a render slot" : r.message || "";
  msg.title = msg.textContent;
}

/**
 * A quick look at a clip in a small pop-up: the finished render when there is one, else a live preview of the
 * cut as it stands (the saved timeline edit, or the AI's). "Edit" from there opens the timeline.
 */
function openClipPreview(p, clip) {
  const r = clip.render || {};
  const done = r.status === "done";
  const aspect = (clip.design?.aspect || r.aspect || "9:16").split(":").map(Number);
  const modal = openModal(
    `
    <div class="modal-head">
      <div><h2>${esc(clip.title)}</h2><p class="muted">Clip ${pad(clip.rank)} · ${fmtLen(clip.end - clip.start)} · ${done ? esc(r.message || "Rendered") : "Live preview — not rendered yet"}</p></div>
      <button type="button" class="icon-btn" data-close title="Close">${ICON.close}</button>
    </div>
    <div class="quick-preview" style="aspect-ratio:${aspect[0]} / ${aspect[1]}">
      ${
        done
          ? `<video src="${fileUrl(p, r.file)}?v=${encodeURIComponent(r.renderedAt)}" controls autoplay playsinline></video>`
          : `<hyperframes-player controls autoplay src="/api/editor/projects/${p.id}/clips/${clip.id}/preview?v=${Date.now()}"></hyperframes-player>`
      }
    </div>
    <div class="editor-actions">
      <span class="spacer"></span>
      <button type="button" class="btn" data-close>Close</button>
      <button type="button" class="btn primary" data-go-edit>${ICON.edit} Edit</button>
    </div>`,
    { className: "preview-modal" },
  );
  $("[data-go-edit]", modal).onclick = () => {
    closeModal();
    location.hash = `#/edit/${p.id}/${clip.id}`;
  };
}

/** The ♥ / ✕ row: which verdict is on, the optional note, and the "more like this" search. */
function patchVerdict(card, clip) {
  const verdict = clip.feedback?.verdict || null;
  $$("[data-verdict]", card).forEach((b) => b.classList.toggle("on", b.dataset.verdict === verdict));
  const note = $("[data-verdict-note]", card);
  note.hidden = !verdict;
  if (document.activeElement !== note) {
    note.value = clip.feedback?.reason || "";
    note.placeholder = verdict === "pass" ? "What's off about it? (optional)" : "What makes it good? (optional)";
  }
  const msg = $('[data-slot="more"]', card);
  const m = clip.moreLike;
  const text =
    m?.status === "searching" ? "Finding more like this…" : m?.status === "error" ? m.message : m?.status === "done" ? m.message : verdict === "pass" ? "Got it — fewer like this" : "";
  msg.className = `verdict-msg${m?.status === "searching" ? " busy" : ""}${m?.status === "error" ? " err" : ""}`;
  if (msg.dataset.text !== text + (verdict || "")) {
    msg.dataset.text = text + (verdict || "");
    msg.innerHTML = `${esc(text)}${verdict === "like" && m?.status !== "searching" ? ` <button type="button" class="link-btn" data-more-like>${m ? "Look again" : "Find more like this"}</button>` : ""}`;
  }
}

async function renderClipTaste() {
  const box = $("#clip-taste");
  if (!box) return;
  const t = await api("/api/clip-taste").catch(() => null);
  if (!t || (!t.likes && !t.passes)) return (box.hidden = true);
  const p = t.profile;
  box.hidden = false;
  box.innerHTML = `
    <div class="taste-head">
      <div><b>What it's learned about your clips</b><span class="muted"> · ${plural(t.likes, "love")}, ${t.passes} ${t.passes === 1 ? "pass" : "passes"}${t.learning ? " · learning…" : ""}</span></div>
      ${p ? `<button type="button" class="link-btn" data-taste-more>Details</button>` : ""}
    </div>
    <p>${p ? esc(p.summary) : "Heart a couple of clips and it will write down what you like — every new video is picked with it in mind."}</p>
    ${p ? `<div class="taste-detail" hidden><ul>${p.loves.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>${p.avoids.length ? `<p class="muted">Passes on</p><ul>${p.avoids.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}<p class="muted">${esc(p.openings)}</p></div>` : ""}`;
  const more = $("[data-taste-more]", box);
  if (more) more.onclick = () => {
    const d = $(".taste-detail", box);
    d.hidden = !d.hidden;
    more.textContent = d.hidden ? "Details" : "Hide";
  };
  if (t.learning) setTimeout(renderClipTaste, 8000);
}

function patchHead() {
  const stopAll = $("#stop-all");
  if (stopAll) stopAll.hidden = !state.project.clips.some((c) => RENDER_BUSY.includes(c.render?.status));
}

const clipItem = (p, c) => ({
  projectId: p.id,
  projectName: p.name,
  clipId: c.id,
  title: c.title,
  postTitle: c.postTitle,
  caption: c.caption,
  hashtags: c.hashtags,
  file: c.render.file,
  duration: c.end - c.start,
  score: c.score,
});

function bindReady(p) {
  const source = $("#source");
  let stopAt = null;
  source.addEventListener("timeupdate", () => {
    if (stopAt !== null && source.currentTime >= stopAt) {
      source.pause();
      stopAt = null;
    }
  });
  const seek = (t, until = null) => {
    source.currentTime = t;
    stopAt = until;
    source.play();
    if (window.innerWidth < 1000) source.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  state.seek = seek;
  bindProjectDeletes(app);
  $$("[data-seek]").forEach((el) => (el.onclick = () => seek(Number(el.dataset.seek))));
  $$("[data-copy]").forEach((el) => (el.onclick = () => copy(el.dataset.copy)));

  const applyProject = (next) => {
    state.project = next;
    next.clips.forEach(patchClip);
    patchHead();
  };

  $("#retitle").onclick = async (e) => {
    const note = prompt("Anything the new titles should do? (optional)\n\ne.g. lead with the number, speak to chiropractors, name the mistake", "") ?? null;
    if (note === null) return;
    const button = e.currentTarget;
    button.disabled = true;
    button.textContent = "Rewriting…";
    try {
      const out = await api(`/api/projects/${p.id}/clips/retitle`, { method: "POST", body: { note } });
      state.project.clips = out.clips;
      renderProject();
      toast(`Rewrote ${plural(out.rewritten.length, "title")} — re-render a clip to burn the new headline in`);
    } catch (err) {
      toast(err.message);
      button.disabled = false;
      button.textContent = "Rewrite titles";
    }
  };

  $("#repick").onclick = async () => {
    if (!confirm("Pick this video's clips again with the latest engine?\n\nEach new pick is checked before it renders. Clips you edited on the timeline stay; the others are replaced.")) return;
    try {
      state.project.repick = await api(`/api/projects/${p.id}/clips/repick`, { method: "POST", body: {} });
      $("#repick").disabled = true;
      $("#repick").textContent = "Re-picking…";
      toast("Re-picking — new clips will appear here when they're checked");
    } catch (err) {
      toast(err.message);
    }
  };

  $("#render-all").onclick = async () => {
    try {
      applyProject(await api(`/api/projects/${p.id}/render-all`, { method: "POST", body: {} }));
      toast("Rendering all clips");
    } catch (err) {
      toast(err.message);
    }
  };

  $("#stop-all").onclick = async () => {
    try {
      applyProject(await api(`/api/projects/${p.id}/cancel-all`, { method: "POST" }));
      toast("Stopped all renders");
    } catch (err) {
      toast(err.message);
    }
  };

  for (const clip of p.clips) {
    const card = $(`[data-clip="${clip.id}"]`);
    const current = () => state.project.clips.find((c) => c.id === clip.id);
    const replaceClip = (updated) => {
      Object.assign(current(), updated);
      patchClip(current());
      patchHead();
    };
    const save = async (patch) => {
      try {
        const updated = await api(`/api/projects/${p.id}/clips/${clip.id}`, { method: "PATCH", body: patch });
        Object.assign(current(), updated);
        return updated;
      } catch (err) {
        toast(err.message);
      }
    };

    $$("[data-field]", card).forEach((input) => {
      input.addEventListener("change", () => save({ [input.dataset.field]: input.value }));
      input.addEventListener("keydown", (e) => e.key === "Enter" && input.blur());
    });

    $$("[data-trim]", card).forEach((b) => {
      b.onclick = async () => {
        const [edge, delta] = b.dataset.trim.split(":");
        const c = current();
        const updated = await save({ [edge]: Math.round((c[edge] + Number(delta)) * 10) / 10 });
        if (!updated) return;
        $('[data-slot="start"]', card).textContent = fmt(updated.start);
        $('[data-slot="end"]', card).textContent = fmt(updated.end);
        $('[data-slot="time"]', card).textContent = `${fmt(updated.start)} – ${fmt(updated.end)} · ${fmtLen(updated.end - updated.start)}`;
        patchClip(current());
      };
    });

    $("[data-preview]", card).onclick = () => openClipPreview(p, current());
    $("[data-edit]", card).onclick = () => (location.hash = `#/edit/${p.id}/${clip.id}`);

    $("[data-copy-post]", card).onclick = () => copy(captionFor(current()));
    $$("[data-hook-taste]", card).forEach((b) => (b.onclick = () => tasteVote("hook", $(".title-input", card).value, b.dataset.hookTaste, b)));

    const sendVerdict = async (body) => {
      try {
        replaceClip(await api(`/api/projects/${p.id}/clips/${clip.id}/feedback`, { method: "POST", body }));
        renderClipTaste();
      } catch (err) {
        toast(err.message);
      }
    };
    $$("[data-verdict]", card).forEach((b) => {
      b.onclick = async () => {
        const verdict = current().feedback?.verdict === b.dataset.verdict ? null : b.dataset.verdict;
        await sendVerdict({ verdict });
        if (verdict === "like") toast(current().moreLike?.status === "searching" ? "Loved — learning your taste and finding more like this" : "Loved — learning your taste");
        if (verdict) $("[data-verdict-note]", card).focus();
      };
    });
    const note = $("[data-verdict-note]", card);
    note.addEventListener("keydown", (e) => e.key === "Enter" && note.blur());
    note.addEventListener("change", () => current().feedback && sendVerdict({ verdict: current().feedback.verdict, reason: note.value, more: false }));
    $('[data-slot="more"]', card).addEventListener("click", async (e) => {
      if (!e.target.closest("[data-more-like]")) return;
      try {
        replaceClip(await api(`/api/projects/${p.id}/clips/${clip.id}/more-like-this`, { method: "POST", body: {} }));
      } catch (err) {
        toast(err.message);
      }
    });

    $("[data-render]", card).onclick = async () => {
      try {
        replaceClip(await api(`/api/projects/${p.id}/clips/${clip.id}/render`, { method: "POST", body: {} }));
      } catch (err) {
        toast(err.message);
      }
    };

    $("[data-cancel]", card).onclick = async () => {
      try {
        replaceClip(await api(`/api/projects/${p.id}/clips/${clip.id}/cancel`, { method: "POST" }));
        toast("Render stopped");
      } catch (err) {
        toast(err.message);
      }
    };

    $("[data-schedule]", card).onclick = () => openComposer({ item: clipItem(state.project, current()) });
  }
}

// ---------- clip editor (live preview) ----------
const COLOR_COMBOS = [
  ["#FFFFFF", "#FFFFFF", "#FFFFFF"], // all white — the Podcast Frame default
  ["#F0CE6A", "#F0CE6A", "#FFFFFF"], // the gold lettering from the reel
  ["#FFFFFF", "#FFE600", "#4ADE80"],
  ["#FFFFFF", "#22D3EE", "#FACC15"],
  ["#FFFFFF", "#FF3D71", "#FFD166"],
  ["#FFFFFF", "#7C3AED", "#FDE68A"],
  ["#FFFFFF", "#FF7A00", "#FFFFFF"],
  ["#111111", "#FFFFFF", "#FF3D71"],
  ["#FDE68A", "#FFFFFF", "#4ADE80"],
];

const RANGE_LABEL = {
  captionScale: (v) => `${Math.round(v * 100)}%`,
  captionY: (v) => `${Math.round(v)}%`,
  maxWords: (v) => `${v}`,
  titleOut: (v) => (Number(v) ? `${v}s` : "never"),
  cropX: (v) => `${Math.round(v)}%`,
  musicLevel: (v) => `${Math.round(v * 100)}%`,
};

function openEditor(clipId) {
  const current = () => state.project.clips.find((c) => c.id === clipId);
  const c0 = current();
  const draft = { title: c0.title, highlight: c0.highlight || "", design: clipDesign(c0) };
  if (draft.design.captionY == null) draft.design.captionY = null;
  if (typeof draft.design.autoFrame !== "boolean") draft.design.autoFrame = true; // on unless turned off
  const { aspects, fonts, styles } = state.config;
  const d = draft.design;

  const seg = (name, options) =>
    `<div class="segmented seg-fill" data-seg="${name}">${options.map(([v, label]) => `<button type="button" data-v="${v}">${label}</button>`).join("")}</div>`;
  const toggle = (name, label) => `<label class="toggle"><input type="checkbox" data-bool="${name}" /><span class="track"></span>${label}</label>`;
  const range = (name, label, min, max, step) =>
    `<label class="range-field"><span>${label}<b data-out="${name}"></b></span><input type="range" data-num="${name}" min="${min}" max="${max}" step="${step}" /></label>`;
  const color = (name, label) => `<label class="color-field"><input type="color" data-color="${name}" /><span>${label}</span></label>`;

  const modal = openModal(
    `
    <div class="editor">
      <div class="editor-stage">
        <div class="stage-frame" data-frame><hyperframes-player data-player controls loop autoplay></hyperframes-player></div>
        <p class="stage-note">Live preview · Render bakes it into an MP4</p>
      </div>
      <div class="editor-panel">
        <div class="modal-head">
          <div><h2>Clip ${pad(c0.rank)}</h2><p class="muted" data-slot="range"></p></div>
          <button type="button" class="icon-btn" data-close title="Close">${ICON.close}</button>
        </div>

        <section class="ed-section ed-main">
          <label class="field"><span>Hook title</span><input data-text="title" maxlength="120" list="saved-title-list" /></label>
          <datalist id="saved-title-list"></datalist>
          <label class="field"><span>Highlight word</span><input data-text="highlight" maxlength="40" /></label>
          <div class="field"><span>Style</span>${seg("style", styles.map((s) => [s.id, s.label]))}</div>
          <div class="field"><span>Format</span>
            <div class="aspect-pick">
              ${Object.entries(aspects)
                .map(([id, a]) => `<button type="button" data-aspect="${id}" title="${esc(a.hint)}"><i style="aspect-ratio:${a.width} / ${a.height}"></i><b>${a.label}</b></button>`)
                .join("")}
            </div>
          </div>
        </section>

        <details class="ed-fold" open data-transcript-fold>
          <summary>Transcript</summary>
          <div class="ed-fold-body">
            <p class="muted te-help">Click a word to jump there. Select words and <b>Cut</b> to take them out of the video, or double-click one to fix its spelling. Faded words are trimmed automatically (filler, pauses, restarts).</p>
            <div class="te-bar" data-te-bar hidden>
              <span data-te-count></span>
              <button type="button" class="btn sm" data-te-act="cut">Cut</button>
              <button type="button" class="btn sm ghost" data-te-act="restore">Restore</button>
              <button type="button" class="btn sm ghost" data-te-act="clear">Cancel</button>
            </div>
            <div class="te-words" data-te-words><div class="loading">Loading transcript…</div></div>
          </div>
        </details>

        <details class="ed-fold">
          <summary>Title look</summary>
          <div class="ed-fold-body">
            <div class="field"><span>Look</span>${seg("titleStyle", [["card", "Card"], ["pill", "Pill"], ["plain", "Plain"]])}</div>
            <div class="row2">
              ${toggle("showTitle", "Show title")}
              ${range("titleOut", "Hide after", 0, 30, 1)}
            </div>
          </div>
        </details>

        <details class="ed-fold">
          <summary>Captions</summary>
          <div class="ed-fold-body">
            <div class="row2">
              <label class="field"><span>Font</span><select data-select="font">${Object.entries(fonts).map(([id, f]) => `<option value="${id}">${esc(f.label)}</option>`).join("")}</select></label>
              <div class="field"><span>Active word</span>${seg("highlight", [["reveal", "Reveal"], ["color", "Color"], ["pill", "Pill"], ["serif", "Serif"], ["none", "Off"]])}</div>
            </div>
            ${range("captionScale", "Size", 0.4, 1.6, 0.05)}
            ${range("captionY", "Height on screen", 5, 95, 1)}
            ${range("maxWords", "Words at a time", 1, 6, 1)}
            <div class="row2">${toggle("uppercase", "ALL CAPS")}${toggle("outline", "Outline")}</div>
          </div>
        </details>

        <details class="ed-fold">
          <summary>Colors</summary>
          <div class="ed-fold-body">
            <div class="swatches">
              ${COLOR_COMBOS.map((combo, i) => `<button type="button" class="swatch" data-combo="${i}" title="Use these colors">${combo.map((c) => `<i style="background:${c}"></i>`).join("")}</button>`).join("")}
            </div>
            <div class="colors">${color("textColor", "Text")}${color("accentColor", "Highlight")}${color("emphasisColor", "Key words")}</div>
          </div>
        </details>

        <details class="ed-fold">
          <summary>Trim &amp; framing</summary>
          <div class="ed-fold-body">
            <div class="field"><span>Motion</span>${seg("motion", [["punchy", "Punchy"], ["gentle", "Gentle"], ["none", "Still"]])}</div>
            <div class="row2">
              <label class="field"><span>Music bed</span><select data-select="musicBed"><option value="auto">Auto — instrumental from my sounds</option><option value="none">No music</option></select></label>
              ${range("musicLevel", "Music level", 0, 0.8, 0.01)}
            </div>
            ${toggle("autoFrame", "Auto-frame — follow the speaker")}
            ${range("cropX", "Crop  ←  →", 0, 100, 1)}
            <div class="row2">${toggle("zoom", "Zoom punches")}${toggle("progress", "Progress bar")}</div>
            <div class="row2">
              <div class="mini">Start <button type="button" class="stepbtn" data-trim="start:-1">−</button><b data-slot="start"></b><button type="button" class="stepbtn" data-trim="start:1">+</button></div>
              <div class="mini">End <button type="button" class="stepbtn" data-trim="end:-1">−</button><b data-slot="end"></b><button type="button" class="stepbtn" data-trim="end:1">+</button></div>
            </div>
          </div>
        </details>

        <div class="editor-actions">
          <button type="button" class="btn ghost" data-reset>Reset</button>
          <button type="button" class="btn ghost" data-apply-all title="Use this look on every clip">Apply to all</button>
          <span class="spacer"></span>
          <button type="button" class="btn" data-save>Save</button>
          <button type="button" class="btn primary" data-render-now>Render</button>
        </div>
      </div>
    </div>`,
    { wide: true, className: "editor-modal" },
  );

  const player = $("[data-player]", modal);
  const frame = $("[data-frame]", modal);
  let timer;
  bindTranscriptEditor(modal, clipId, player, () => refresh(0));
  // Saved titles show up as suggestions in the hook title field.
  savedTitles().then((list) => {
    const options = $("#saved-title-list", modal);
    if (options) options.innerHTML = list.map((t) => `<option value="${esc(t.title)}"></option>`).join("");
  });
  // Music beds: the creator's instrumental sounds first, then anything with words on it.
  api("/api/sounds")
    .then((tracks) => {
      const select = $('[data-select="musicBed"]', modal);
      if (!select || !tracks.length) return;
      const group = (label, list) => (list.length ? `<optgroup label="${label}">${list.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</optgroup>` : "");
      select.insertAdjacentHTML("beforeend", group("No words over it", tracks.filter((t) => t.hasWords === false)) + group("Has words", tracks.filter((t) => t.hasWords !== false)));
      select.value = draft.design.musicBed || "auto";
    })
    .catch(() => {});

  const load = () => {
    const a = aspects[draft.design.aspect];
    frame.style.aspectRatio = `${a.width} / ${a.height}`;
    frame.dataset.orient = a.width > a.height ? "wide" : "tall";
    player.setAttribute("width", a.width);
    player.setAttribute("height", a.height);
    const params = new URLSearchParams({ design: JSON.stringify(draft.design), title: draft.title, highlight: draft.highlight, v: Date.now() });
    player.setAttribute("src", `/api/projects/${state.project.id}/clips/${clipId}/preview?${params}`);
  };
  const refresh = (delay = 250) => {
    clearTimeout(timer);
    timer = setTimeout(load, delay);
  };

  const sync = () => {
    const dd = draft.design;
    const c = current();
    $('[data-slot="range"]', modal).textContent = `${fmt(c.start)} – ${fmt(c.end)} · ${fmtLen(c.end - c.start)}`;
    $('[data-slot="start"]', modal).textContent = fmt(c.start);
    $('[data-slot="end"]', modal).textContent = fmt(c.end);
    $$("[data-aspect]", modal).forEach((b) => b.classList.toggle("on", b.dataset.aspect === dd.aspect));
    $$("[data-seg]", modal).forEach((g) => $$("button", g).forEach((b) => b.classList.toggle("on", String(dd[g.dataset.seg]) === b.dataset.v)));
    $$("[data-bool]", modal).forEach((i) => (i.checked = Boolean(dd[i.dataset.bool])));
    $$("[data-num]", modal).forEach((i) => {
      const key = i.dataset.num;
      const value = dd[key] ?? (key === "captionY" ? 70 : Number(i.min));
      i.value = value;
      $(`[data-out="${key}"]`, modal).textContent = dd[key] == null && key === "captionY" ? "auto" : RANGE_LABEL[key](value);
    });
    $$("[data-color]", modal).forEach((i) => (i.value = dd[i.dataset.color].toLowerCase()));
    $$("[data-select]", modal).forEach((i) => (i.value = dd[i.dataset.select]));
    $$("[data-text]", modal).forEach((i) => document.activeElement !== i && (i.value = draft[i.dataset.text]));
  };

  const setDesign = (patch, delay) => {
    Object.assign(draft.design, patch);
    sync();
    refresh(delay);
  };

  modal.addEventListener("click", (e) => {
    const aspect = e.target.closest("[data-aspect]");
    if (aspect) return setDesign({ aspect: aspect.dataset.aspect }, 0);
    const segBtn = e.target.closest("[data-seg] button");
    if (segBtn) {
      const key = segBtn.closest("[data-seg]").dataset.seg;
      if (key === "style") {
        // Keep the creator's own choices when swapping style.
        const { aspect, cropX, autoFrame, musicBed, musicLevel } = draft.design;
        draft.design = { ...presetDesign(segBtn.dataset.v), aspect, cropX, autoFrame, musicBed, musicLevel };
        sync();
        return refresh(0);
      }
      return setDesign({ [key]: segBtn.dataset.v }, 0);
    }
    const combo = e.target.closest("[data-combo]");
    if (combo) {
      const [textColor, accentColor, emphasisColor] = COLOR_COMBOS[Number(combo.dataset.combo)];
      return setDesign({ textColor, accentColor, emphasisColor }, 0);
    }
  });
  $$("[data-bool]", modal).forEach((i) => (i.onchange = () => setDesign({ [i.dataset.bool]: i.checked }, 0)));
  // Placing the crop by hand switches auto-frame off.
  $$("[data-num]", modal).forEach((i) => (i.oninput = () => setDesign({ [i.dataset.num]: Number(i.value), ...(i.dataset.num === "cropX" ? { autoFrame: false } : {}) }, 450)));
  $$("[data-color]", modal).forEach((i) => (i.oninput = () => setDesign({ [i.dataset.color]: i.value.toUpperCase() }, 350)));
  $$("[data-select]", modal).forEach((i) => (i.onchange = () => setDesign({ [i.dataset.select]: i.value }, 0)));
  $$("[data-text]", modal).forEach(
    (i) =>
      (i.oninput = () => {
        draft[i.dataset.text] = i.value;
        refresh(600);
      }),
  );

  $$("[data-trim]", modal).forEach(
    (b) =>
      (b.onclick = async () => {
        const [edge, delta] = b.dataset.trim.split(":");
        try {
          const updated = await api(`/api/projects/${state.project.id}/clips/${clipId}`, {
            method: "PATCH",
            body: { [edge]: Math.round((current()[edge] + Number(delta)) * 10) / 10 },
          });
          Object.assign(current(), updated);
          sync();
          refresh(0);
        } catch (err) {
          toast(err.message);
        }
      }),
  );

  $("[data-reset]", modal).onclick = () => {
    draft.design = { ...presetDesign(draft.design.style), aspect: draft.design.aspect, cropX: draft.design.cropX, autoFrame: draft.design.autoFrame };
    sync();
    refresh(0);
  };

  const save = async () => {
    const updated = await api(`/api/projects/${state.project.id}/clips/${clipId}`, {
      method: "PATCH",
      body: { title: draft.title, highlight: draft.highlight, design: draft.design },
    });
    Object.assign(current(), updated);
    const card = $(`[data-clip="${clipId}"]`);
    if (card) {
      $(".title-input", card).value = updated.title;
      const highlight = $('[data-field="highlight"]', card);
      if (highlight) highlight.value = updated.highlight || "";
      patchClip(current());
    }
    return updated;
  };

  $("[data-save]", modal).onclick = async () => {
    try {
      await save();
      toast("Saved");
    } catch (err) {
      toast(err.message);
    }
  };

  $("[data-apply-all]", modal).onclick = async () => {
    try {
      await save();
      state.project = await api(`/api/projects/${state.project.id}/design-all`, { method: "POST", body: { design: draft.design } });
      state.project.clips.forEach(patchClip);
      toast("Look applied to every clip");
    } catch (err) {
      toast(err.message);
    }
  };

  $("[data-render-now]", modal).onclick = async () => {
    try {
      await save();
      const updated = await api(`/api/projects/${state.project.id}/clips/${clipId}/render`, { method: "POST", body: {} });
      Object.assign(current(), updated);
      patchClip(current());
      patchHead();
      closeModal();
      toast("Rendering with your changes");
    } catch (err) {
      toast(err.message);
    }
  };

  sync();
  load();
}

// ---------- scheduler ----------
const SCHED_TABS = [
  ["review", "Review clips"],
  ["calendar", "Calendar"],
  ["accounts", "Accounts"],
];

async function showScheduler(tab) {
  state.week ??= startOfWeek(new Date());
  app.innerHTML = `
    <div class="page-head">
      <div><h1>Scheduler</h1><p class="muted">Review finished clips and plan posts across all your accounts.</p></div>
      <div class="segmented" id="sched-tabs">
        ${SCHED_TABS.map(([id, label]) => `<button data-tab="${id}" class="${id === tab ? "on" : ""}">${label}</button>`).join("")}
      </div>
    </div>
    <section class="card autopost" id="autopost"></section>
    <div id="sched"><div class="loading">Loading…</div></div>`;
  $("#sched-tabs").onclick = (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) location.hash = `#/scheduler?tab=${b.dataset.tab}`;
  };

  await loadScheduler();
  renderSchedulerTab(tab);
  renderAutoPost();

  // Keep post statuses fresh on the calendar (posts turn "due" when their time comes).
  state.poll = setInterval(async () => {
    if (tab !== "calendar" || $(".modal-backdrop")) return;
    await loadScheduler();
    renderCalendar();
  }, 20000);
}

async function loadScheduler() {
  let ig;
  [state.library, state.accounts, state.posts, ig] = await Promise.all([
    api("/api/library"),
    api("/api/accounts"),
    api("/api/posts"),
    api("/api/integrations/instagram/accounts").catch(() => []),
  ]);
  state.igAccounts = Array.isArray(ig) ? ig : ig?.accounts || [];
}

const currentSchedulerTab = () => new URLSearchParams(location.hash.split("?")[1] || "").get("tab") || "review";

function renderSchedulerTab(tab) {
  if (tab === "calendar") renderCalendar();
  else if (tab === "accounts") renderAccounts();
  else renderReview();
}

async function refreshScheduler() {
  refreshBadge();
  if (!location.hash.startsWith("#/scheduler")) return;
  await loadScheduler();
  renderSchedulerTab(currentSchedulerTab());
}

// ---------- intentional reels (lib/intentional.js) ----------

const REEL_STATUS = [["new", "To ask"], ["asked", "Asked"], ["filmed", "Filmed"], ["skipped", "Skipped"]];

async function showReels() {
  app.innerHTML = `
    <div class="page-head">
      <div><h1>Intentional reels</h1><p class="muted">Instead of hunting clips in footage you already have, this reads everything it has learned about your audience and about Dr Odell, and writes the questions to ask him on camera — each one already shaped into a reel.</p></div>
    </div>
    <section class="card reels-top" id="reels-top"></section>
    <div id="reels-list"><div class="loading">Loading…</div></div>`;
  await renderReels();
}

async function renderReels() {
  const data = await api("/api/intentional").catch(() => null);
  const top = $("#reels-top");
  const list = $("#reels-list");
  if (!data || !top) return;
  const filter = (state.reelFilter ||= "new");
  const counts = Object.fromEntries(REEL_STATUS.map(([id]) => [id, data.questions.filter((q) => q.status === id).length]));

  top.innerHTML = `
    <div class="ap-head">
      <div>
        <h3>What it has read</h3>
        <p class="muted">${data.knows.audience ? esc((data.knows.sources || []).join(", ")) : "Nothing yet — add a workshop, client call or SOP on the Projects page first."}${data.lastRunAt ? ` · last batch ${agoLabel(data.lastRunAt)}` : ""}</p>
      </div>
      <label class="btn"><input id="reels-src" type="file" accept=".vtt,.srt,.txt,.md,.docx,.pdf" hidden />${ICON.upload} Feed it more</label>
    </div>
    <div class="ap-row">
      <label class="field"><span>How many questions</span><input type="number" id="reels-count" min="3" max="15" value="8" /></label>
      <label class="field ap-accounts"><span>Anything this batch should focus on? <em>· optional</em></span><input id="reels-note" placeholder="e.g. his story before HBA, the van, hiring, AI in the practice" /></label>
    </div>
    <div class="clip-actions"><button class="btn primary" id="reels-go">Write questions</button><span class="render-msg" id="reels-msg"></span></div>`;

  const chips = REEL_STATUS.map(([id, label]) => `<button data-reel-filter="${id}" class="${id === filter ? "on" : ""}">${label}<span>${counts[id] || ""}</span></button>`).join("");
  const shown = data.questions.filter((q) => q.status === filter);
  list.innerHTML = `
    <div class="toolbar"><div class="segmented" id="reel-filters">${chips}</div><span class="muted">${plural(data.questions.length, "question")} in total</span></div>
    ${
      shown.length
        ? `<div class="reel-grid">${shown.map(reelCard).join("")}</div>`
        : `<div class="empty">${filter === "new" ? "No questions waiting. Write a batch above." : `Nothing ${filter} yet.`}</div>`
    }`;

  $$("[data-reel-filter]", list).forEach((b) => (b.onclick = () => {
    state.reelFilter = b.dataset.reelFilter;
    renderReels();
  }));
  $$("[data-reel-status]", list).forEach((b) => (b.onclick = async () => {
    try {
      await api(`/api/intentional/${b.dataset.id}`, { method: "PATCH", body: { status: b.dataset.reelStatus } });
      renderReels();
    } catch (err) {
      toast(err.message);
    }
  }));
  $$("[data-reel-copy]", list).forEach((b) => (b.onclick = () => copy(b.dataset.reelCopy)));
  $$("[data-reel-delete]", list).forEach((b) => (b.onclick = async () => {
    await api(`/api/intentional/${b.dataset.id}`, { method: "DELETE" }).catch((err) => toast(err.message));
    renderReels();
  }));

  $("#reels-go").onclick = async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    $("#reels-msg").textContent = "Reading everything it knows and writing…";
    try {
      const out = await api("/api/intentional/generate", { method: "POST", body: { count: Number($("#reels-count").value) || 8, note: $("#reels-note").value } });
      state.reelFilter = "new";
      toast(`${plural(out.added.length, "question")} ready to ask`);
      renderReels();
    } catch (err) {
      toast(err.message);
      $("#reels-msg").textContent = err.message;
      button.disabled = false;
    }
  };
  $("#reels-src").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    $("#reels-msg").textContent = `Reading ${file.name}…`;
    const body = new FormData();
    body.append("file", file);
    try {
      const res = await fetch("/api/audience/sources", { method: "POST", body });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || "Couldn't read that file");
      toast("Learned — write a new batch to use it");
      renderReels();
    } catch (err) {
      toast(err.message);
      $("#reels-msg").textContent = err.message;
    }
  };
}

function reelCard(q) {
  const ask = `${q.question}${q.follow_up ? `\n\nFollow-up: ${q.follow_up}` : ""}`;
  return `
    <article class="card reel-card">
      <div class="clip-top"><span class="score-pill ${q.priority >= 85 ? "hot" : ""}">${q.priority}</span><span>${esc(q.who || "")}</span></div>
      <h3 class="reel-q">${esc(q.question)}</h3>
      ${q.follow_up ? `<p class="reel-follow"><b>Follow-up:</b> ${esc(q.follow_up)}</p>` : ""}
      <dl class="reel-meta">
        <dt>Answers</dt><dd>${esc(q.answers || "")}</dd>
        <dt>Angle</dt><dd>${esc(q.angle || "")}</dd>
        <dt>Hook</dt><dd>“${esc(q.hook || "")}”</dd>
        <dt>Title</dt><dd>${esc(q.title || "")}</dd>
      </dl>
      <div class="clip-actions">
        <button class="btn sm" data-reel-copy="${esc(ask)}">${ICON.copy} Copy question</button>
        ${REEL_STATUS.filter(([id]) => id !== q.status).map(([id, label]) => `<button class="btn sm ghost" data-reel-status="${id}" data-id="${q.id}">${label}</button>`).join("")}
        <button class="icon-btn" data-reel-delete data-id="${q.id}" title="Remove">${ICON.trash}</button>
      </div>
    </article>`;
}

/** Who the clips are for: the brief learned from the creator's workshops and client calls (lib/audience.js). */
async function renderAudience() {
  const box = $("#audience");
  if (!box) return;
  const data = await api("/api/audience").catch(() => null);
  if (!data) return (box.hidden = true);
  const b = data.brief;
  box.hidden = false;
  box.innerHTML = `
    <div class="ap-head">
      <div>
        <h3>Who your clips are for</h3>
        <p class="muted">${
          b
            ? "Every video is picked with this in mind: the questions your clients ask, what keeps them stuck, and the words they use. Add another workshop or client call any time and it learns more."
            : "Add a workshop deck or a client call transcript and it learns who you're talking to — then every clip is picked to answer what they actually ask."
        }</p>
      </div>
      <label class="btn"><input id="aud-file" type="file" accept=".vtt,.srt,.txt,.md,.docx,.pdf" hidden />${ICON.upload} Add a call or deck</label>
    </div>
    ${
      b
        ? `<div class="aud-body">
            <p class="aud-who">${esc(b.audience)}</p>
            <div class="aud-stats">
              <span class="chip">${plural((b.questions || []).length, "question")}</span>
              <span class="chip">${plural((b.pains || []).length, "pain point")}</span>
              <span class="chip">${plural((b.objections || []).length, "objection")}</span>
              <span class="chip">${plural((b.angles || []).length, "angle")}</span>
            </div>
            <details class="long-copy"><summary>What it learned</summary>
              <div class="aud-detail">
                <b>Questions they ask</b>
                <ul>${(b.questions || []).map((q) => `<li>${esc(q.question)}<em class="muted"> — ${esc(q.why)}</em></li>`).join("")}</ul>
                <b>Why they hesitate</b>
                <ul>${(b.objections || []).map((o) => `<li>${esc(o)}</li>`).join("")}</ul>
                <b>Angles that land</b>
                <ul>${(b.angles || []).map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
              </div>
            </details>
            <p class="muted aud-sources">From ${(data.sources || []).map((x) => esc(x.name)).join(", ") || "—"}</p>
          </div>`
        : ""
    }
    <p class="aud-status" data-slot="aud-msg" hidden></p>`;

  const msg = $('[data-slot="aud-msg"]', box);
  $("#aud-file", box).onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    msg.hidden = false;
    msg.textContent = `Reading ${file.name}… this takes a minute or two`;
    const data = new FormData();
    data.append("file", file);
    try {
      const res = await fetch("/api/audience/sources", { method: "POST", body: data });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Couldn't read that file");
      toast("Learned — new clips will be picked for this audience");
      renderAudience();
    } catch (err) {
      msg.textContent = err.message;
      toast(err.message);
    }
  };
}

/** Auto-post: one qualifying clip a day, scheduled forward on its own. */
async function renderAutoPost() {
  const box = $("#autopost");
  if (!box) return;
  const a = (state.autoPost = await api("/api/autopost").catch(() => null));
  if (!a) return (box.hidden = true);
  // Tomorrow and beyond say the date; today and yesterday already carry their time.
  const when = (iso) => {
    const d = new Date(iso);
    const days = Math.round((d - new Date()) / 864e5);
    const day = days <= 0 ? dayLabel(iso) : days < 1.2 ? "Tomorrow" : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    return /\d:\d/.test(day) ? day : `${day}, ${timeLabel(d)}`;
  };
  box.hidden = false;
  box.innerHTML = `
    <div class="ap-head">
      <div>
        <h3>Auto-post</h3>
        <p class="muted">One clip a day, on its own: the best clips scoring ${a.minScore}+ that passed review get scheduled forward, one per day, so there's always a post going out.</p>
      </div>
      <label class="toggle ap-switch"><input type="checkbox" data-ap="on" ${a.on ? "checked" : ""} /><span class="track"></span>${a.on ? "On" : "Off"}</label>
    </div>
    <div class="ap-row">
      <label class="field"><span>Time each day</span><input type="time" data-ap="time" value="${esc(a.time)}" /></label>
      <label class="field"><span>Score needed</span><input type="number" min="50" max="100" step="5" data-ap="minScore" value="${a.minScore}" /></label>
      <label class="field"><span>Lined up at a time</span><input type="number" min="1" max="7" data-ap="perRun" value="${a.perRun}" /></label>
      <div class="field ap-accounts"><span>Post to</span>
        ${
          a.accounts.length
            ? `<div class="ap-picks">${a.accounts.map((acc) => `<label class="chip-check"><input type="checkbox" data-ap-account="${acc.id}" ${a.accountIds.includes(acc.id) ? "checked" : ""} />${esc(acc.name)}</label>`).join("")}</div>`
            : `<p class="muted"><a class="link-btn" href="#/scheduler?tab=accounts">Connect an account →</a></p>`
        }
      </div>
    </div>
    <div class="ap-next">
      ${
        a.nextUp.length
          ? `<b>Next up (${a.ready} ready)</b><ol class="ap-list">${a.nextUp.map((c, i) => `<li><span class="score-pill">${c.score}</span> ${esc(c.title)} <em class="muted">${a.slots[i] ? when(a.slots[i]) : "after the ones already scheduled"}</em></li>`).join("")}</ol>`
          : `<b>Nothing qualifies yet</b><p class="muted">Clips need to score ${a.minScore}+ and pass review. Render more clips, or lower the score.</p>`
      }
      ${a.scheduled ? `<p class="muted">${plural(a.scheduled, "clip")} already auto-scheduled.</p>` : ""}
      ${a.lastMessage ? `<p class="muted ap-last">Last check: ${esc(a.lastMessage)}${a.lastRunAt ? ` · ${agoLabel(a.lastRunAt)}` : ""}</p>` : ""}
    </div>
    <div class="clip-actions">
      <button class="btn" data-ap-run ${a.nextUp.length ? "" : "disabled"}>Schedule now</button>
      <a class="link-btn" href="#/scheduler?tab=calendar">See the calendar →</a>
    </div>`;

  const save = async (patch) => {
    try {
      state.autoPost = await api("/api/autopost", { method: "PUT", body: patch });
      renderAutoPost();
    } catch (err) {
      toast(err.message);
    }
  };
  $$("[data-ap]", box).forEach((input) => {
    input.onchange = () => {
      const key = input.dataset.ap;
      save({ [key]: key === "on" ? input.checked : input.value });
      if (key === "on") toast(input.checked ? "Auto-post on — a clip a day from here" : "Auto-post off — nothing new will be scheduled");
    };
  });
  $$("[data-ap-account]", box).forEach((input) => {
    input.onchange = () => save({ accountIds: $$("[data-ap-account]", box).filter((x) => x.checked).map((x) => x.dataset.apAccount) });
  });
  $("[data-ap-run]", box).onclick = async (e) => {
    e.currentTarget.disabled = true;
    try {
      const out = await api("/api/autopost/run", { method: "POST", body: {} });
      toast(out.message || "Scheduled");
      await loadScheduler();
      renderSchedulerTab(currentSchedulerTab());
      renderAutoPost();
    } catch (err) {
      toast(err.message);
      e.currentTarget.disabled = false;
    }
  };
}

function renderReview() {
  const filter = state.reviewFilter;
  const items = state.library.filter((i) => filter === "all" || (filter === "unscheduled" ? !i.scheduledCount : i.scheduledCount > 0));
  // Selection survives filter changes and refreshes; clips that are gone drop out of it.
  const selected = (state.reviewSelected = new Set(state.library.map(libraryKey).filter((k) => state.reviewSelected?.has(k))));
  const body = $("#sched");
  body.innerHTML = `
    ${state.accounts.length ? "" : `<div class="banner">Add the accounts you post to first. <a class="link-btn" href="#/scheduler?tab=accounts">Add an account →</a></div>`}
    <div class="toolbar">
      <div class="segmented" id="review-filter">
        ${[["all", "All"], ["unscheduled", "Not scheduled"], ["scheduled", "Scheduled"]]
          .map(([id, label]) => `<button data-filter="${id}" class="${id === filter ? "on" : ""}">${label}</button>`)
          .join("")}
      </div>
      <div class="review-tools">
        ${items.length ? `<button class="link-btn" data-select-all></button>` : ""}
        <span class="muted">${plural(state.library.length, "finished clip")}</span>
      </div>
    </div>
    ${
      items.length
        ? `<div class="review-grid">${items.map((item, i) => reviewCard(item, i, selected.has(libraryKey(item)))).join("")}</div>`
        : `<div class="empty">${
            state.library.length
              ? "No clips match this filter."
              : `No finished clips yet. Render clips in a <a class="link-btn" href="#/projects">project</a> and they'll show up here for review.`
          }</div>`
    }
    <div class="bulk-bar" data-bulk hidden>
      <span class="bulk-count" data-bulk-count></span>
      <button class="btn ghost" data-bulk-clear>Clear</button>
      ${"showDirectoryPicker" in window ? `<button class="btn" data-bulk-save>Save to folder…</button>` : ""}
      <button class="btn primary" data-bulk-download>${ICON.download} Download</button>
    </div>`;

  $("#review-filter").onclick = (e) => {
    const b = e.target.closest("[data-filter]");
    if (!b) return;
    state.reviewFilter = b.dataset.filter;
    renderReview();
  };

  const picked = () => state.library.filter((i) => selected.has(libraryKey(i)));
  const syncSelection = () => {
    $$("[data-item]", body).forEach((card) => {
      const on = selected.has(libraryKey(items[Number(card.dataset.item)]));
      card.classList.toggle("selected", on);
      $("[data-select]", card).setAttribute("aria-checked", String(on));
    });
    $(".review-grid", body)?.classList.toggle("selecting", selected.size > 0);
    const allOn = items.length > 0 && items.every((i) => selected.has(libraryKey(i)));
    const all = $("[data-select-all]", body);
    if (all) all.textContent = allOn ? "Clear selection" : `Select all${filter === "all" ? "" : " shown"}`;
    $("[data-bulk]", body).hidden = selected.size === 0;
    $("[data-bulk-count]", body).textContent = `${plural(selected.size, "clip")} selected`;
  };

  let anchor = null;
  $$("[data-item]", body).forEach((card) => {
    const index = Number(card.dataset.item);
    const item = items[index];
    $("[data-schedule]", card).onclick = () => openComposer({ item });
    $("[data-copy]", card).onclick = () => copy(captionFor(item));
    $("[data-preview]", card).onclick = () => openReviewPreview(item);
    $("video", card).ondblclick = () => openReviewPreview(item);
    $("[data-select]", card).onclick = (e) => {
      const on = !selected.has(libraryKey(item));
      // Shift-click applies the same choice to every clip between the last one clicked and this one.
      const [from, to] = e.shiftKey && anchor !== null ? [Math.min(anchor, index), Math.max(anchor, index)] : [index, index];
      for (let i = from; i <= to; i++) on ? selected.add(libraryKey(items[i])) : selected.delete(libraryKey(items[i]));
      anchor = index;
      syncSelection();
    };
  });

  $("[data-select-all]", body)?.addEventListener("click", () => {
    const allOn = items.every((i) => selected.has(libraryKey(i)));
    items.forEach((i) => (allOn ? selected.delete(libraryKey(i)) : selected.add(libraryKey(i))));
    syncSelection();
  });
  $("[data-bulk-clear]", body).onclick = () => {
    selected.clear();
    syncSelection();
  };
  $("[data-bulk-download]", body).onclick = () => downloadClips(picked());
  $("[data-bulk-save]", body)?.addEventListener("click", (e) => saveClipsToFolder(picked(), e.currentTarget));
  syncSelection();
}

const libraryKey = (item) => `${item.projectId}/${item.file}`;

/** File names from clip titles, unique within the batch: "Most Doctors Leave With A Plaque.mp4". */
function clipFileNames(list) {
  const seen = new Map();
  return list.map((item) => {
    const ext = item.file.match(/\.\w+$/)?.[0] || ".mp4";
    const base = String(item.title || "").replace(/[\\/:*?"<>|#%]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "clip";
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return `${n > 1 ? `${base} ${n}` : base}${ext}`;
  });
}

/** One browser download per clip, spaced out so the browser doesn't drop any. It may ask once to allow multiple downloads. */
async function downloadClips(list) {
  if (!list.length) return;
  const names = clipFileNames(list);
  toast(list.length === 1 ? "Downloading 1 clip" : `Downloading ${list.length} clips…`);
  for (const [n, item] of list.entries()) {
    const a = document.createElement("a");
    a.href = `/files/${item.projectId}/${item.file}`;
    a.download = names[n];
    document.body.append(a);
    a.click();
    a.remove();
    if (n < list.length - 1) await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

/** Writes the clips straight into a folder the user picks, without overwriting files already there. */
async function saveClipsToFolder(list, button) {
  if (!list.length) return;
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: "finished-clips", mode: "readwrite", startIn: "downloads" });
  } catch (err) {
    if (err.name !== "AbortError") toast(`Couldn't open that folder: ${err.message}`);
    return;
  }
  const names = clipFileNames(list);
  const label = button.textContent;
  button.disabled = true;
  let saved = 0;
  for (const [n, item] of list.entries()) {
    button.textContent = `Saving ${n + 1} of ${list.length}…`;
    try {
      const res = await fetch(`/files/${item.projectId}/${item.file}`);
      if (!res.ok) throw new Error(res.statusText);
      const handle = await dir.getFileHandle(await freeFileName(dir, names[n]), { create: true });
      await res.body.pipeTo(await handle.createWritable());
      saved++;
    } catch (err) {
      console.error(`Saving ${item.file} failed:`, err);
    }
  }
  button.disabled = false;
  button.textContent = label;
  toast(saved === list.length ? `Saved ${plural(saved, "clip")} to "${dir.name}"` : `Saved ${saved} of ${list.length} clips to "${dir.name}". Some couldn't be saved.`);
}

async function freeFileName(dir, name) {
  const dot = name.lastIndexOf(".");
  for (let k = 1; ; k++) {
    const candidate = k === 1 ? name : `${name.slice(0, dot)} (${k})${name.slice(dot)}`;
    try {
      await dir.getFileHandle(candidate);
    } catch {
      return candidate;
    }
  }
}

/** A finished clip in the small pop-up player, at the render's real shape (9:16, 4:5, 1:1 or 16:9) on black. */
function openReviewPreview(item) {
  const url = `/files/${item.projectId}/${item.file}`;
  const [w, h] = (item.file.match(/-(\d+)x(\d+)\.\w+$/)?.slice(1) || [9, 16]).map(Number);
  $$(".review-card video").forEach((v) => v.pause());
  const modal = openModal(
    `
    <div class="modal-head">
      <div><h2>${esc(item.title)}</h2><p class="muted">${esc(item.projectName)}${Number.isFinite(item.duration) ? ` · ${fmtLen(item.duration)}` : ""}</p></div>
      <button type="button" class="icon-btn" data-close title="Close">${ICON.close}</button>
    </div>
    <div class="quick-preview" style="aspect-ratio:${w} / ${h}">
      <video src="${url}?v=${encodeURIComponent(item.renderedAt || "")}" controls autoplay playsinline></video>
    </div>
    <div class="editor-actions">
      <span class="spacer"></span>
      <button type="button" class="btn" data-close>Close</button>
      <button type="button" class="btn primary" data-schedule>${ICON.calendar} Schedule</button>
    </div>`,
    { className: "preview-modal" },
  );
  // Renders named without a shape suffix fall back to 9:16 until the video reports its real size.
  const video = $("video", modal);
  video.addEventListener("loadedmetadata", () => {
    if (video.videoWidth) $(".quick-preview", modal).style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  });
  $("[data-schedule]", modal).onclick = () => {
    closeModal();
    openComposer({ item });
  };
}

function reviewCard(item, i, selected = false) {
  const url = `/files/${item.projectId}/${item.file}`;
  return `
    <article class="card review-card${selected ? " selected" : ""}" data-item="${i}">
      <button type="button" class="review-select" data-select role="checkbox" aria-checked="${selected}" aria-label="Select ${esc(item.title)}" title="Select (shift-click for a range)">${ICON.check}</button>
      <video src="${url}?v=${encodeURIComponent(item.renderedAt || "")}#t=0.6" controls controlslist="nofullscreen" disablepictureinpicture playsinline preload="metadata" title="Double-click to preview"></video>
      <div class="review-body">
        <div class="review-meta">${
          // Edits have no viral score and older ones may not know their length; show only what's real.
          Number.isFinite(item.score) ? `<span class="chip ${item.score >= 85 ? "live" : ""}">Score ${item.score}</span>` : item.kind === "edit" ? `<span class="chip">Edit</span>` : ""
        }${Number.isFinite(item.duration) ? `<span>${fmtLen(item.duration)}</span>` : ""}</div>
        <div class="review-title">${esc(item.title)}</div>
        <div class="review-project">${esc(item.projectName)}</div>
        ${item.scheduledCount ? `<div class="scheduled-note">${ICON.check} Scheduled ${item.scheduledCount === 1 ? "once" : `${item.scheduledCount} times`}</div>` : ""}
        <div class="review-actions">
          <button class="btn primary" data-schedule>${ICON.calendar} Schedule</button>
          <button class="icon-btn" data-preview title="Preview">${ICON.play}</button>
          <button class="icon-btn" data-copy title="Copy caption">${ICON.copy}</button>
          <a class="icon-btn" href="${url}" download title="Download">${ICON.download}</a>
        </div>
      </div>
    </article>`;
}

function renderCalendar() {
  const start = state.week;
  const end = addDays(start, 6);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const today = new Date();
  const account = (id) => state.accounts.find((a) => a.id === id);
  const inWeek = state.posts.filter((p) => {
    const d = new Date(p.scheduledAt);
    return d >= start && d < addDays(start, 7);
  });
  const due = state.posts.filter((p) => p.targets.some((t) => t.status === "due" || t.status === "failed"));
  const month = (d) => d.toLocaleDateString([], { month: "short" });
  const range =
    start.getMonth() === end.getMonth()
      ? `${month(start)} ${start.getDate()} – ${end.getDate()}, ${end.getFullYear()}`
      : `${month(start)} ${start.getDate()} – ${month(end)} ${end.getDate()}, ${end.getFullYear()}`;

  const body = $("#sched");
  body.innerHTML = `
    ${
      due.length
        ? `<div class="card due-panel">
            <div class="due-head"><h3>Due now</h3><span class="muted">Their time has come. Post each one, then mark it posted.</span></div>
            ${due
              .map(
                (p) => `
              <div class="due-row">
                <video src="/files/${p.projectId}/${p.file}#t=1" muted preload="metadata"></video>
                <div class="due-info">
                  <div class="review-title">${esc(p.title)}</div>
                  <div class="muted small">${whenLabel(new Date(p.scheduledAt))}</div>
                  <div class="due-targets">
                    ${p.targets
                      .filter((t) => t.status === "due" || t.status === "failed")
                      .map(
                        (t) => `<span class="due-target">${avatar(account(t.accountId), "sm")} ${esc(account(t.accountId)?.name || "")}
                          <button class="link-btn" data-mark="${p.id}:${t.accountId}">Mark posted</button></span>`,
                      )
                      .join("")}
                  </div>
                </div>
                <div class="due-actions">
                  <button class="icon-btn" data-copy-caption="${p.id}" title="Copy caption">${ICON.copy}</button>
                  <a class="icon-btn" href="/files/${p.projectId}/${p.file}" download title="Download">${ICON.download}</a>
                </div>
              </div>`,
              )
              .join("")}
          </div>`
        : ""
    }
    <div class="toolbar">
      <div class="week-nav">
        <button class="icon-btn" data-week="-1" title="Previous week">${ICON.left}</button>
        <button class="icon-btn" data-week="1" title="Next week">${ICON.right}</button>
        <h3>${range}</h3>
      </div>
      <div class="row">
        <span class="muted">${plural(inWeek.length, "post")} this week</span>
        <button class="btn" data-week="0">Today</button>
      </div>
    </div>
    <div class="week">
      ${days
        .map((d) => {
          const posts = inWeek.filter((p) => sameDay(new Date(p.scheduledAt), d));
          return `
            <div class="day ${sameDay(d, today) ? "today" : ""} ${d < startOfDay(today) ? "past" : ""}">
              <div class="day-head"><span>${d.toLocaleDateString([], { weekday: "short" })}</span><b>${d.getDate()}</b></div>
              ${posts
                .map(
                  (p) => `
                <button class="post-chip st-${p.status}" data-post="${p.id}" title="${STATUS_LABEL[p.status]}">
                  <span class="pc-top"><time>${timeLabel(new Date(p.scheduledAt))}</time><span class="avatars">${p.targets.map((t) => avatar(account(t.accountId), "sm")).join("")}</span></span>
                  <span class="pc-title">${esc(p.title)}</span>
                </button>`,
                )
                .join("")}
            </div>`;
        })
        .join("")}
    </div>
    ${state.posts.length ? "" : `<p class="muted note">Nothing scheduled yet. Pick a clip in <a class="link-btn" href="#/scheduler?tab=review">Review clips</a>.</p>`}`;

  $$("[data-week]", body).forEach(
    (b) =>
      (b.onclick = () => {
        const n = Number(b.dataset.week);
        state.week = n === 0 ? startOfWeek(new Date()) : addDays(state.week, 7 * n);
        renderCalendar();
      }),
  );
  $$("[data-post]", body).forEach((b) => {
    const post = state.posts.find((p) => p.id === b.dataset.post);
    b.onclick = () => openComposer({ item: post, post });
  });
  $$("[data-mark]", body).forEach(
    (b) =>
      (b.onclick = async () => {
        const [postId, accountId] = b.dataset.mark.split(":");
        try {
          await api(`/api/posts/${postId}/targets/${accountId}`, { method: "PATCH", body: { published: true } });
          toast("Marked as posted");
          refreshScheduler();
        } catch (err) {
          toast(err.message);
        }
      }),
  );
  $$("[data-copy-caption]", body).forEach((b) => (b.onclick = () => copy(state.posts.find((p) => p.id === b.dataset.copyCaption)?.caption || "")));
}

const IG_CONNECT_URL = "/api/integrations/instagram/connect";

/** Whether an Instagram account in the scheduler is linked to a connected Instagram login (so it auto-posts). */
function igConnected(account) {
  if (account.platform !== "instagram") return false;
  const handle = (account.handle || "").replace(/^@+/, "").toLowerCase();
  return state.igAccounts.some((c) => (account.igUserId && c.id === account.igUserId) || (handle && (c.username || "").toLowerCase() === handle));
}

function postingChip(account) {
  if (igConnected(account)) return `<span class="chip st-published">Auto-posting</span>`;
  if (account.platform === "instagram") return `<a class="chip chip-link" href="${IG_CONNECT_URL}">Connect to auto-post →</a>`;
  return `<span class="chip">Manual posting</span>`;
}

function renderAccounts() {
  const upcoming = (id) => state.posts.filter((p) => p.targets.some((t) => t.accountId === id && t.status !== "published")).length;
  const body = $("#sched");
  body.innerHTML = `
    <div class="toolbar">
      <span class="muted">${plural(state.accounts.length, "account")} · ${plural(state.igAccounts.length, "Instagram login")} connected</span>
      <a class="btn" href="${IG_CONNECT_URL}">${avatar({ platform: "instagram" }, "sm")} Connect Instagram</a>
    </div>
    <div class="accounts-grid">
      ${state.accounts
        .map(
          (a) => `
        <div class="card account-card">
          ${avatar(a, "lg")}
          <div class="acct-info">
            <div class="acct-name">${esc(a.name)}</div>
            <div class="muted small">${a.handle ? `@${esc(a.handle)} · ` : ""}${PLATFORMS[a.platform].label}</div>
            <div class="acct-meta">${postingChip(a)}<span class="muted small">${upcoming(a.id)} upcoming</span></div>
          </div>
          <button class="icon-btn" data-remove="${a.id}" title="Remove account">${ICON.trash}</button>
        </div>`,
        )
        .join("")}
      <form class="card account-form" id="add-account">
        <h3>Add an account</h3>
        <div class="platform-pick">
          ${Object.entries(PLATFORMS)
            .map(
              ([id, p], i) => `
            <label class="platform-opt"><input type="radio" name="platform" value="${id}" ${i === 0 ? "checked" : ""} /><span>${avatar({ platform: id }, "sm")}${p.label}</span></label>`,
            )
            .join("")}
        </div>
        <div class="row2">
          <label class="field"><span>Name</span><input name="name" required maxlength="60" placeholder="Main brand" /></label>
          <label class="field"><span>Handle <em>· optional</em></span><input name="handle" maxlength="60" placeholder="@handle" /></label>
        </div>
        <button class="btn primary">${ICON.plus} Add account</button>
      </form>
    </div>
    <p class="muted note">Instagram accounts linked to a connected login post automatically at their scheduled time (match the handle to your Instagram username). Every other account moves to <b>Due now</b> on the calendar with its video and caption ready, so you can post it and mark it done.</p>`;

  $("#add-account").onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    try {
      const account = await api("/api/accounts", { method: "POST", body: data });
      state.accounts.push(account);
      renderAccounts();
      toast(`Added ${account.name}`);
    } catch (err) {
      toast(err.message);
    }
  };
  $$("[data-remove]", body).forEach(
    (b) =>
      (b.onclick = async () => {
        const account = state.accounts.find((a) => a.id === b.dataset.remove);
        if (!confirm(`Remove ${account.name}? It will be taken off any posts that haven't gone out yet.`)) return;
        try {
          await api(`/api/accounts/${account.id}`, { method: "DELETE" });
          toast("Account removed");
          refreshScheduler();
        } catch (err) {
          toast(err.message);
        }
      }),
  );
}

// ---------- composer ----------
const QUICK_TIMES = [
  ["Next hour", () => {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return d;
  }],
  ["Tomorrow 9 AM", () => new Date(addDays(startOfDay(new Date()), 1).setHours(9))],
  ["Tomorrow 12 PM", () => new Date(addDays(startOfDay(new Date()), 1).setHours(12))],
  ["Tomorrow 6 PM", () => new Date(addDays(startOfDay(new Date()), 1).setHours(18))],
];

/** Schedule a clip (`item`), or edit an existing `post`. */
async function openComposer({ item, post = null }) {
  try {
    state.accounts = await api("/api/accounts");
  } catch (err) {
    return toast(err.message);
  }
  const accounts = state.accounts;
  const when = post ? new Date(post.scheduledAt) : QUICK_TIMES[0][1]();
  const selected = new Set(post ? post.targets.map((t) => t.accountId) : accounts.length === 1 ? [accounts[0].id] : []);
  const caption = post ? post.caption : captionFor(item);

  const modal = openModal(
    `
    <div class="composer">
      <div class="composer-video"><video src="/files/${item.projectId}/${item.file}" controls playsinline autoplay muted loop></video></div>
      <form class="composer-form" id="composer">
        <div class="modal-head">
          <div><h2>${post ? "Edit post" : "Schedule clip"}</h2><p class="muted">${esc(item.title)} · ${esc(item.projectName)}</p></div>
          <button type="button" class="icon-btn" data-close title="Close">${ICON.close}</button>
        </div>

        <div class="field">
          <span>Post to</span>
          ${
            accounts.length
              ? `<div class="account-pick">${accounts
                  .map((a) => `<button type="button" class="acct-toggle ${selected.has(a.id) ? "on" : ""}" data-acct="${a.id}">${avatar(a, "sm")}<span>${esc(a.name)}</span></button>`)
                  .join("")}</div>`
              : `<div class="empty small-empty">No accounts yet. <a class="link-btn" href="#/scheduler?tab=accounts">Add an account →</a></div>`
          }
        </div>

        <div class="row2">
          <label class="field"><span>Date</span><input type="date" name="date" value="${dateInput(when)}" required /></label>
          <label class="field"><span>Time</span><input type="time" name="time" value="${timeInput(when)}" required /></label>
        </div>
        <div class="quick">${QUICK_TIMES.map(([label], i) => `<button type="button" data-quick="${i}">${label}</button>`).join("")}</div>
        <p class="hint" data-past hidden>That time has already passed — the post will be due right away.</p>

        <label class="field">
          <span>Caption <em data-count></em></span>
          <textarea name="caption" rows="7">${esc(caption)}</textarea>
        </label>

        ${post ? `<div class="targets" data-targets></div>` : ""}

        <div class="modal-actions">
          ${post ? `<button type="button" class="btn danger" data-delete>${ICON.trash} Delete</button>` : ""}
          <span class="spacer"></span>
          <button type="button" class="btn ghost" data-close>Cancel</button>
          <button class="btn primary" data-submit>${post ? "Save changes" : "Schedule post"}</button>
        </div>
      </form>
    </div>`,
    { wide: true },
  );

  const form = $("#composer", modal);
  const textarea = $("textarea", form);
  const whenValue = () => new Date(`${form.date.value}T${form.time.value}`);
  const updateHints = () => {
    $("[data-count]", form).textContent = `· ${textarea.value.length} characters`;
    $("[data-past]", form).hidden = !(whenValue() < new Date());
  };
  const updateSubmit = () => {
    $("[data-submit]", form).disabled = !selected.size;
  };
  textarea.oninput = updateHints;
  form.date.oninput = form.time.oninput = updateHints;
  updateHints();
  updateSubmit();

  $$("[data-acct]", form).forEach(
    (b) =>
      (b.onclick = () => {
        const id = b.dataset.acct;
        selected.has(id) ? selected.delete(id) : selected.add(id);
        b.classList.toggle("on", selected.has(id));
        updateSubmit();
      }),
  );
  $$("[data-quick]", form).forEach(
    (b) =>
      (b.onclick = () => {
        const d = QUICK_TIMES[Number(b.dataset.quick)][1]();
        form.date.value = dateInput(d);
        form.time.value = timeInput(d);
        updateHints();
      }),
  );

  const renderTargets = (p) => {
    const box = $("[data-targets]", form);
    if (!box) return;
    box.innerHTML = p.targets
      .map((t) => {
        const a = accounts.find((x) => x.id === t.accountId);
        const posted = t.status === "published";
        return `<div class="target">${avatar(a, "sm")}<span class="grow">${esc(a?.name || "Removed account")}</span>
          <span class="chip st-${t.status}" title="${esc(t.error || "")}">${STATUS_LABEL[t.status]}</span>
          ${t.permalink ? `<a class="link-btn" href="${esc(t.permalink)}" target="_blank" rel="noopener">View</a>` : ""}
          ${t.status === "publishing" ? "" : `<button type="button" class="link-btn" data-published="${t.accountId}:${posted ? "0" : "1"}">${posted ? "Undo" : "Mark posted"}</button>`}</div>`;
      })
      .join("");
    $$("[data-published]", box).forEach(
      (b) =>
        (b.onclick = async () => {
          const [accountId, flag] = b.dataset.published.split(":");
          try {
            post = await api(`/api/posts/${post.id}/targets/${accountId}`, { method: "PATCH", body: { published: flag === "1" } });
            renderTargets(post);
            refreshScheduler();
          } catch (err) {
            toast(err.message);
          }
        }),
    );
  };
  if (post) renderTargets(post);

  $("[data-delete]", form)?.addEventListener("click", async () => {
    if (!confirm("Delete this scheduled post?")) return;
    try {
      await api(`/api/posts/${post.id}`, { method: "DELETE" });
      closeModal();
      toast("Post deleted");
      refreshScheduler();
    } catch (err) {
      toast(err.message);
    }
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = { accountIds: [...selected], scheduledAt: whenValue().toISOString(), caption: textarea.value };
    const submit = $("[data-submit]", form);
    submit.disabled = true;
    try {
      if (post) await api(`/api/posts/${post.id}`, { method: "PATCH", body });
      else await api("/api/posts", { method: "POST", body: { ...body, projectId: item.projectId, clipId: item.clipId } });
      closeModal();
      toast(post ? "Post updated" : `Scheduled to ${plural(selected.size, "account")}`);
      refreshScheduler();
    } catch (err) {
      toast(err.message);
      submit.disabled = false;
    }
  };
}

// ---------- study ----------
async function showStudy() {
  app.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Study</h1>
        <p class="muted">Show it videos you love and tell it why. Your clips, titles and edits lean toward that taste.</p>
      </div>
      <div class="profile-switch" id="profiles"></div>
    </div>
    <div id="study"><div class="loading">Loading…</div></div>`;
  try {
    [state.study, state.styles] = await Promise.all([api("/api/study"), api("/api/styles").catch(() => ({}))]);
  } catch (err) {
    $("#study").innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  renderStudy();

  // Link details and style analyses arrive in the background; swap in cards as they finish without touching other forms.
  const busy = (r) => r.status === "fetching" || r.style?.status === "analyzing";
  state.poll = setInterval(async () => {
    if (!state.study.references.some(busy)) return;
    const next = await api("/api/study").catch(() => null);
    if (!next) return;
    const before = new Map(state.study.references.map((r) => [r.id, r]));
    state.study = next;
    let learned = false;
    for (const ref of next.references) {
      const prev = before.get(ref.id);
      if (prev && busy(prev) && `${prev.status}|${prev.style?.status}` !== `${ref.status}|${ref.style?.status}`) {
        learned ||= ref.style?.status === "ready";
        replaceReferenceCard(ref);
      }
    }
    if (learned) state.styles = await api("/api/styles").catch(() => state.styles);
  }, 2000);
}

const activeProfile = () => state.study.profiles.find((p) => p.id === state.study.activeProfileId) || state.study.profiles[0];
const isMe = (profile) => profile.name.trim().toLowerCase() === "me";
const likesHeading = (profile) => (isMe(profile) ? "What you like" : `What ${esc(profile.name)} likes`);
const referencesHeading = (profile) => (isMe(profile) ? "Your references" : `${esc(profile.name)}'s references`);
const profileReferences = () => state.study.references.filter((r) => r.profileId === activeProfile().id);

function renderStudy() {
  const profile = activeProfile();
  const refs = profileReferences();

  $("#profiles").innerHTML = `
    <div class="segmented">
      ${state.study.profiles.map((p) => `<button data-profile="${p.id}" class="${p.id === profile.id ? "on" : ""}">${esc(p.name)}</button>`).join("")}
    </div>
    <button class="btn sm" data-new-profile>${ICON.plus} Add profile</button>`;

  $("#study").innerHTML = `
    <div class="study-top">
      <section class="card study-add">
        <h3>Study a video</h3>
        <p class="muted">Paste a YouTube, TikTok or Instagram link, or upload a clip you saved. Then tell it what you like.</p>
        <form id="study-link" class="study-link">
          <label class="link-field"><span class="link-icon">${ICON.link}</span><input name="url" type="url" autocomplete="off" placeholder="https://www.youtube.com/watch?v=…" /></label>
          <button class="btn primary">Study it</button>
        </form>
        <label class="upload-ref">
          <input id="study-file" type="file" accept="video/*,.mov,.mkv" hidden />
          ${ICON.upload}<span>Upload a clip instead</span>
        </label>
      </section>
      <section class="card taste-card" id="taste"></section>
    </div>
    <div class="section-head"><h2>${referencesHeading(profile)}</h2><span class="muted">${plural(refs.length, "video")}</span></div>
    <div class="ref-list" id="refs">
      ${refs.length ? refs.map(referenceCard).join("") : `<div class="empty">Nothing studied yet. Paste a link to a video you love.</div>`}
    </div>`;

  renderTaste();
  bindStudy();
}

function renderTaste() {
  const profile = activeProfile();
  const tally = new Map();
  for (const r of profileReferences()) for (const tag of r.likes) tally.set(tag, (tally.get(tag) || 0) + 1);
  const rows = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const max = rows[0]?.[1] || 1;
  $("#taste").innerHTML = `
    <div class="taste-head">
      <h3>${likesHeading(profile)}</h3>
      ${state.study.profiles.length > 1 ? `<button class="link-btn danger-link" data-delete-profile>Remove profile</button>` : ""}
    </div>
    ${
      rows.length
        ? `<ul class="taste-bars">${rows
            .map(([tag, n]) => `<li><span>${esc(tag)}</span><div class="taste-bar"><i style="width:${Math.round((100 * n) / max)}%"></i></div><b>${n}</b></li>`)
            .join("")}</ul>
           <p class="muted small">Used when picking clips, writing titles and hooks, and pacing edits.</p>`
        : `<p class="muted taste-empty">Tell it what you like about a few videos and ${isMe(profile) ? "your" : `${esc(profile.name)}'s`} taste shows up here.</p>`
    }`;
  $("[data-delete-profile]", $("#taste"))?.addEventListener("click", async () => {
    if (!confirm(`Remove the "${profile.name}" profile and its references?`)) return;
    try {
      state.study = await api(`/api/study/profiles/${profile.id}`, { method: "DELETE" });
      renderStudy();
      toast("Profile removed");
    } catch (err) {
      toast(err.message);
    }
  });
}

function referenceCard(r) {
  const info = r.info || {};
  const meta = [info.uploader, info.platform, info.duration ? fmtLen(info.duration) : ""].filter(Boolean).join(" · ");
  const media =
    r.kind === "file"
      ? `<video src="/study-media/${encodeURIComponent(r.file)}#t=1" controls playsinline preload="metadata"></video>`
      : info.thumbnail
        ? `<a href="${esc(r.url)}" target="_blank" rel="noopener"><img src="${esc(info.thumbnail)}" alt="" /></a>`
        : `<div class="ref-placeholder">${r.status === "fetching" ? "Fetching details…" : ICON.link}</div>`;
  return `
    <article class="card ref-card" data-ref="${r.id}">
      <div class="ref-media">${media}</div>
      <div class="ref-body">
        <div class="ref-top">
          <div class="ref-heading">
            <div class="ref-title">${esc(info.title || r.url)}</div>
            <div class="muted small">${r.status === "fetching" ? "Fetching details…" : esc(meta || (r.kind === "file" ? "Uploaded clip" : r.url))}</div>
          </div>
          ${r.url ? `<a class="icon-btn" href="${esc(r.url)}" target="_blank" rel="noopener" title="Open original">${ICON.link}</a>` : ""}
          <button class="icon-btn" data-remove-ref title="Remove">${ICON.trash}</button>
        </div>
        ${r.status === "error" ? `<p class="ref-error">Couldn't read that link: ${esc(r.error)}</p>` : ""}
        ${referenceStyle(r)}
        <div class="ref-question">What do you like about this?</div>
        <div class="like-chips">
          ${state.study.likeTags.map((tag) => `<button type="button" class="like-chip ${r.likes.includes(tag) ? "on" : ""}" data-like="${esc(tag)}">${esc(tag)}</button>`).join("")}
        </div>
        <textarea data-notes rows="3" placeholder="Anything specific? e.g. the hook in the first 2 seconds, cuts on every beat, big yellow captions">${esc(r.notes)}</textarea>
        <div class="ref-actions">
          <span class="muted small" data-saved>${r.updatedAt ? "Saved" : ""}</span>
          <button class="btn sm primary" data-save-ref>Save</button>
        </div>
      </div>
    </article>`;
}

/** What the style engine measured in a reference: pace, look, and which editing style it teaches. */
function referenceStyle(r) {
  if (r.kind === "link" && r.status !== "ready") return "";
  const s = r.style;
  const teaches = Object.values(state.styles || {}).filter((style) => style.refs?.includes(r.id)).map((style) => style.label);
  if (!s || (s.status !== "ready" && s.status !== "analyzing")) {
    return `
      <div class="ref-style">
        <div class="ref-style-row">
          <div><b>Style analysis</b><div class="muted small">${s?.status === "error" ? `<span class="ref-error-inline">Failed: ${esc(s.error)}</span>` : r.kind === "link" ? "Downloads the video to measure its cuts, pacing and color." : "Measures its cuts, pacing and color."}</div></div>
          <button type="button" class="btn sm" data-analyze>${s?.status === "error" ? "Try again" : "Analyze style"}</button>
        </div>
      </div>`;
  }
  if (s.status === "analyzing") {
    return `<div class="ref-style"><div class="ref-style-row"><div class="spinner sm"></div><span class="muted small">Measuring cuts, pacing and color…</span></div></div>`;
  }
  const m = s.metrics;
  return `
    <div class="ref-style">
      <div class="ref-style-row">
        <div class="trait-chips">${(s.traits || []).map((t) => `<span class="trait">${esc(t)}</span>`).join("")}</div>
        <a class="ref-sheet" href="/study-media/sheets/${r.id}.jpg" target="_blank" rel="noopener" title="Open contact sheet"><img src="/study-media/sheets/${r.id}.jpg" alt="" loading="lazy" /></a>
      </div>
      <div class="muted small">${m.cuts >= 3 ? `${m.avgShot}s average shot · ${m.cutsPerSec} cuts/sec` : "Few hard cuts — smooth transitions"} · brightness ${Math.round(m.luma)} · contrast ${Math.round(m.contrast)}</div>
      ${teaches.length ? `<div class="teaches small">Teaches <b>${teaches.map(esc).join(", ")}</b></div>` : ""}
    </div>`;
}

function bindReferenceCard(card) {
  const id = card.dataset.ref;
  const ref = () => state.study.references.find((r) => r.id === id);
  $("[data-analyze]", card)?.addEventListener("click", async () => {
    try {
      Object.assign(ref(), await api(`/api/study/references/${id}/analyze`, { method: "POST" }));
      replaceReferenceCard(ref());
    } catch (err) {
      toast(err.message);
    }
  });
  $$("[data-like]", card).forEach((chip) => (chip.onclick = () => chip.classList.toggle("on")));
  $("[data-save-ref]", card).onclick = async () => {
    const likes = $$("[data-like].on", card).map((chip) => chip.dataset.like);
    try {
      const updated = await api(`/api/study/references/${id}`, { method: "PATCH", body: { likes, notes: $("[data-notes]", card).value } });
      Object.assign(ref(), updated);
      $("[data-saved]", card).textContent = "Saved";
      renderTaste();
      toast(`Added to ${activeProfile().name}'s taste`);
    } catch (err) {
      toast(err.message);
    }
  };
  $("[data-remove-ref]", card).onclick = async () => {
    if (!confirm("Remove this reference?")) return;
    try {
      await api(`/api/study/references/${id}`, { method: "DELETE" });
      state.study.references = state.study.references.filter((r) => r.id !== id);
      renderStudy();
    } catch (err) {
      toast(err.message);
    }
  };
}

function replaceReferenceCard(ref) {
  const card = $(`[data-ref="${ref.id}"]`);
  if (!card) return;
  const likes = $$("[data-like].on", card).map((chip) => chip.dataset.like);
  const notes = $("[data-notes]", card).value;
  card.outerHTML = referenceCard({ ...ref, likes: likes.length ? likes : ref.likes, notes: notes || ref.notes });
  bindReferenceCard($(`[data-ref="${ref.id}"]`));
  announceReferenceCard(ref.id);
}

/** Lets add-ons (e.g. music/) decorate reference cards whenever one is (re)rendered. */
function announceReferenceCard(refId) {
  document.dispatchEvent(new CustomEvent("study:card", { detail: { refId } }));
}

function bindStudy() {
  $("#profiles").onclick = async (e) => {
    const pick = e.target.closest("[data-profile]");
    if (pick && pick.dataset.profile !== state.study.activeProfileId) {
      state.study = await api("/api/study/active", { method: "POST", body: { profileId: pick.dataset.profile } });
      return renderStudy();
    }
    if (e.target.closest("[data-new-profile]")) {
      const name = prompt("Profile name — you, a friend, a client…");
      if (!name?.trim()) return;
      try {
        await api("/api/study/profiles", { method: "POST", body: { name } });
        state.study = await api("/api/study");
        renderStudy();
        toast(`Studying for ${name.trim()} now`);
      } catch (err) {
        toast(err.message);
      }
    }
  };

  $("#study-link").onsubmit = async (e) => {
    e.preventDefault();
    const input = e.target.url;
    const button = $("button", e.target);
    button.disabled = true;
    try {
      await api("/api/study/references", { method: "POST", body: { url: input.value.trim(), profileId: activeProfile().id } });
      state.study = await api("/api/study");
      renderStudy();
      toast("Got it — now tell it what you like");
    } catch (err) {
      toast(err.message);
      button.disabled = false;
    }
  };

  $("#study-file").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const data = new FormData();
    data.append("video", file);
    data.append("profileId", activeProfile().id);
    toast("Uploading…");
    try {
      const res = await fetch("/api/study/references/upload", { method: "POST", body: data });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Upload failed");
      state.study = await api("/api/study");
      renderStudy();
      toast("Uploaded — now tell it what you like");
    } catch (err) {
      toast(err.message);
    }
  };

  $$("[data-ref]").forEach((card) => {
    bindReferenceCard(card);
    announceReferenceCard(card.dataset.ref);
  });
}

const EDIT_ACCENTS = ["FFE600", "FF2E63", "00E5FF", "7CFF4F", "FF7A00", "B388FF", "FFFFFF"];

/** Preview & tweak for director-planned edits: change the finish, re-roll the shots, render. */
function openDopeEditor(editId) {
  const pid = state.project.id;
  const current = () => state.project.edits.find((e) => e.id === editId);
  const e0 = current();
  const looks = state.config.dope?.looks || {};
  const textStyles = state.config.dope?.textStyles || {};
  const aspect = state.config.aspects[e0.design.aspect] || state.config.aspects["9:16"];
  const draft = {
    look: e0.finish?.look || "auto",
    lookIntensity: e0.finish?.lookIntensity ?? e0.resolved?.lookIntensity ?? 0.8,
    textStyle: e0.finish?.textStyle || "auto",
    accent: String(e0.finish?.accent || e0.resolved?.accent || "FFE600").replace("#", ""),
    title: e0.finish?.title ?? e0.resolved?.title ?? "",
    captions: Boolean(e0.finish?.captions),
    sfx: e0.finish?.sfx || "full",
  };

  const modal = openModal(
    `
    <div class="editor">
      <div class="editor-stage">
        <div class="stage-frame" data-frame data-orient="${aspect.width > aspect.height ? "wide" : "tall"}" style="aspect-ratio:${aspect.width} / ${aspect.height}">
          <hyperframes-player data-player controls loop autoplay width="${aspect.width}" height="${aspect.height}"></hyperframes-player>
          <div class="stage-updating" data-updating hidden><div class="spinner"></div><span>The director is updating your edit…</span></div>
        </div>
        <p class="stage-note">Live preview · ${plural(e0.shotCount, "shot")} · planned by the director, rendered with HyperFrames</p>
      </div>
      <div class="editor-panel">
        <div class="modal-head">
          <div><h2>${esc(editLabel(e0))}</h2><p class="muted">${esc(e0.concept || e0.message)}</p></div>
          <button type="button" class="icon-btn" data-close title="Close">${ICON.close}</button>
        </div>
        ${e0.notice ? `<div class="banner warn edit-banner">${esc(e0.notice)}</div>` : ""}
        <section class="ed-section">
          <h4>Look</h4>
          <label class="field"><span>Color grade</span>
            <select data-select="look"><option value="auto">Auto — the director picks</option>${Object.entries(looks).map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join("")}</select>
          </label>
          <label class="range-field"><span>Strength<b data-out="lookIntensity"></b></span><input type="range" data-num="lookIntensity" min="0" max="1.2" step="0.05" /></label>
        </section>
        <section class="ed-section">
          <h4>Text</h4>
          <label class="field"><span>Title on screen</span><input data-text="title" maxlength="80" placeholder="Leave empty for no title" /></label>
          <label class="field"><span>Text style</span>
            <select data-select="textStyle"><option value="auto">Auto</option>${Object.entries(textStyles).map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join("")}</select>
          </label>
          <div class="field"><span>Accent color</span>
            <div class="swatches">${EDIT_ACCENTS.map((c) => `<button type="button" class="swatch accent-swatch" data-accent="${c}" title="#${c}"><i style="background:#${c}"></i></button>`).join("")}</div>
          </div>
          <label class="toggle"><input type="checkbox" data-bool="captions" /><span class="track"></span>Captions on spoken lines</label>
        </section>
        <section class="ed-section">
          <h4>Sound</h4>
          <div class="field"><span>Sound effects</span>
            <div class="segmented seg-fill" data-seg="sfx">${[["full", "Full"], ["subtle", "Subtle"], ["off", "Off"]].map(([v, l]) => `<button type="button" data-v="${v}">${l}</button>`).join("")}</div>
          </div>
        </section>
        <div class="editor-actions">
          <button type="button" class="btn ghost" data-reroll title="A new direction with different shots">Re-roll shots</button>
          <span class="spacer"></span>
          <button type="button" class="btn" data-apply>Apply changes</button>
          <button type="button" class="btn primary" data-render-now>Render</button>
        </div>
      </div>
    </div>`,
    { wide: true, className: "editor-modal" },
  );

  const player = $("[data-player]", modal);
  const updating = $("[data-updating]", modal);
  let shownVersion = e0.planVersion;
  let waiter = null;

  const load = () => player.setAttribute("src", `/api/projects/${pid}/edits/${editId}/preview?v=${shownVersion}&t=${Date.now()}`);
  const sync = () => {
    $$("[data-select]", modal).forEach((i) => (i.value = draft[i.dataset.select]));
    $$("[data-seg] button", modal).forEach((b) => b.classList.toggle("on", draft[b.closest("[data-seg]").dataset.seg] === b.dataset.v));
    $$("[data-accent]", modal).forEach((b) => b.classList.toggle("on", b.dataset.accent === draft.accent));
    $$("[data-bool]", modal).forEach((i) => (i.checked = Boolean(draft[i.dataset.bool])));
    $$("[data-text]", modal).forEach((i) => document.activeElement !== i && (i.value = draft[i.dataset.text] || ""));
    const range = $('[data-num="lookIntensity"]', modal);
    range.value = draft.lookIntensity;
    $('[data-out="lookIntensity"]', modal).textContent = `${Math.round(draft.lookIntensity * 100)}%`;
  };

  // After a replan, wait for the new plan version's preview before reloading the player.
  const waitForNewVersion = () => {
    clearInterval(waiter);
    updating.hidden = false;
    waiter = setInterval(() => {
      if (!document.body.contains(modal)) return clearInterval(waiter);
      const e = current();
      if (!e) return clearInterval(waiter);
      if (e.status === "error" || (e.status === "ready" && e.updateError)) {
        // A failed update keeps the last good plan, so the current preview stays.
        clearInterval(waiter);
        updating.hidden = true;
        toast(e.updateError || e.error || "The update failed");
      } else if (e.planVersion > shownVersion && e.status === "ready" && e.preview?.status === "ready") {
        clearInterval(waiter);
        shownVersion = e.planVersion;
        updating.hidden = true;
        load();
        toast("Updated");
      }
    }, 1000);
  };

  modal.addEventListener("click", (event) => {
    const seg = event.target.closest("[data-seg] button");
    if (seg) {
      draft[seg.closest("[data-seg]").dataset.seg] = seg.dataset.v;
      sync();
    }
    const swatch = event.target.closest("[data-accent]");
    if (swatch) {
      draft.accent = swatch.dataset.accent;
      sync();
    }
  });
  $$("[data-select]", modal).forEach((i) => (i.onchange = () => (draft[i.dataset.select] = i.value)));
  $$("[data-bool]", modal).forEach((i) => (i.onchange = () => (draft[i.dataset.bool] = i.checked)));
  $$("[data-text]", modal).forEach((i) => (i.oninput = () => (draft[i.dataset.text] = i.value)));
  $('[data-num="lookIntensity"]', modal).oninput = (event) => {
    draft.lookIntensity = Number(event.target.value);
    sync();
  };

  $("[data-apply]", modal).onclick = async () => {
    try {
      Object.assign(current(), await api(`/api/projects/${pid}/edits/${editId}`, { method: "PATCH", body: { finish: draft } }));
      waitForNewVersion();
    } catch (err) {
      toast(err.message);
    }
  };
  $("[data-reroll]", modal).onclick = async () => {
    try {
      Object.assign(current(), await api(`/api/projects/${pid}/edits/${editId}/reroll`, { method: "POST" }));
      waitForNewVersion();
    } catch (err) {
      toast(err.message);
    }
  };
  $("[data-render-now]", modal).onclick = async () => {
    if (!updating.hidden) return toast("Wait for the update to finish first");
    try {
      Object.assign(current(), await api(`/api/projects/${pid}/edits/${editId}/render`, { method: "POST", body: {} }));
      renderEditList();
      closeModal();
      toast("Rendering your edit");
    } catch (err) {
      toast(err.message);
    }
  };

  sync();
  load();
}

// ---------- sounds ----------
async function showSounds() {
  app.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Sounds</h1>
        <p class="muted">Music for your dope edits. Every track gets its tempo and beats mapped, so cuts land on the beat.</p>
      </div>
    </div>
    <div class="study-top">
      <section class="card study-add">
        <h3>Add music</h3>
        <p class="muted">Drop in tracks, paste a link to a song, or import a whole folder from your Mac.</p>
        <label class="dropzone sound-drop" id="sound-drop">
          <input id="sound-files" type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg" multiple hidden />
          <div class="dz-icon">${ICON.upload}</div>
          <div class="dz-title">Drop audio files</div>
          <div class="dz-sub">MP3, WAV, M4A, AAC, FLAC</div>
        </label>
        <form id="folder-form" class="study-link">
          <label class="link-field"><span class="link-icon">${ICON.link}</span><input name="path" autocomplete="off" placeholder="Paste a song link, or a folder like ~/Music/Reels" /></label>
          <button class="btn" data-slot="add-label">Add</button>
        </form>
      </section>
      <section class="card taste-card" id="sound-stats"></section>
    </div>
    <div class="section-head"><h2>Your tracks</h2><span class="muted" id="track-count"></span></div>
    <div class="track-list" id="tracks"><div class="loading">Loading…</div></div>
    <section id="music-channel" class="music-channel"></section>`;
  // Optional add-on panel (music/); nothing happens if it isn't installed.
  window.musicChannel?.mount?.($("#music-channel"));

  const upload = async (files) => {
    if (!files.length) return;
    const data = new FormData();
    for (const f of files) data.append("tracks", f);
    toast(`Uploading ${plural(files.length, "track")}…`);
    try {
      const res = await fetch("/api/sounds/upload", { method: "POST", body: data });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Upload failed");
      await loadTracks();
      toast("Added — mapping the beats");
    } catch (err) {
      toast(err.message);
    }
  };
  const drop = $("#sound-drop");
  $("#sound-files").onchange = (e) => upload([...e.target.files]);
  drop.ondragover = (e) => {
    e.preventDefault();
    drop.classList.add("over");
  };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    upload([...e.dataTransfer.files]);
  };
  $("#folder-form").onsubmit = async (e) => {
    e.preventDefault();
    const button = $("button", e.target);
    const value = e.target.path.value.trim();
    button.disabled = true;
    try {
      // A link downloads that song's audio; anything else is a folder on this Mac.
      if (/^https?:\/\//i.test(value)) {
        button.textContent = "Downloading…";
        const track = await api("/api/sounds/import-link", { method: "POST", body: { url: value } });
        e.target.path.value = "";
        await loadTracks();
        toast(`Added ${track.name} — mapping the beats`);
        return;
      }
      const { added } = await api("/api/sounds/import-folder", { method: "POST", body: { path: value } });
      await loadTracks();
      toast(added ? `Imported ${plural(added, "track")}` : "No new audio files in that folder");
    } catch (err) {
      toast(err.message);
    } finally {
      button.disabled = false;
      button.textContent = "Add";
    }
  };

  await loadTracks();
  state.poll = setInterval(async () => {
    if (state.tracks.some((t) => t.status === "analyzing")) await loadTracks();
  }, 2500);
}

async function loadTracks() {
  state.tracks = await api("/api/sounds").catch(() => []);
  renderTracks();
}

function renderTracks() {
  const tracks = state.tracks;
  const box = $("#tracks");
  if (!box) return;
  $("#track-count").textContent = plural(tracks.length, "track");
  const bpms = tracks.map((t) => t.bpm).filter(Boolean);
  const total = tracks.reduce((n, t) => n + (t.duration || 0), 0);
  $("#sound-stats").innerHTML = `
    <div class="taste-head"><h3>Your library</h3></div>
    <div class="sound-stats">
      <div><b>${tracks.length}</b><span>tracks</span></div>
      <div><b>${total ? fmtLen(total) : "—"}</b><span>of music</span></div>
      <div><b>${bpms.length ? `${Math.min(...bpms)}–${Math.max(...bpms)}` : "—"}</b><span>BPM range</span></div>
    </div>
    <p class="muted small">Pick a track when you make a dope edit and every cut lands on its beat.</p>`;

  // Keep a playing track playing: only rebuild rows whose data changed.
  if (!tracks.length) {
    box.innerHTML = `<div class="empty">No music yet. Drop in a few tracks you'd put under a reel.</div>`;
    return;
  }
  const existing = new Map($$("[data-track]", box).map((row) => [row.dataset.track, row]));
  const rows = tracks.map((t) => {
    const sig = `${t.status}|${t.bpm}|${t.name}`;
    const row = existing.get(t.id);
    if (row && row.dataset.sig === sig) return row;
    const el = document.createElement("div");
    el.className = "card track-row";
    el.dataset.track = t.id;
    el.dataset.sig = sig;
    el.innerHTML = `
      <audio src="/sounds-media/${encodeURIComponent(t.file)}" controls preload="none"></audio>
      <input class="track-name" value="${esc(t.name)}" maxlength="120" title="Rename" />
      <span class="chip ${t.status === "analyzing" ? "live" : ""}">${t.status === "analyzing" ? "Mapping beats" : t.bpm ? `${t.bpm} BPM` : "No beat grid"}</span>
      <span class="muted small">${t.duration ? fmtLen(t.duration) : ""}</span>
      <button class="icon-btn" data-remove-track title="Remove">${ICON.trash}</button>`;
    $(".track-name", el).onchange = async (e) => {
      try {
        await api(`/api/sounds/${t.id}`, { method: "PATCH", body: { name: e.target.value } });
        toast("Renamed");
      } catch (err) {
        toast(err.message);
      }
    };
    $("[data-remove-track]", el).onclick = async () => {
      if (!confirm(`Remove "${t.name}" from your library?`)) return;
      await api(`/api/sounds/${t.id}`, { method: "DELETE" }).catch((err) => toast(err.message));
      await loadTracks();
    };
    return el;
  });
  box.replaceChildren(...rows);
}

// ---------- nav badge ----------
async function refreshBadge() {
  const s = await api("/api/schedule/summary").catch(() => null);
  const badge = $("#due-badge");
  if (!s || !badge) return;
  badge.hidden = !s.due;
  badge.textContent = s.due;
}

// ---------- boot ----------
state.config = await api("/api/config");
const engine = $("#engine");
engine.textContent = state.config.claude ? "Claude connected" : "Demo mode · no Claude key";
engine.classList.toggle("on", state.config.claude);
refreshBadge();
setInterval(refreshBadge, 15000);
// A sound saved from a studied video (music/) just landed in the library.
window.addEventListener("music:saved", () => {
  if (location.hash.startsWith("#/sounds")) loadTracks();
});
route();
