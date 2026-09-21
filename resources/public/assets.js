// Assets tab (#/assets): the creator's library of logos, fonts, colors, title animations, transitions,
// brand guidelines, SOPs and examples. Owned by the ASSETS session; app.js imports this and calls mountAssets(app).
const API = "/api/resources";
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const svg = (body, size = 15) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  plus: svg(`<path d="M12 5v14M5 12h14"/>`),
  upload: svg(`<path d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5"/><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"/>`, 22),
  search: svg(`<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>`, 16),
  close: svg(`<path d="M6 6l12 12M18 6 6 18"/>`),
  pin: svg(`<path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/>`, 14),
  link: svg(`<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>`, 14),
  download: svg(`<path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M5 20h14"/>`),
  doc: svg(`<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20V4a.5.5 0 0 1 .5-.5z"/><path d="M14 3.5V8h4M9 12.5h6M9 16h6"/>`, 28),
  code: svg(`<path d="m9 8-4 4 4 4M15 8l4 4-4 4"/>`, 28),
};

const DOCS = ".pdf,.doc,.docx,.txt,.md,.pages,.key,.pptx,.ppt,.xlsx,.csv,.rtf,image/*";
const UPLOAD_TILES = [
  { type: "logo", label: "Logos", sub: "SVG, PNG, JPG", accept: "image/*,.svg,.ai,.eps,.pdf" },
  { type: "guideline", label: "Brand guidelines", sub: "PDF, deck, doc", accept: DOCS },
  { type: "sop", label: "SOPs", sub: "PDF, doc, notes", accept: DOCS },
  { type: "font", label: "Fonts", sub: "TTF, OTF, WOFF", accept: ".ttf,.otf,.woff,.woff2" },
  { type: "example", label: "Examples", sub: "Videos, images", accept: "video/*,image/*" },
  { type: "all", label: "Anything else", sub: "Sorted by type", accept: "" },
];

const state = { types: [], items: [], builtins: [], tab: "all", q: "", showBuiltin: true };
const loadedFonts = new Set();

function toast(msg) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2400);
}

