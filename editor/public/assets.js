// Left side: the tool rail and the panel it opens. Media holds the AI director, the creator's uploads (slide
// decks, phone screen recordings, B-roll) and the sound library; Text adds titles; the rest are still to come.
import { $, $$, I, api, esc, tc } from "./ui.js";

const TOOLS = [
  ["media", "Media", I.media],
  ["text", "Text", I.text],
  ["captions", "Captions", I.captions],
  ["elements", "Elements", I.elements],
  ["audio", "Audio", I.audio],
  ["transitions", "Transitions", I.transitions],
  ["effects", "Effects", I.effects],
  ["filters", "Filters", I.filters],
  ["brand", "Brand", I.brand],
];

const SOON = {
  captions: ["Caption styles", "Hormozi, karaoke, boxed, word-by-word and more, applied to every caption at once."],
  elements: ["Elements", "Logos, stickers, arrows and shapes you can place and animate on the canvas."],
  transitions: ["Transitions", "Fades, dissolves, whips and zooms, dropped straight onto an edit point."],
  effects: ["Effects", "Zoom punches, shakes, blurs and light leaks for any clip."],
  filters: ["Filters", "Color looks and adjustments: exposure, contrast, warmth, fade and vignette."],
  brand: ["Brand kit", "Your fonts, colors, logo and intro card, one click away."],
};

export const ACCEPT = ".pdf,.pptx,.key,.png,.jpg,.jpeg,.webp,.mp4,.mov,.m4v,.webm,.mkv,video/*,image/png,image/jpeg,image/webp,application/pdf";

