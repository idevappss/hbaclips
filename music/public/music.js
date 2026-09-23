// Music Channel drop-in for HBA Content Backend. Adds "Save this sound?" to every studied video on the Study tab,
// and exposes window.musicChannel.mount(el) for the "From your studies" section of the Sounds page.
// Owned by the MUSIC session.
const API = new URL("..", import.meta.url).pathname.replace(/\/$/, ""); // this file is served from <API>/ui/

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtLen = (sec) => (Number.isFinite(sec) && sec > 0 ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}` : "");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const svg = (body, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  note: svg(`<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>`),
  play: `<svg width="12" height="12" viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>`,
  pause: `<svg width="12" height="12" viewBox="0 0 24 24"><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/></svg>`,
  link: svg(`<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>`, 15),
};

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

function toast(msg) {
  let el = document.getElementById("toast");
  if (!el) {
    el = Object.assign(document.createElement("div"), { id: "toast", className: "toast" });
    document.body.append(el);
  }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2600);
}

/** The channel is a section of the Sounds page once ENGINE mounts it; until then, its own page. */
const channelHref = () => ($('[data-nav="sounds"]') ? "#/sounds" : `${API}/channel`);

/** Tell the Sounds page a track was added so its list can refresh. */
const announceSaved = (sound) => window.dispatchEvent(new CustomEvent("music:saved", { detail: { trackId: sound.id, name: sound.name } }));

async function decide(refId, action) {
  return api(`${API}/references/${encodeURIComponent(refId)}/${action}`, { method: "POST" });
}

// ---------- one shared player ----------
const player = new Audio();
player.preload = "none";
let playingId = null;

function togglePlay(id, src) {
  if (playingId === id && !player.paused) {
    player.pause();
    return;
  }
  if (playingId !== id) {
    player.src = src;
    playingId = id;
  }
  player.play().catch(() => toast("Couldn't play that sound"));
}

function syncPlayers() {
  for (const button of $$("[data-play]")) {
    const on = button.dataset.play === playingId && !player.paused;
    button.innerHTML = on ? ICON.pause : ICON.play;
    button.classList.toggle("on", on);
    button.title = on ? "Pause" : "Play";
  }
}
for (const event of ["play", "pause", "ended", "emptied"]) player.addEventListener(event, syncPlayers);
player.addEventListener("timeupdate", () => {
  const bar = playingId && $(`[data-progress="${CSS.escape(playingId)}"]`);
  if (bar && player.duration) bar.style.width = `${(100 * player.currentTime) / player.duration}%`;
});

// ---------- Study tab: "Save this sound?" on every studied video ----------
const study = { states: {}, fetchedAt: 0, loading: null, timer: null };

function refreshStates() {
  study.loading ??= api(`${API}/references`)
    .then((states) => {
      study.states = states;
      study.fetchedAt = Date.now();
    })
    .finally(() => (study.loading = null));
  return study.loading;
}

function barHtml(s) {
  switch (s.status) {
    case "ask":
      return `
        <span class="music-ask-icon">${ICON.note}</span>
        <div class="music-ask-text"><b>Save this sound?</b><span>Keep it in your Music Channel to reuse on another clip.</span></div>
        <div class="music-ask-actions">
          <button type="button" class="btn sm ghost" data-music="skip">No thanks</button>
          <button type="button" class="btn sm primary" data-music="save">Save sound</button>
        </div>`;
    case "saving":
      return `
        <span class="music-spin"></span>
        <div class="music-ask-text"><b>Saving the sound…</b><span>Pulling the audio out of this video.</span></div>`;
    case "saved":
      return `
        <button type="button" class="music-play" data-play="${esc(s.sound.id)}" data-src="${API}/sounds/${encodeURIComponent(s.sound.id)}/audio" title="Play">${ICON.play}</button>
        <div class="music-ask-text"><b>${esc(s.sound.name)}</b><span>Saved to your Music Channel</span></div>
        <div class="music-ask-actions"><a class="btn sm ghost" href="${channelHref()}">Open channel</a></div>`;
    case "error":
      return `
        <span class="music-ask-icon">${ICON.note}</span>
        <div class="music-ask-text"><b>Couldn't save the sound</b><span>${esc(s.error || "Something went wrong.")}</span></div>
        <div class="music-ask-actions">
          <button type="button" class="btn sm ghost" data-music="skip">Dismiss</button>
          <button type="button" class="btn sm" data-music="save">Try again</button>
        </div>`;
    case "skipped":
      return `<button type="button" class="music-later" data-music="save">${ICON.note} Save this sound</button>`;
    default:
      return ""; // waiting for link details, or a link that couldn't be read
  }
}

function paintCard(card) {
  const id = card.dataset.ref;
  const state = study.states[id] || { status: "waiting" };
  const key = [state.status, state.sound?.id, state.sound?.name, state.error].join("|");
  let bar = $(".music-ask", card);
  if (bar?.dataset.key === key) return;
  const html = barHtml(state);
  if (!html) return bar?.remove();
  if (!bar) {
    const anchor = $(".ref-error", card) || $(".ref-top", card);
    bar = document.createElement("div");
    if (anchor) anchor.after(bar);
    else ($(".ref-body", card) || card).prepend(bar);
    bar.addEventListener("click", (e) => onBarClick(e, id));
  }
  bar.className = `music-ask is-${state.status}`;
  bar.dataset.key = key;
  bar.innerHTML = html;
  syncPlayers();
}

const paintAll = () => $$("#refs [data-ref]").forEach(paintCard);

async function onBarClick(e, id) {
  const play = e.target.closest("[data-play]");
  if (play) return togglePlay(play.dataset.play, play.dataset.src);
  const button = e.target.closest("[data-music]");
  if (!button) return;
  button.disabled = true;
  try {
    study.states[id] = await decide(id, button.dataset.music);
  } catch (err) {
    toast(err.message);
    await refreshStates().catch(() => {});
  }
  paintAll();
  schedulePoll();
}

/** Poll while a sound is saving or a link's details are still loading. */
function schedulePoll() {
  clearTimeout(study.timer);
  const busy = $$("#refs [data-ref]").some((card) => ["saving", "waiting"].includes(study.states[card.dataset.ref]?.status || "waiting"));
  if (!busy) return;
  study.timer = setTimeout(async () => {
    const before = study.states;
    await refreshStates().catch(() => {});
    for (const [id, s] of Object.entries(study.states)) {
      if (before[id]?.status !== "saving" || s.status === "saving") continue;
      if (s.status === "saved") {
        toast(`Saved "${s.sound.name}" to your Music Channel`);
        announceSaved(s.sound);
      } else if (s.status === "error") toast("Couldn't save that sound");
    }
    paintAll();
    schedulePoll();
  }, 2000);
}

async function scan() {
  const cards = $$("#refs [data-ref]");
  if (!cards.length) return;
  const stale = cards.some((card) => ["waiting", undefined].includes(study.states[card.dataset.ref]?.status));
  if (stale && Date.now() - study.fetchedAt > 1500) await refreshStates().catch(() => {});
  paintAll();
  schedulePoll();
}

let scanQueued = false;
function queueScan() {
  if (scanQueued) return;
  scanQueued = true;
  setTimeout(() => {
    scanQueued = false;
    scan();
  }, 30);
}

// The Study tab re-renders its cards freely; watch for them instead of hooking into its code.
new MutationObserver((records) => {
  if (records.some((r) => [...r.addedNodes].some((n) => n.nodeType === 1 && !n.closest(".music-ask, [data-music-channel]")))) queueScan();
}).observe(document.body, { childList: true, subtree: true });
queueScan();

// ---------- Music Channel: "From your studies" ----------
const cover = (thumbnail) =>
  `<div class="music-cover">${thumbnail ? `<img src="${esc(thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ""}<span class="music-cover-icon">${ICON.note}</span></div>`;

function pendingRow(r) {
  const meta = [r.uploader, r.platform, r.profile && r.profile.toLowerCase() !== "me" ? `for ${r.profile}` : ""].filter(Boolean).join(" · ");
  const actions =
    r.status === "saving"
      ? `<span class="music-spin"></span>`
      : `<button type="button" class="btn sm ghost" data-music="skip">${r.status === "error" ? "Dismiss" : "No thanks"}</button>
         <button type="button" class="btn sm ${r.status === "error" ? "" : "primary"}" data-music="save">${r.status === "error" ? "Try again" : "Save sound"}</button>`;
  return `
    <article class="card music-row" data-pending="${esc(r.refId)}">
      ${cover(r.thumbnail)}
      <div class="music-row-main">
        <div class="music-title">${esc(r.title)}</div>
        <div class="music-meta ${r.status === "error" ? "is-error" : ""}">${esc(r.status === "error" ? r.error : r.status === "saving" ? "Saving the sound…" : meta || (r.kind === "file" ? "Uploaded clip" : ""))}</div>
      </div>
      <div class="music-facts">${esc(fmtLen(r.duration))}</div>
      <div class="music-row-actions">${actions}</div>
    </article>`;
}

function savedRow(s) {
  const st = s.study;
  // Sounds named after their video (no song metadata) would repeat the title here.
  const sameTitle = st.title && st.title.trim().toLowerCase() === s.name.trim().toLowerCase();
  const from = [st.title && !sameTitle && `From “${st.title}”`, st.uploader, st.platform].filter(Boolean).join(" · ");
  const facts = [fmtLen(s.duration), s.bpm ? `${s.bpm} BPM` : "", s.status === "analyzing" ? "Finding the beat…" : ""].filter(Boolean).join(" · ");
  return `
    <article class="card music-row" data-saved="${esc(s.id)}">
      <div class="music-cover">
        ${st.thumbnail ? `<img src="${esc(st.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ""}
        <button type="button" class="music-play" data-play="${esc(s.id)}" data-src="${esc(s.audioUrl)}" title="Play">${ICON.play}</button>
      </div>
      <div class="music-row-main">
        <div class="music-title">${esc(s.name)}</div>
        <div class="music-meta">${esc(from)}</div>
        <div class="music-progress"><i data-progress="${esc(s.id)}"></i></div>
      </div>
      <div class="music-facts">${esc(facts)}</div>
      <div class="music-row-actions">
        ${st.url ? `<a class="icon-btn" href="${esc(st.url)}" target="_blank" rel="noopener" title="Open the video it came from">${ICON.link}</a>` : ""}
      </div>
    </article>`;
}

/**
 * Render the channel into `el`. Inside the Sounds page it's a section (rename/delete stay in the Sounds list);
 * `standalone` adds a page heading for /api/music/channel.
 */
function mount(el, { standalone = false } = {}) {
  el.dataset.musicChannel = "";
  el.innerHTML = standalone
    ? `<div class="page-head"><div><h1>Music Channel</h1><p class="muted">Sounds from the videos you study, saved to reuse on your next clip.</p></div><span class="muted" data-count></span></div><div data-body><div class="loading">Loading…</div></div>`
    : `<div class="section-head"><h2>Music Channel</h2><span class="muted small" data-count></span></div><div data-body><div class="loading">Loading…</div></div>`;
  const body = $("[data-body]", el);
  let data = null;
  let timer;

  const render = () => {
    const { pending, saved } = data;
    $("[data-count]", el).textContent = [saved.length && plural(saved.length, "saved sound"), pending.length && `${pending.length} to review`].filter(Boolean).join(" · ");
    body.innerHTML = `
      ${pending.length ? `<div class="music-sub">Sounds from studied videos you haven't saved yet</div><div class="music-list">${pending.map(pendingRow).join("")}</div>` : ""}
      ${saved.length ? `<div class="music-sub">Saved from your studies</div><div class="music-list">${saved.map(savedRow).join("")}</div>` : ""}
      ${pending.length || saved.length ? "" : `<div class="empty">Nothing saved yet. When you study a video, hit <b>Save sound</b> and it shows up here, ready for your next clip. <a class="link-btn" href="/#/study">Go to Study</a></div>`}`;
    syncPlayers();
  };

  const refresh = async () => {
    clearTimeout(timer);
    if (!body.isConnected) return; // navigated away
    let next;
    try {
      next = await api(API);
    } catch (err) {
      body.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      return;
    }
    if (data) {
      const wasSaving = new Set(data.pending.filter((p) => p.status === "saving").map((p) => p.refId));
      for (const [refId, s] of Object.entries(next.references)) if (wasSaving.has(refId) && s.status === "saved") announceSaved(s.sound);
    }
    if (JSON.stringify(next) !== JSON.stringify(data)) {
      data = next;
      render();
    }
    if (data.pending.some((p) => p.status === "saving") || data.saved.some((s) => s.status === "analyzing")) timer = setTimeout(refresh, 2000);
  };

  body.addEventListener("click", async (e) => {
    const play = e.target.closest("[data-play]");
    if (play) return togglePlay(play.dataset.play, play.dataset.src);
    const button = e.target.closest("[data-music]");
    const row = e.target.closest("[data-pending]");
    if (!button || !row) return;
    button.disabled = true;
    try {
      await decide(row.dataset.pending, button.dataset.music);
    } catch (err) {
      toast(err.message);
    }
    refresh();
  });

  refresh();
}

window.musicChannel = { mount };

// ---------- styles (built on HBA Content Backend's tokens) ----------
const style = document.createElement("style");
style.textContent = `
.music-ask { display: flex; align-items: center; gap: 12px; padding: 8px 8px 8px 10px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface-2); box-shadow: var(--highlight); transition: border-color var(--fast) var(--ease), background var(--fast) var(--ease); }
.music-ask.is-ask { border-color: var(--line-2); animation: music-in var(--slow) var(--ease); }
.music-ask.is-error { border-color: color-mix(in srgb, var(--danger) 30%, transparent); background: color-mix(in srgb, var(--danger) 6%, transparent); }
.music-ask.is-skipped { padding: 0; border: 0; background: none; box-shadow: none; }
.music-ask-icon { display: grid; place-items: center; width: 32px; height: 32px; flex: none; border-radius: var(--pill); background: var(--surface-3); color: var(--text); }
.music-ask-icon svg { width: 15px; height: 15px; }
.is-error .music-ask-icon { background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--danger); }
.music-ask-text { display: flex; flex-direction: column; flex: 1; min-width: 0; line-height: 1.35; }
.music-ask-text b { font-size: 13.5px; font-weight: 600; letter-spacing: -0.005em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.music-ask-text span { font-size: 12.5px; color: var(--faint); }
.music-ask-actions { display: flex; gap: 6px; flex: none; }
.music-later { display: inline-flex; align-items: center; gap: 7px; padding: 0; border: 0; background: none; color: var(--faint); font-size: 13px; font-weight: 500; cursor: pointer; transition: color var(--fast) var(--ease); }
.music-later:hover { color: var(--text); }
.music-later svg { width: 14px; height: 14px; }
.music-play { position: relative; display: grid; place-items: center; width: 32px; height: 32px; flex: none; padding: 0; border: 0; border-radius: var(--pill); background: var(--accent); color: var(--accent-ink); cursor: pointer; transition: transform var(--fast) var(--ease), background var(--fast) var(--ease); }
.music-play:hover { background: var(--accent-hover); transform: scale(1.06); }
.music-play:active { transform: scale(0.96); }
.music-spin { width: 18px; height: 18px; margin: 7px; flex: none; border-radius: var(--pill); border: 2px solid var(--line-2); border-top-color: var(--accent); animation: music-spin 0.8s linear infinite; }
@keyframes music-spin { to { transform: rotate(360deg); } }
@keyframes music-in { from { opacity: 0; transform: translateY(-3px); } }
@media (max-width: 640px) { .music-ask { flex-wrap: wrap; } .music-ask-actions { width: 100%; justify-content: flex-end; } }

.music-sub { margin: 22px 0 10px; font-family: var(--mono); font-size: 11px; font-weight: 500; color: var(--faint); text-transform: uppercase; letter-spacing: 0.08em; }
.music-list { display: flex; flex-direction: column; gap: 8px; }
.music-row { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto auto; align-items: center; gap: 16px; padding: 10px 12px 10px 10px; border-radius: var(--radius-md); transition: border-color var(--fast) var(--ease); }
.music-row:hover { border-color: var(--line-2); }
.music-cover { position: relative; display: grid; place-items: center; width: 48px; height: 48px; border-radius: var(--radius-sm); overflow: hidden; background: var(--surface-3); box-shadow: inset 0 0 0 1px var(--line); color: var(--faint); }
.music-cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0.5; }
.music-cover img + .music-cover-icon { display: none; }
.music-title { font-size: 14px; font-weight: 500; letter-spacing: -0.005em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.music-meta { font-size: 12.5px; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.music-meta.is-error { color: var(--danger); }
.music-progress { height: 2px; margin-top: 7px; border-radius: var(--pill); background: var(--line); overflow: hidden; }
.music-progress i { display: block; width: 0; height: 100%; background: var(--accent); transition: width 0.25s linear; }
.music-facts { font-family: var(--mono); font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.music-row-actions { display: flex; align-items: center; gap: 6px; }
@media (max-width: 640px) { .music-row { grid-template-columns: 52px minmax(0, 1fr); } .music-facts { display: none; } .music-row-actions { grid-column: 1 / -1; justify-content: flex-end; } }
`;
document.head.append(style);