async function api(url, { method = "GET", body, form } = {}) {
  const res = await fetch(API + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const ext = (name = "") => (name.match(/\.(\w+)$/)?.[1] || "").toUpperCase();
const isImage = (it) => it.fileUrl && (/^image\//.test(it.file?.mime) || /\.(svg|png|jpe?g|webp|gif)$/i.test(it.file?.name));
const isVideo = (it) => it.fileUrl && (/^video\//.test(it.file?.mime) || /\.(mp4|mov|webm)$/i.test(it.file?.name));
const isFont = (it) => it.fileUrl && /\.(ttf|otf|woff2?)$/i.test(it.file?.name);
const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};
const typeLabel = (id) => state.types.find((t) => t.id === id)?.label || "Other";

/** Load a font asset under a family name private to this page, so previews show the real face. */
function fontFamily(it) {
  const family = `asset-${it.id.replace(/[^\w-]/g, "")}`;
  if (it.fileUrl && isFont(it) && !loadedFonts.has(family)) {
    loadedFonts.add(family);
    const face = new FontFace(family, `url("${it.fileUrl}")`, it.font?.weight ? { weight: String(it.font.weight) } : {});
    face.load().then((f) => document.fonts.add(f)).catch(() => {});
  }
  return family;
}

// ---------------------------------------------------------------------------
// Rendering

function preview(it) {
  if (it.type === "color" && it.colors?.length) {
    return `<div class="as-palette">${it.colors.slice(0, 8).map((c) => `<i style="background:${esc(c.hex)}"></i>`).join("")}</div>`;
  }
  if (isFont(it)) {
    return `<div class="as-font" style="font-family:'${fontFamily(it)}', var(--font);${it.font?.weight ? `font-weight:${it.font.weight}` : ""}"><b>Aa</b><span>The quick brown fox</span></div>`;
  }
  if (isImage(it)) return `<div class="as-media as-checker"><img src="${esc(it.fileUrl)}" alt="" loading="lazy" /></div>`;
  if (isVideo(it)) return `<div class="as-media"><video src="${esc(it.fileUrl)}#t=0.5" muted loop playsinline preload="metadata"></video></div>`;
  if (it.body) return `<div class="as-text">${esc(it.body.slice(0, 280))}</div>`;
  if (it.fileUrl) {
    const code = /\.(html|js|css|json)$/i.test(it.file.name);
    return `<div class="as-icon">${code ? ICON.code : ICON.doc}<span>${esc(ext(it.file.name))}</span></div>`;
  }
  if (it.url) return `<div class="as-icon">${ICON.link.replace(/14/g, "28")}<span>${esc(host(it.url))}</span></div>`;
  return `<div class="as-text">${esc(it.notes || "")}</div>`;
}

function card(it) {
  const meta = [typeLabel(it.type), it.file ? ext(it.file.name) : it.url ? host(it.url) : it.colors?.length ? `${it.colors.length} colors` : ""].filter(Boolean);
  return `<article class="as-card" data-id="${esc(it.id)}" tabindex="0">
    ${preview(it)}
    <div class="as-card-body">
      <div class="as-card-title">${it.pinned ? `<span class="as-pinned" title="Pinned">${ICON.pin}</span>` : ""}<b>${esc(it.title)}</b></div>
      <div class="as-card-meta">${meta.map(esc).join(" · ")}</div>
      ${it.tags?.length ? `<div class="as-tags">${it.tags.slice(0, 4).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>` : ""}
    </div>
  </article>`;
}

function visible() {
  const q = state.q.trim().toLowerCase();
  const all = [...state.items, ...(state.showBuiltin ? state.builtins : [])];
  return all.filter((it) => {
    if (state.tab !== "all" && it.type !== state.tab) return false;
    if (!q) return true;
    const hay = [it.title, it.notes, it.body, typeLabel(it.type), ...(it.tags || []), ...(it.colors || []).flatMap((c) => [c.name, c.hex]), it.file?.name, it.url].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

function render(root) {
  const counts = {};
  for (const it of [...state.items, ...state.builtins]) counts[it.type] = (counts[it.type] || 0) + 1;
  $("#as-tabs", root).innerHTML = [{ id: "all", label: "All" }, ...state.types]
    .map((t) => `<button type="button" data-tab="${t.id}" class="${state.tab === t.id ? "on" : ""}">${esc(t.label)}${t.id !== "all" && counts[t.id] ? ` <span class="as-count">${counts[t.id]}</span>` : ""}</button>`)
    .join("");

  const list = visible();
  const grid = $("#as-grid", root);
  if (!list.length) {
    const section = state.tab === "all" ? "" : typeLabel(state.tab).toLowerCase();
    grid.innerHTML = `<div class="empty as-empty">${
      state.q ? `Nothing matches “${esc(state.q)}”.` : `No ${section || "assets"} yet. Use <b>Upload files</b> or a tile above, or drop files anywhere on this page.`
    }</div>`;
  } else grid.innerHTML = list.map(card).join("");
  $("#as-total", root).textContent = `${state.items.length} saved`;
}

// ---------------------------------------------------------------------------
// Modals

function openModal(html, { wide = false } = {}) {
  closeModal();
  const back = document.createElement("div");
  back.className = "modal-backdrop as-backdrop";
  back.innerHTML = `<div class="modal as-modal${wide ? " wide" : ""}" role="dialog" aria-modal="true">${html}</div>`;
  back.addEventListener("mousedown", (e) => e.target === back && closeModal());
  document.body.append(back);
  document.body.classList.add("no-scroll");
  return back.firstElementChild;
}
function closeModal() {
  $(".as-backdrop")?.remove();
  if (!$(".modal-backdrop")) document.body.classList.remove("no-scroll");
}

function detail(it, root) {
  const colors = it.colors?.length
    ? `<div class="as-swatch-list">${it.colors.map((c) => `<button type="button" class="as-swatch" data-copy="${esc(c.hex)}" title="Copy ${esc(c.hex)}"><i style="background:${esc(c.hex)}"></i><span><b>${esc(c.name || "Color")}</b><code>${esc(c.hex)}</code></span></button>`).join("")}</div>`
    : "";
  let big = "";
  if (isImage(it)) big = `<div class="as-detail-media as-checker"><img src="${esc(it.fileUrl)}" alt="" /></div>`;
  else if (isVideo(it)) big = `<div class="as-detail-media"><video src="${esc(it.fileUrl)}" controls loop playsinline></video></div>`;
  else if (isFont(it)) {
    const fam = fontFamily(it);
    big = `<div class="as-detail-font" style="font-family:'${fam}', var(--font);${it.font?.weight ? `font-weight:${it.font.weight}` : ""}" contenteditable="true" spellcheck="false">Premium care, explained simply.<small>ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789</small></div>`;
  } else if (/pdf/.test(it.file?.mime || "") || /\.pdf$/i.test(it.file?.name || "")) {
    big = `<iframe class="as-detail-pdf" src="${esc(it.fileUrl)}" title="${esc(it.title)}"></iframe>`;
  } else if (/\.html$/i.test(it.file?.name || "")) {
    big = `<iframe class="as-detail-pdf" src="${esc(it.fileUrl)}" title="${esc(it.title)}" sandbox="allow-scripts"></iframe>`;
  }

  const modal = openModal(`
    <div class="as-modal-inner">
      <div class="modal-head">
        <div><h2>${esc(it.title)}</h2><p class="muted">${esc(typeLabel(it.type))}${it.font?.family ? ` · ${esc(it.font.family)}` : ""}${it.file?.size ? ` · ${kb(it.file.size)}` : ""}</p></div>
        <button class="icon-btn" data-act="close" aria-label="Close">${ICON.close}</button>
      </div>
      ${big}${colors}
      ${it.body ? `<div class="as-body">${esc(it.body)}</div>` : ""}
      ${it.notes ? `<p class="as-notes">${esc(it.notes)}</p>` : ""}
      ${it.tags?.length ? `<div class="as-tags">${it.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>` : ""}
      <div class="modal-actions as-actions">
        ${it.url ? `<a class="btn sm" href="${esc(it.url)}" target="_blank" rel="noopener">${ICON.link} Open link</a>` : ""}
        ${it.fileUrl ? `<a class="btn sm" href="${esc(it.fileUrl)}${it.builtin ? "" : "?download"}" ${it.builtin ? "download" : ""}>${ICON.download} Download</a>` : ""}
        <span class="spacer"></span>
        ${it.builtin ? `<span class="muted small">Built in — ships with Clip Studio</span>` : `
          <button class="btn sm ghost" data-act="pin">${it.pinned ? "Unpin" : "Pin"}</button>
          <button class="btn sm danger" data-act="delete">Delete</button>
          <button class="btn sm primary" data-act="edit">Edit</button>`}
      </div>
    </div>`, { wide: Boolean(big) });

  modal.addEventListener("click", async (e) => {
    const sw = e.target.closest("[data-copy]");
    if (sw) {
      await navigator.clipboard?.writeText(sw.dataset.copy).catch(() => {});
      return toast(`Copied ${sw.dataset.copy}`);
    }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "close") closeModal();
    if (act === "edit") editor(it, root);
    if (act === "pin") {
      await api(`/items/${it.id}`, { method: "PATCH", body: { pinned: !it.pinned } }).catch((err) => toast(err.message));
      closeModal();
      await refresh(root);
    }
    if (act === "delete") {
      if (!confirm(`Delete “${it.title}” from your assets?`)) return;
      try {
        await api(`/items/${it.id}`, { method: "DELETE" });
        closeModal();
        toast("Deleted");
        await refresh(root);
      } catch (err) {
        toast(err.message);
      }
    }
  });
}

function editor(it, root, preset = {}) {
  const editing = Boolean(it);
  const cur = it || { type: preset.type || (state.tab !== "all" ? state.tab : "logo"), title: "", notes: "", body: "", tags: [], url: "", colors: [] };
  const colorRows = (list) =>
    (list.length ? list : [{ name: "", hex: "" }])
      .map((c) => `<div class="as-color-row"><input type="color" value="${esc(/^#[0-9a-f]{6}$/i.test(c.hex) ? c.hex : "#888888")}" data-pick /><input data-hex placeholder="#0b1f3a" value="${esc(c.hex)}" /><input data-name placeholder="Name, e.g. Navy" value="${esc(c.name)}" /><button type="button" class="icon-btn" data-act="rm-color" aria-label="Remove">${ICON.close}</button></div>`)
      .join("");

  const modal = openModal(`
    <form class="as-modal-inner as-form">
      <div class="modal-head">
        <div><h2>${editing ? "Edit asset" : "Add asset"}</h2><p class="muted">Files, links, colors or written docs — whatever this asset is.</p></div>
        <button type="button" class="icon-btn" data-act="close" aria-label="Close">${ICON.close}</button>
      </div>
      <div class="as-row2">
        <label class="field grow"><span>Title</span><input name="title" value="${esc(cur.title)}" placeholder="e.g. Primary logo — white" /></label>
        <label class="field"><span>Section</span><select name="type">${state.types.map((t) => `<option value="${t.id}" ${t.id === cur.type ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select></label>
      </div>
      <label class="dropzone as-file-drop">
        <input type="file" name="file" hidden />
        <div class="dz-title" data-slot="file">${cur.file ? `Current file: ${esc(cur.file.name)} — drop to replace` : "Drop a file or click to choose"}</div>
        <div class="dz-sub">Logos, fonts, PDFs, videos, docs, HyperFrames blocks</div>
      </label>
      <label class="field" data-show="font"><span>Font family name</span><input name="fontFamily" value="${esc(cur.font?.family || "")}" placeholder="e.g. Inter Display" /></label>
      <div class="field" data-show="color"><span>Colors</span><div class="as-colors">${colorRows(cur.colors || [])}</div>
        <button type="button" class="btn sm ghost as-add-color" data-act="add-color">${ICON.plus} Add color</button></div>
      <label class="field"><span>Link <em>optional</em></span><input name="url" value="${esc(cur.url || "")}" placeholder="https://… (Drive, Notion, Figma, a reference Reel)" /></label>
      <label class="field"><span>Doc text <em>paste an SOP, guideline or script</em></span><textarea name="body" rows="6" placeholder="Step 1…">${esc(cur.body || "")}</textarea></label>
      <label class="field"><span>Notes <em>when and how to use it</em></span><textarea name="notes" rows="2">${esc(cur.notes || "")}</textarea></label>
      <label class="field"><span>Tags <em>comma separated</em></span><input name="tags" value="${esc((cur.tags || []).join(", "))}" placeholder="dark bg, hooks, chiro" /></label>
      <div class="modal-actions">
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-act="close">Cancel</button>
        <button class="btn primary" type="submit">${editing ? "Save" : "Add to assets"}</button>
      </div>
    </form>`);

  const form = modal.querySelector("form");
  const fileInput = form.elements.file;
  const drop = $(".as-file-drop", form);
  const syncShow = () => $$("[data-show]", form).forEach((el) => (el.hidden = el.dataset.show !== form.elements.type.value));
  syncShow();
  form.elements.type.addEventListener("change", syncShow);
  fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    if (!f) return;
    $("[data-slot=file]", form).textContent = f.name;
    if (!form.elements.title.value) form.elements.title.value = f.name.replace(/\.\w+$/, "").replace(/[_-]+/g, " ");
  });
  drop.addEventListener("dragover", (e) => (e.preventDefault(), e.stopPropagation(), drop.classList.add("over")));
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove("over");
    if (!e.dataTransfer.files.length) return;
    fileInput.files = e.dataTransfer.files;
    fileInput.dispatchEvent(new Event("change"));
  });

  const colorsBox = $(".as-colors", form);
  colorsBox.addEventListener("input", (e) => {
    const row = e.target.closest(".as-color-row");
    if (e.target.matches("[data-pick]")) $("[data-hex]", row).value = e.target.value;
    if (e.target.matches("[data-hex]") && /^#[0-9a-f]{6}$/i.test(e.target.value.trim())) $("[data-pick]", row).value = e.target.value.trim();
  });

  form.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "close") closeModal();
    if (act === "add-color") colorsBox.insertAdjacentHTML("beforeend", colorRows([{ name: "", hex: "" }]));
    if (act === "rm-color") e.target.closest(".as-color-row").remove();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData();
    for (const key of ["title", "type", "url", "body", "notes", "tags", "fontFamily"]) data.append(key, form.elements[key].value);
    const colors = $$(".as-color-row", colorsBox).map((r) => ({ hex: $("[data-hex]", r).value.trim(), name: $("[data-name]", r).value }));
    data.append("colors", JSON.stringify(form.elements.type.value === "color" ? colors : cur.colors || []));
    if (fileInput.files[0]) data.append("file", fileInput.files[0]);
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      const saved = await api(editing ? `/items/${it.id}` : "/items", { method: editing ? "PATCH" : "POST", form: data });
      closeModal();
      toast(editing ? "Saved" : "Added to assets");
      state.tab = state.tab === "all" ? "all" : saved.type;
      await refresh(root);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });
  form.elements.title.focus();
}

// ---------------------------------------------------------------------------

async function refresh(root) {
  const data = await api("/");
  Object.assign(state, { types: data.types, items: data.items, builtins: data.builtins });
  if (root.isConnected) render(root);
}

async function uploadMany(files, root, type = state.tab) {
  if (!files.length) return;
  const data = new FormData();
  for (const f of files) data.append("files", f);
  if (type && type !== "all") data.append("type", type);
  toast(`Adding ${files.length} file${files.length === 1 ? "" : "s"}…`);
  try {
    const created = await api("/upload", { method: "POST", form: data });
    await refresh(root);
    toast(`Added ${created.length} — sorted into ${[...new Set(created.map((c) => typeLabel(c.type)))].join(", ")}`);
  } catch (err) {
    toast(err.message);
  }
}

export async function mountAssets(el) {
  el.innerHTML = `
    <div class="as-page">
      <div class="page-head">
        <div>
          <h1>Assets</h1>
          <p class="muted">Your brand kit and resources in one place — logos, fonts, colors, title animations, transitions, guidelines, SOPs and examples.</p>
        </div>
        <div class="head-actions">
          <a class="btn sm ghost" href="${API}/brand" target="_blank" rel="noopener" title="What the director, titles and edits read">Brand kit JSON</a>
          <button class="btn" data-act="add">${ICON.plus} Add link, colors or text</button>
          <label class="btn primary as-upload-btn">${ICON.upload.replace(/22/g, "15")} Upload files<input type="file" multiple hidden data-upload="all" /></label>
        </div>
      </div>
      <div class="as-uploads">${UPLOAD_TILES.map((t) => `
        <label class="as-upload" data-drop="${t.type}">
          <input type="file" multiple hidden accept="${t.accept}" data-upload="${t.type}" />
          <span class="as-upload-icon">${ICON.upload}</span>
          <b>${t.label}</b>
          <span>${t.sub}</span>
        </label>`).join("")}
      </div>
      <div class="as-toolbar">
        <label class="as-search">${ICON.search}<input type="search" id="as-q" placeholder="Search assets, tags, hex codes…" autocomplete="off" /></label>
        <label class="as-builtin"><input type="checkbox" id="as-builtin" ${state.showBuiltin ? "checked" : ""} /> Show built-in</label>
        <span class="muted small" id="as-total"></span>
      </div>
      <nav class="tab-strip as-tabs" id="as-tabs"></nav>
      <div class="as-grid" id="as-grid"><div class="loading">Loading…</div></div>
      <div class="as-drop-hint" hidden>${ICON.upload}<b>Drop to add</b><span id="as-drop-where"></span></div>
    </div>`;
  if (!$("link[data-assets-css]")) {
    document.head.insertAdjacentHTML("beforeend", `<link rel="stylesheet" href="${API}/ui/assets.css" data-assets-css />`);
  }
  const root = $(".as-page", el);

  // Upload buttons and tiles: pick files, or drop them straight onto a tile to file them in that section.
  root.addEventListener("change", (e) => {
    const input = e.target.closest("[data-upload]");
    if (!input?.files.length) return;
    uploadMany([...input.files], root, input.dataset.upload);
    input.value = "";
  });
  for (const tile of $$("[data-drop]", root)) {
    tile.addEventListener("dragover", (e) => (e.preventDefault(), tile.classList.add("over")));
    tile.addEventListener("dragleave", () => tile.classList.remove("over"));
    tile.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      tile.classList.remove("over");
      $(".as-drop-hint", root).hidden = true;
      uploadMany([...e.dataTransfer.files], root, tile.dataset.drop);
    });
  }

  $("#as-q", root).addEventListener("input", (e) => ((state.q = e.target.value), render(root)));
  $("#as-builtin", root).addEventListener("change", (e) => ((state.showBuiltin = e.target.checked), render(root)));
  $("#as-tabs", root).addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) (state.tab = b.dataset.tab), render(root);
  });
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-act=add]")) return editor(null, root);
    const c = e.target.closest(".as-card");
    if (c) detail([...state.items, ...state.builtins].find((i) => i.id === c.dataset.id), root);
  });
  root.addEventListener("keydown", (e) => e.key === "Enter" && e.target.matches(".as-card") && e.target.click());
  root.addEventListener("mouseover", (e) => e.target.closest(".as-card")?.querySelector("video")?.play().catch(() => {}));
  root.addEventListener("mouseout", (e) => {
    const v = e.target.closest(".as-card")?.querySelector("video");
    if (v && !e.relatedTarget?.closest?.(".as-card")) v.pause();
  });

  // Drop files anywhere on the page: into the open section, or auto-sorted from "All".
  const hint = $(".as-drop-hint", root);
  let depth = 0;
  const onEnter = (e) => {
    if (!root.isConnected) return cleanup();
    if (!e.dataTransfer?.types.includes("Files") || $(".as-backdrop")) return;
    depth++;
    $("#as-drop-where", root).textContent = state.tab === "all" ? "Sorted by file type" : `Into ${typeLabel(state.tab)}`;
    hint.hidden = false;
  };
  const onOver = (e) => root.isConnected && !$(".as-backdrop") && e.dataTransfer?.types.includes("Files") && e.preventDefault();
  const onLeave = () => --depth <= 0 && ((depth = 0), (hint.hidden = true));
  const onDrop = (e) => {
    if (!root.isConnected) return cleanup();
    if ($(".as-backdrop") || !e.dataTransfer?.files.length) return;
    e.preventDefault();
    depth = 0;
    hint.hidden = true;
    uploadMany([...e.dataTransfer.files], root);
  };
  const cleanup = () => {
    document.removeEventListener("dragenter", onEnter);
    document.removeEventListener("dragover", onOver);
    document.removeEventListener("dragleave", onLeave);
    document.removeEventListener("drop", onDrop);
  };
  document.addEventListener("dragenter", onEnter);
  document.addEventListener("dragover", onOver);
  document.addEventListener("dragleave", onLeave);
  document.addEventListener("drop", onDrop);

  try {
    await refresh(root);
  } catch (err) {
    $("#as-grid", root).innerHTML = `<div class="empty">Couldn't load assets: ${esc(err.message)}</div>`;
  }
  return cleanup;
}