export function createAssets(rail, panel, store, ctx) {
  let tool = localStorage.getItem("editor.tool") || "media";
  let filter = "all";
  let media = null;
  let uploads = null; // [{ id, kind, role, name, status, slides, … }]
  let sending = []; // [{ name, pct }]
  let openDeck = null;
  let pollTimer = 0;
  const want = readWant();
  const projectId = ctx.context.project.id;

  rail.innerHTML = TOOLS.map(([id, label, icon]) => `<button class="rail-btn" data-tool="${id}" title="${label}">${icon(20)}<span>${label}</span></button>`).join("");

  const soundCard = (s) => `
    <div class="as-audio" data-sound="${esc(s.id)}" draggable="true" title="Double-click to use as background music · or drag onto the timeline">
      <span class="as-audio-icon">${I.audio(15)}</span>
      <span class="as-audio-text"><b>${esc(s.name)}</b><small>${s.duration ? tc(s.duration) : ""}${s.bpm ? ` · ${s.bpm} BPM` : ""}${s.hasWords === false ? " · Instrumental" : ""}</small></span>
      <button class="ibtn sm" data-use-sound="${esc(s.id)}" title="Use as background music">${I.plus(14)}</button>
    </div>`;

  // ---------- director ----------
  function drawDirector() {
    const d = ctx.director || { state: "idle" };
    const busy = d.state === "running";
    const hasUploads = uploads?.some((u) => u.status === "ready");
    const toggle = (key, label) => `<button class="dr-chip ${want[key] ? "on" : ""}" data-want="${key}" ${busy ? "disabled" : ""}>${want[key] ? I.check(12) : I.plus(12)}<span>${label}</span></button>`;
    return `
      <div class="dr-card ${busy ? "busy" : ""}">
        <div class="dr-top">${I.sparkle(16)}<b>AI director</b></div>
        <p class="dr-lede">${busy ? "Reading what you say and matching your slides and recordings…" : hasUploads ? "Places your slides and phone recordings where you talk about them, and lands the key lines as big captions behind you." : "Upload your slides or phone recordings below, or build big captions from what you say."}</p>
        <div class="dr-chips">${toggle("slides", "Slides")}${toggle("screens", "Phone demos")}${toggle("emphasis", "Big captions")}</div>
        <input class="in-input dr-note" data-director-note maxlength="300" placeholder="Anything to steer it? (optional)" value="${esc(ctx.directorNote || "")}" ${busy ? "disabled" : ""} />
        <button class="btn-primary dr-go" data-director ${busy ? "disabled" : ""}>${busy ? `<span class="spinner sm"></span><span>Building your edit</span>` : `${I.sparkle(15)}<span>Build my edit</span>`}</button>
        ${d.message ? `<p class="dr-msg ${d.state === "error" ? "err" : ""}">${esc(d.message)}</p>` : ""}
      </div>`;
  }

  // ---------- uploads ----------
  function uploadCard(u) {
    const processing = u.status === "processing";
    const failed = u.status === "error";
    const count = u.slides?.length;
    const meta = failed ? esc(u.error || "Couldn't read this file") : processing ? "Processing…" : u.kind === "video" ? `${tc(u.duration || 0)} · ${u.role === "broll" ? "B-roll" : "Phone recording"}` : `${count} slide${count === 1 ? "" : "s"}`;
    const thumb = u.poster ? `<img src="${esc(u.poster)}" alt="" draggable="false" />` : `<span class="up-glyph">${(u.kind === "video" ? I.video : I.media)(20)}</span>`;
    return `
      <div class="up-card ${failed ? "err" : ""}" data-upload="${esc(u.id)}">
        <button class="up-thumb ${u.kind === "video" ? "portrait-ok" : ""}" data-open="${esc(u.id)}" ${processing || failed ? "disabled" : ""} title="${u.kind === "video" ? "Add at the playhead" : "Show slides"}">${thumb}${processing ? `<span class="up-busy"><span class="spinner sm"></span></span>` : ""}${u.kind === "video" && u.duration ? `<span class="as-dur">${tc(u.duration)}</span>` : ""}</button>
        <div class="up-text"><b title="${esc(u.name)}">${esc(u.name)}</b><small>${meta}</small>
          ${u.kind === "video" && u.status === "ready" ? `<div class="seg up-role"><button data-role="screen" class="${u.role !== "broll" ? "on" : ""}">Phone</button><button data-role="broll" class="${u.role === "broll" ? "on" : ""}">B-roll</button></div>` : ""}
          ${u.notice ? `<small class="up-note">${esc(u.notice)}</small>` : ""}
        </div>
        <button class="ibtn sm up-del" data-remove="${esc(u.id)}" title="Remove upload">${I.trash(14)}</button>
      </div>`;
  }

  function drawDeck(u) {
    return `
      <div class="up-deck">
        <div class="up-deck-head"><button class="ibtn sm" data-close-deck>${I.back(14)}</button><b>${esc(u.name)}</b><small>Click a slide to add it at the playhead</small></div>
        <div class="up-slides">${u.slides
          .map((s) => `<button class="up-slide" data-slide="${esc(u.id)}:${s.page}" title="${esc(s.title || s.text || `Slide ${s.page}`)}">${s.src ? `<img src="${esc(s.src)}" alt="" loading="lazy" draggable="false" />` : `<span class="up-rebuilt">${esc(s.title || `Slide ${s.page}`)}</span>`}<i>${s.page}</i></button>`)
          .join("")}</div>
      </div>`;
  }

  function drawUploads() {
    if (!uploads) return `<div class="as-skeleton">${"<i></i>".repeat(2)}</div>`;
    const deck = openDeck && uploads.find((u) => u.id === openDeck && u.slides?.length);
    if (deck) return drawDeck(deck);
    return `
      <label class="up-drop" data-drop>
        <input type="file" data-file multiple accept="${ACCEPT}" hidden />
        ${I.upload(18)}<b>Upload slides or recordings</b><small>PDF, PowerPoint, PNG, JPG or video · drop files here</small>
      </label>
      ${sending.map((f) => `<div class="up-card sending"><span class="up-thumb"><span class="up-busy"><span class="spinner sm"></span></span></span><div class="up-text"><b>${esc(f.name)}</b><small>Uploading ${f.pct}%</small><div class="up-bar"><i style="width:${f.pct}%"></i></div></div></div>`).join("")}
      ${uploads.length ? `<div class="up-list">${uploads.map(uploadCard).join("")}</div>` : ""}`;
  }

  function drawMedia() {
    if (!media) return `<div class="as-skeleton">${"<i></i>".repeat(6)}</div>`;
    const videos = filter === "all" || filter === "videos" ? media.videos : [];
    const audio = filter === "all" || filter === "audio" ? media.audio : [];
    return `
      ${filter === "all" || filter === "uploads" ? `${drawDirector()}<p class="as-label">Your uploads</p>${drawUploads()}` : ""}
      ${videos.length ? `<p class="as-label">Talking video</p><div class="as-grid">${videos
        .map((v) => `<div class="as-card on" title="${esc(v.name)} · already on your timeline">
            <div class="as-thumb">${v.poster ? `<img src="${esc(v.poster)}" alt="" draggable="false" />` : ""}<span class="as-dur">${tc(v.duration)}</span><span class="as-check">${I.check(12)}</span></div>
            <span class="as-name">${esc(v.name)}</span>
          </div>`)
        .join("")}</div>` : ""}
      ${audio.length ? `<p class="as-label">Sounds</p><div class="as-list">${audio.map(soundCard).join("")}</div>` : ""}`;
  }

  function draw() {
    $$(".rail-btn", rail).forEach((b) => b.classList.toggle("on", b.dataset.tool === tool));
    const scroll = $(".as-body", panel)?.scrollTop || 0;
    if (tool === "media") {
      panel.innerHTML = `
        <div class="as-head"><h3>Media</h3><button class="btn-ghost sm" data-pick>${I.upload(14)}<span>Upload</span></button></div>
        <div class="seg">${["all", "uploads", "videos", "audio"].map((f) => `<button data-filter="${f}" class="${filter === f ? "on" : ""}">${f[0].toUpperCase()}${f.slice(1)}</button>`).join("")}</div>
        <div class="as-body">${drawMedia()}</div>`;
    } else if (tool === "text") {
      panel.innerHTML = `
        <div class="as-head"><h3>Text</h3></div>
        <div class="as-body">
          <button class="as-add" data-add-text="title"><span class="as-add-sample title">Add a title</span><small>Hook headline · plays at the playhead</small></button>
          <button class="as-add" data-add-text="plain"><span class="as-add-sample">Add text</span><small>A plain line of text</small></button>
          <button class="as-add" data-add-emphasis><span class="as-add-sample emph">Big caption</span><small>Huge glowing words behind you · at the playhead</small></button>
          <p class="as-hint">Select a title on the canvas or the timeline to edit it in the panel on the right.</p>
        </div>`;
    } else if (tool === "audio") {
      panel.innerHTML = `
        <div class="as-head"><h3>Audio</h3></div>
        <div class="as-body">${media ? (media.audio.length ? `<div class="as-list">${media.audio.map(soundCard).join("")}</div>` : `<p class="as-empty">Your sound library is empty. Add tracks on the Sounds page.</p>`) : `<div class="as-skeleton">${"<i></i>".repeat(4)}</div>`}</div>`;
    } else {
      const [title, body] = SOON[tool];
      panel.innerHTML = `
        <div class="as-head"><h3>${title}</h3></div>
        <div class="as-body"><div class="as-soon">${TOOLS.find((t) => t[0] === tool)[2](26)}<b>Coming soon</b><p>${body}</p></div></div>`;
    }
    const body = $(".as-body", panel);
    if (body) body.scrollTop = scroll;
  }

  // ---------- data ----------
  async function loadUploads() {
    try {
      ({ assets: uploads } = await api(`/api/editor/projects/${projectId}/assets`));
      ctx.uploads = new Map(uploads.map((u) => [u.id, u]));
    } catch {
      uploads = uploads || [];
    }
    clearTimeout(pollTimer);
    if (uploads.some((u) => u.status === "processing")) pollTimer = setTimeout(loadUploads, 2000);
    if (!document.activeElement?.matches?.("[data-director-note]")) draw();
    ctx.onUploads?.();
  }

  function sendFiles(files) {
    const list = [...files];
    if (!list.length) return;
    for (const file of list) {
      const row = { name: file.name, pct: 0 };
      sending.push(row);
      const data = new FormData();
      data.append("files", file);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/editor/projects/${projectId}/assets`);
      xhr.upload.onprogress = (ev) => {
        if (!ev.lengthComputable) return;
        row.pct = Math.round((ev.loaded / ev.total) * 100);
        const bar = $$(".up-card.sending", panel)[sending.indexOf(row)];
        if (bar) {
          $("small", bar).textContent = `Uploading ${row.pct}%`;
          $(".up-bar i", bar).style.width = `${row.pct}%`;
        } else draw();
      };
      xhr.onloadend = () => {
        sending = sending.filter((r) => r !== row);
        let res = {};
        try {
          res = JSON.parse(xhr.responseText || "{}");
        } catch {}
        if (xhr.status >= 300 || !xhr.status) ctx.toast?.(`${file.name}: ${res.error || "upload failed"}`);
        loadUploads();
      };
      xhr.send(data);
    }
    tool = "media";
    if (filter !== "all" && filter !== "uploads") filter = "all";
    openDeck = null;
    draw();
  }

  // ---------- events ----------
  rail.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tool]");
    if (!btn) return;
    tool = btn.dataset.tool;
    try {
      localStorage.setItem("editor.tool", tool);
    } catch {}
    draw();
  });

  panel.addEventListener("click", async (e) => {
    const f = e.target.closest("[data-filter]");
    if (f) {
      filter = f.dataset.filter;
      return draw();
    }
    if (e.target.closest("[data-pick]")) {
      if (filter !== "all" && filter !== "uploads") filter = "all";
      openDeck = null;
      draw();
      return $("[data-file]", panel)?.click();
    }
    const w = e.target.closest("[data-want]");
    if (w) {
      want[w.dataset.want] = !want[w.dataset.want];
      try {
        localStorage.setItem("editor.director.v2", JSON.stringify(want));
      } catch {}
      return draw();
    }
    if (e.target.closest("[data-director]")) return ctx.actions.runDirector({ want: { ...want }, note: $("[data-director-note]", panel)?.value || "" });
    const open = e.target.closest("[data-open]");
    if (open) {
      const u = uploads.find((x) => x.id === open.dataset.open);
      if (u?.kind === "video") return ctx.actions.addOverlay({ asset: u.id });
      openDeck = u?.id || null;
      if (u?.slides?.length === 1) {
        openDeck = null;
        return ctx.actions.addOverlay({ asset: u.id, page: 1 });
      }
      return draw();
    }
    if (e.target.closest("[data-close-deck]")) {
      openDeck = null;
      return draw();
    }
    const slide = e.target.closest("[data-slide]");
    if (slide) {
      const [asset, page] = slide.dataset.slide.split(":");
      return ctx.actions.addOverlay({ asset, page: Number(page) });
    }
    const role = e.target.closest("[data-role]");
    if (role) {
      const id = role.closest("[data-upload]").dataset.upload;
      await api(`/api/editor/projects/${projectId}/assets/${id}`, { method: "PATCH", body: { role: role.dataset.role } }).catch((err) => ctx.toast?.(err.message));
      return loadUploads();
    }
    const remove = e.target.closest("[data-remove]");
    if (remove) {
      const u = uploads.find((x) => x.id === remove.dataset.remove);
      const used = store.doc.tracks.some((t) => t.kind === "overlay" && t.clips.some((c) => c.asset === u?.id));
      if (!confirm(`Remove “${u?.name}”?${used ? " It's on your timeline, and those overlays stop showing." : ""}`)) return;
      await api(`/api/editor/projects/${projectId}/assets/${remove.dataset.remove}`, { method: "DELETE" }).catch((err) => ctx.toast?.(err.message));
      return loadUploads();
    }
    const use = e.target.closest("[data-use-sound]");
    if (use) return ctx.actions.useSound(use.dataset.useSound);
    const add = e.target.closest("[data-add-text]");
    if (add) return ctx.actions.addText(add.dataset.addText);
    if (e.target.closest("[data-add-emphasis]")) return ctx.actions.addEmphasis();
  });
  panel.addEventListener("input", (e) => {
    if (e.target.matches("[data-director-note]")) ctx.directorNote = e.target.value;
  });
  panel.addEventListener("change", (e) => {
    if (e.target.matches("[data-file]")) {
      sendFiles(e.target.files);
      e.target.value = "";
    }
  });
  panel.addEventListener("dblclick", (e) => {
    const card = e.target.closest("[data-sound]");
    if (card) ctx.actions.useSound(card.dataset.sound);
  });
  panel.addEventListener("dragstart", (e) => {
    const card = e.target.closest("[data-sound]");
    if (!card) return;
    e.dataTransfer.setData("application/x-clip-sound", card.dataset.sound);
    e.dataTransfer.effectAllowed = "copy";
  });
  // Files dropped anywhere on the panel upload.
  panel.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    panel.classList.add("dropping");
  });
  panel.addEventListener("dragleave", (e) => {
    if (!panel.contains(e.relatedTarget)) panel.classList.remove("dropping");
  });
  panel.addEventListener("drop", (e) => {
    if (!e.dataTransfer.files?.length) return;
    e.preventDefault();
    panel.classList.remove("dropping");
    sendFiles(e.dataTransfer.files);
  });

  api(`/api/editor/projects/${projectId}/media`)
    .then((m) => {
      media = m;
      ctx.sounds = new Map(m.audio.map((s) => [s.id, s]));
      draw();
    })
    .catch(() => {
      media = { videos: [], audio: [] };
      draw();
    });
  loadUploads();
  draw();
  return {
    draw,
    reloadUploads: loadUploads,
    upload: sendFiles,
    destroy() {
      clearTimeout(pollTimer);
    },
  };
}

function readWant() {
  try {
    // Big captions by default; slides and phone demos only when the creator turns them on for an edit.
    return { slides: false, screens: false, emphasis: true, ...JSON.parse(localStorage.getItem("editor.director.v2") || "{}") };
  } catch {
    return { slides: false, screens: false, emphasis: true };
  }
}
