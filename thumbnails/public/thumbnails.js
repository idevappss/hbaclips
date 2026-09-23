// Thumbnails tab (#/thumbnails): the thumbnail made for every video, and the switches that stop it
// being made. Owned by the THUMBNAILS session; app.js imports this and calls mountThumbnails(app).
const API = "/api/thumbnails";
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const svg = (body, size = 15) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  close: svg(`<path d="M6 6l12 12M18 6 6 18"/>`),
  download: svg(`<path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M5 20h14"/>`),
  again: svg(`<path d="M19 12a7 7 0 1 1-2.2-5.1"/><path d="M19.5 4v4h-4"/>`),
  wand: svg(`<path d="M4 20 15 9m0 0 3-3-2-2-3 3m2 2-2-2"/><path d="M6 4v3M4.5 5.5h3M18 15v3m-1.5-1.5h3"/>`),
  heart: svg(`<path d="M12 19s-6.5-4.2-6.5-8.4A3.6 3.6 0 0 1 12 8.2a3.6 3.6 0 0 1 6.5 2.4C18.5 14.8 12 19 12 19z"/>`, 14),
  image: svg(`<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 4.5-4.5L12 16l3-3 5 5"/>`, 30),
};

const state = { settings: {}, layouts: [], videos: [], history: [], claude: true, open: null, tab: "videos" };
let poll = null;

async function api(url, { method = "GET", body } = {}) {
  const res = await fetch(API + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2600);
}

const mmss = (s) => (s == null ? "" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`);
const busy = (v) => v.state === "working" || (v.auto && state.settings.auto !== false && v.state === "waiting");

// ---------------------------------------------------------------------------

function tile(v) {
  const t = v.thumbnail;
  const shot = t
    ? `<img src="${esc(t.url)}?v=${encodeURIComponent(t.updatedAt)}" alt="" loading="lazy" />`
    : `<div class="tn-blank">${ICON.image}<span>${
        v.state === "working" ? "Making it…" : v.auto === false ? "Switched off for this video" : state.settings.auto === false ? "Auto is off" : v.state === "failed" ? "Couldn't make one" : "Waiting for the video"
      }</span></div>`;
  const chips = [
    v.state === "working" ? `<span class="chip live">Making it</span>` : "",
    v.state === "failed" ? `<span class="chip error" title="${esc(v.error || "")}">Failed</span>` : "",
    t?.demo ? `<span class="chip">No Claude key</span>` : "",
    t?.partial ? `<span class="chip" title="Made before the transcript finished">From the picture only</span>` : "",
    t?.liked === true ? `<span class="chip done">♥</span>` : "",
  ].filter(Boolean).join("");

  return `<article class="tn-card ${busy(v) ? "working" : ""}" data-id="${esc(v.id)}">
    <div class="tn-shot" data-act="open">${shot}</div>
    <div class="tn-body">
      <div class="tn-title"><b>${esc(v.name || "Untitled")}</b>${chips}</div>
      <div class="tn-meta">${t ? `“${esc(t.headline)}”` : esc(v.status || "")}${v.duration ? ` · ${mmss(v.duration)}` : ""}</div>
      <div class="tn-actions">
        <label class="toggle tn-auto" title="Make a thumbnail for this video automatically">
          <input type="checkbox" data-act="auto" ${v.auto ? "checked" : ""} /><span class="track"></span>Auto
        </label>
        <span class="spacer"></span>
        ${t ? `<a class="btn sm ghost" href="${esc(t.downloadUrl)}">${ICON.download} Save</a>
               <button class="btn sm" data-act="open">Edit</button>`
             : `<button class="btn sm primary" data-act="make" ${v.state === "working" ? "disabled" : ""}>${ICON.wand} Make one</button>`}
      </div>
    </div>
  </article>`;
}

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(+d) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** Every thumbnail there has ever been: the one each video has now, then the ones they replaced. */
function gallery() {
  const current = state.videos
    .filter((v) => v.thumbnail)
    .map((v) => ({ ...v.thumbnail, videoId: v.id, videoName: v.name, past: false }));
  return [...current, ...state.history].sort((a, b) => (b.replacedAt || b.updatedAt || "").localeCompare(a.replacedAt || a.updatedAt || ""));
}

function shotCard(t) {
  return `<article class="tn-card tn-shotcard" data-thumb="${esc(t.id)}">
    <div class="tn-shot"><img src="${esc(t.url)}?v=${encodeURIComponent(t.updatedAt)}" alt="" loading="lazy" /></div>
    <div class="tn-body">
      <div class="tn-title"><b>${esc(t.headline || "—")}</b>${t.past ? `<span class="chip">Replaced ${esc(when(t.replacedAt))}</span>` : `<span class="chip done">Current</span>`}</div>
      <div class="tn-meta">${esc(t.videoName || t.name || "")}</div>
    </div>
  </article>`;
}

function render(root) {
  const auto = state.settings.auto !== false;
  $("#tn-auto", root).checked = auto;
  $("#tn-auto-note", root).textContent = auto
    ? "On — every new video gets one while it's still transcribing."
    : "Off — nothing is made automatically. Use Make one on a video.";
  const off = state.videos.filter((v) => !v.auto).length;
  $("#tn-count", root).textContent = `${state.videos.filter((v) => v.thumbnail).length} made${off ? ` · ${off} switched off` : ""}${state.claude ? "" : " · no Claude key"}`;

  const all = gallery();
  $("#tn-tabs", root).innerHTML = [
    ["videos", `Videos <span class="tn-n">${state.videos.length}</span>`],
    ["all", `All thumbnails <span class="tn-n">${all.length}</span>`],
  ].map(([id, label]) => `<button type="button" data-tab="${id}" class="${state.tab === id ? "on" : ""}">${label}</button>`).join("");

  const grid = $("#tn-grid", root);
  if (state.tab === "all") {
    grid.innerHTML = all.length
      ? all.map(shotCard).join("")
      : `<div class="empty">Nothing made yet. Every thumbnail — the current one and the ones it replaced — lands here.</div>`;
    return;
  }
  grid.innerHTML = state.videos.length
    ? state.videos.map(tile).join("")
    : `<div class="empty">No videos yet. Import one on <b>Projects</b> and its thumbnail shows up here.</div>`;
}

async function refresh(root) {
  const data = await api("/");
  Object.assign(state, data);
  render(root);
  if (state.open) {
    const v = state.videos.find((x) => x.thumbnail?.id === state.open);
    if (v) fillEditor(v.thumbnail);
  }
  clearTimeout(poll);
  if (state.videos.some(busy) && root.isConnected) poll = setTimeout(() => refresh(root).catch(() => {}), 6000);
}

// ---------------------------------------------------------------------------
// Editor

function openModal(html) {
  closeModal();
  const back = document.createElement("div");
  back.className = "modal-backdrop tn-backdrop";
  back.innerHTML = `<div class="modal tn-modal wide" role="dialog" aria-modal="true">${html}</div>`;
  back.addEventListener("mousedown", (e) => e.target === back && closeModal());
  document.body.append(back);
  document.body.classList.add("no-scroll");
  return back.firstElementChild;
}
function closeModal() {
  state.open = null;
  $(".tn-backdrop")?.remove();
  if (!$(".modal-backdrop")) document.body.classList.remove("no-scroll");
}

function fillEditor(t) {
  const modal = $(".tn-modal");
  if (!modal) return;
  $(".tn-preview img", modal).src = `${t.url}?v=${encodeURIComponent(t.updatedAt)}`;
  $(".tn-why", modal).textContent = t.why || "";
  $$(".tn-strip button", modal).forEach((b) => b.classList.toggle("on", b.dataset.frame === t.frame?.file));
}

function editor(v, root) {
  const t = v.thumbnail;
  state.open = t.id;
  const modal = openModal(`
    <div class="modal-head">
      <div><h2>${esc(v.name || "Untitled")}</h2><p class="muted tn-why">${esc(t.why || "")}</p></div>
      <button class="icon-btn" data-act="close" aria-label="Close">${ICON.close}</button>
    </div>
    <div class="tn-preview"><img src="${esc(t.url)}?v=${encodeURIComponent(t.updatedAt)}" alt="" /></div>
    <div class="tn-strip">${(t.frames || []).map((f) => `
      <button type="button" data-frame="${esc(f.file)}" class="${f.file === t.frame?.file ? "on" : ""}" title="${mmss(f.at)} · score ${Math.round(f.score * 100)}">
        <img src="${esc(f.url)}" alt="" loading="lazy" /><span>${mmss(f.at)}</span>
      </button>`).join("")}
    </div>
    <div class="tn-form">
      <label class="field grow"><span>Headline</span><input id="tn-headline" value="${esc(t.headline)}" maxlength="120" /></label>
      <label class="field"><span>Under it <em>optional</em></span><input id="tn-sub" value="${esc(t.sub || "")}" maxlength="80" /></label>
      <label class="field"><span>Corner badge <em>optional</em></span><input id="tn-badge" value="${esc(t.badge || "")}" maxlength="24" placeholder="e.g. Part 2" /></label>
      <label class="field"><span>Layout</span><select id="tn-layout">
        <option value="">Auto — away from the face</option>
        ${state.layouts.map((l) => `<option value="${l.id}" ${t.layout === l.id ? "selected" : ""}>${esc(l.label)}</option>`).join("")}
      </select></label>
      <label class="field tn-color"><span>Accent</span><input type="color" id="tn-accent" value="${esc(t.usedAccent || "#ef3340")}" /></label>
      <label class="toggle tn-logo"><input type="checkbox" id="tn-logo" ${t.logo ? "checked" : ""} /><span class="track"></span>Brand logo</label>
    </div>
    <div class="modal-actions">
      <button class="btn sm ghost" data-act="rate" data-liked="true" title="Love these words">${ICON.heart} Love it</button>
      <button class="btn sm ghost" data-act="rate" data-liked="false">Not this</button>
      <span class="spacer"></span>
      <button class="btn sm danger" data-act="delete">Delete</button>
      <button class="btn sm" data-act="again">${ICON.again} New words</button>
      <a class="btn sm" href="${esc(t.downloadUrl)}">${ICON.download} Save 1280×720</a>
      <button class="btn sm primary" data-act="save">Apply</button>
    </div>`);

  const save = async (extra = {}) => {
    const btn = $("[data-act=save]", modal);
    btn.disabled = true;
    btn.textContent = "Painting…";
    try {
      await api(`/items/${t.id}`, {
        method: "PATCH",
        body: {
          headline: $("#tn-headline", modal).value,
          sub: $("#tn-sub", modal).value,
          badge: $("#tn-badge", modal).value,
          layout: $("#tn-layout", modal).value || null,
          accent: $("#tn-accent", modal).value,
          logo: $("#tn-logo", modal).checked,
          ...extra,
        },
      });
      await refresh(root);
      toast("Thumbnail updated.");
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Apply";
    }
  };

  modal.addEventListener("click", async (e) => {
    const frame = e.target.closest("[data-frame]");
    if (frame) return save({ frame: frame.dataset.frame });
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "close") return closeModal();
    if (act === "save") return save();
    if (act === "rate") {
      const liked = e.target.closest("[data-act=rate]").dataset.liked === "true";
      await api(`/items/${t.id}/rate`, { method: "POST", body: { liked } }).catch((err) => toast(err.message));
      toast(liked ? "Saved to your title taste." : "Noted — it won't write like that again.");
      return refresh(root);
    }
    if (act === "again") {
      toast("Picking a new frame and new words…");
      closeModal();
      await api(`/videos/${v.id}/generate`, { method: "POST" }).catch((err) => toast(err.message));
      return refresh(root);
    }
    if (act === "delete") {
      closeModal();
      await api(`/items/${t.id}`, { method: "DELETE" }).catch((err) => toast(err.message));
      return refresh(root);
    }
  });
  modal.addEventListener("keydown", (e) => e.key === "Enter" && e.target.matches("input:not([type=color])") && save());
}

// ---------------------------------------------------------------------------

/** A thumbnail this video used to have: look at it big, put it back, save it or forget it. */
function pastThumb(t, root) {
  const modal = openModal(`
    <div class="modal-head">
      <div><h2>${esc(t.headline || "Thumbnail")}</h2><p class="muted">${esc(t.videoName || t.name || "")} · replaced ${esc(when(t.replacedAt))}</p></div>
      <button class="icon-btn" data-act="close" aria-label="Close">${ICON.close}</button>
    </div>
    <div class="tn-preview"><img src="${esc(t.url)}?v=${encodeURIComponent(t.updatedAt)}" alt="" /></div>
    <div class="modal-actions">
      <span class="spacer"></span>
      <button class="btn sm danger" data-act="delete">Delete</button>
      <a class="btn sm" href="${esc(t.downloadUrl)}">${ICON.download} Save 1280×720</a>
      <button class="btn sm primary" data-act="restore">${ICON.again} Use this one again</button>
    </div>`);
  modal.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "close") return closeModal();
    closeModal();
    if (act === "restore") {
      await api(`/items/${t.id}/restore`, { method: "POST" }).then(() => toast("Put back as this video's thumbnail.")).catch((err) => toast(err.message));
    } else if (act === "delete") {
      await api(`/items/${t.id}`, { method: "DELETE" }).catch((err) => toast(err.message));
    }
    return refresh(root);
  });
}

export async function mountThumbnails(el) {
  el.innerHTML = `
    <div class="tn-page">
      <div class="page-head">
        <div>
          <h1>Thumbnails</h1>
          <p class="muted">A 1280×720 thumbnail for every video, made while it's still transcribing: Claude picks the frame where you look best and writes the words for it.</p>
        </div>
        <div class="head-actions tn-head">
          <label class="toggle"><input type="checkbox" id="tn-auto" /><span class="track"></span>Make them automatically</label>
        </div>
      </div>
      <div class="tn-bar"><span class="muted small" id="tn-auto-note"></span><span class="spacer"></span><span class="muted small" id="tn-count"></span></div>
      <nav class="tab-strip tn-tabs" id="tn-tabs"></nav>
      <div class="tn-grid" id="tn-grid"><div class="loading">Loading…</div></div>
    </div>`;
  if (!$("link[data-thumbnails-css]")) {
    document.head.insertAdjacentHTML("beforeend", `<link rel="stylesheet" href="${API}/ui/thumbnails.css" data-thumbnails-css />`);
  }
  const root = $(".tn-page", el);

  $("#tn-auto", root).addEventListener("change", async (e) => {
    const auto = e.target.checked;
    try {
      state.settings = await api("/settings", { method: "PATCH", body: { auto } });
      toast(auto ? "Thumbnails will be made automatically." : "Automatic thumbnails are off.");
      await refresh(root);
    } catch (err) {
      toast(err.message);
    }
  });

  root.addEventListener("change", async (e) => {
    const box = e.target.closest("[data-act=auto]");
    if (!box) return;
    const id = box.closest(".tn-card").dataset.id;
    try {
      await api(`/videos/${id}/auto`, { method: "POST", body: { auto: box.checked } });
      toast(box.checked ? "This video will get one." : "No thumbnail for this video.");
      await refresh(root);
    } catch (err) {
      toast(err.message);
    }
  });

  $("#tn-tabs", root).addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) (state.tab = b.dataset.tab), render(root);
  });

  root.addEventListener("click", async (e) => {
    const shot = e.target.closest(".tn-shotcard");
    if (shot) {
      const t = gallery().find((x) => x.id === shot.dataset.thumb);
      if (!t) return;
      if (t.past) return pastThumb(t, root);
      return editor(state.videos.find((v) => v.id === t.videoId), root);
    }
    const card = e.target.closest(".tn-card");
    if (!card || e.target.closest(".toggle") || e.target.closest("a")) return;
    const v = state.videos.find((x) => x.id === card.dataset.id);
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "make") {
      toast("Making a thumbnail — this takes about a minute.");
      card.classList.add("working");
      api(`/videos/${v.id}/generate`, { method: "POST" }).then(() => toast("Thumbnail ready.")).catch((err) => toast(err.message)).finally(() => refresh(root));
      return setTimeout(() => refresh(root).catch(() => {}), 1500);
    }
    if (act === "open" && v?.thumbnail) return editor(v, root);
  });

  try {
    await refresh(root);
  } catch (err) {
    $("#tn-grid", root).innerHTML = `<div class="empty">Couldn't load thumbnails: ${esc(err.message)}</div>`;
  }
  return () => {
    clearTimeout(poll);
    closeModal();
  };
}
