// Dope Edits UI — vanilla JS, relative URLs so it works standalone (/) or mounted (/edits/).
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
const fmtDur = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${Number(s).toFixed(1)}s`);
const BUSY = ["queued", "analyzing", "directing", "rendering"];

async function api(url, { method = "GET", body } = {}) {
  const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(message, ok = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast${ok ? " ok" : ""}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4200);
}

const state = {
  config: null,
  clips: [],
  music: null,
  projects: null,
  projectIds: new Set(),
  ideas: [],
  pickedIdeas: new Set(),
  ideaFiles: [],
  opts: { length: 30, aspect: "9:16", energy: "auto", audioMode: "auto", sfx: "full" },
  edits: new Map(), // id → full edit
  cards: new Map(), // id → { el, keys }
};

const SEGS = {
  length: [[15, "15s"], [30, "30s"], [45, "45s"], [60, "60s"], [90, "90s"]],
  aspect: [["9:16", "9:16"], ["4:5", "4:5"], ["1:1", "1:1"], ["16:9", "16:9"]],
  energy: [["auto", "Auto"], ["hype", "Hype"], ["medium", "Medium"], ["chill", "Chill"]],
  audioMode: [["auto", "Auto"], ["music", "Music only"], ["mix", "Music + talk"], ["source", "Original"]],
  sfx: [["full", "Full"], ["subtle", "Subtle"], ["off", "Off"]],
};

function renderSegs() {
  document.querySelectorAll(".seg[data-opt]").forEach((seg) => {
    const key = seg.dataset.opt;
    seg.innerHTML = SEGS[key].map(([v, label]) => `<button type="button" data-v="${v}" class="${String(state.opts[key]) === String(v) ? "on" : ""}">${label}</button>`).join("");
  });
}
document.addEventListener("click", (e) => {
  const b = e.target.closest(".seg[data-opt] button");
  if (!b) return;
  const key = b.closest(".seg").dataset.opt;
  state.opts[key] = key === "length" ? Number(b.dataset.v) : b.dataset.v;
  renderSegs();
});

// ---------- tabs ----------

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    $("#tab-make").hidden = t.dataset.tab !== "make";
    $("#tab-lab").hidden = t.dataset.tab !== "lab";
    if (t.dataset.tab === "lab") loadStyle();
  }),
);

// ---------- drop zones ----------

function dropZone(zone, input, onFiles) {
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), input.click()));
  zone.addEventListener("dragover", (e) => (e.preventDefault(), zone.classList.add("over")));
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    onFiles([...e.dataTransfer.files]);
  });
  input.addEventListener("change", () => {
    onFiles([...input.files]);
    input.value = "";
  });
}

dropZone($("#drop-clips"), $("#clips-input"), (files) => {
  const videos = files.filter((f) => f.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name));
  if (!videos.length) return toast("Those aren't video files.");
  state.clips.push(...videos);
  renderClips();
});
dropZone($("#drop-music"), $("#music-input"), (files) => {
  const f = files.find((x) => x.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac|ogg|aiff?)$/i.test(x.name));
  if (!f) return toast("Drop an audio file (mp3, wav, m4a…).");
  state.music = f;
  renderMusic();
});

function renderClips() {
  const rows = [];
  let n = 0;
  const letter = () => String.fromCharCode(65 + n++);
  for (const p of state.projects || []) if (state.projectIds.has(p.id)) rows.push(`<li><span class="tag">${letter()}</span><span class="name">${esc(p.name)}</span><span class="size">${fmtDur(p.duration)} · HBA Clips</span><button class="x" type="button" data-project="${p.id}" aria-label="Remove">×</button></li>`);
  state.clips.forEach((f, i) => rows.push(`<li><span class="tag">${letter()}</span><span class="name">${esc(f.name)}</span><span class="size">${fmtSize(f.size)}</span><button class="x" type="button" data-clip="${i}" aria-label="Remove">×</button></li>`));
  $("#clip-list").innerHTML = rows.join("");
  $("#drop-clips").classList.toggle("has", rows.length > 0);
}
$("#clip-list").addEventListener("click", (e) => {
  const b = e.target.closest(".x");
  if (!b) return;
  if (b.dataset.clip !== undefined) state.clips.splice(Number(b.dataset.clip), 1);
  if (b.dataset.project) state.projectIds.delete(b.dataset.project);
  renderClips();
  renderLibrary();
});

function renderMusic() {
  $("#music-name").innerHTML = state.music ? `${esc(state.music.name)} · ${fmtSize(state.music.size)} <button class="x" type="button" id="drop-song">×</button>` : "Cuts land on its beat. Optional.";
  $("#drop-music").classList.toggle("has", Boolean(state.music));
  if (state.music) $("#sound-select").value = "";
}

async function loadSounds() {
  let tracks = [];
  try {
    tracks = await api("api/sounds");
  } catch {
    return;
  }
  $("#sound-pick").hidden = !tracks.length;
  const current = $("#sound-select").value;
  $("#sound-select").innerHTML = `<option value="">—</option>` + tracks.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}${t.bpm ? ` · ${t.bpm} BPM` : ""}${t.duration ? ` · ${fmtDur(t.duration)}` : ""}${t.study ? " · saved from Study" : ""}</option>`).join("");
  $("#sound-select").value = current;
}
$("#sound-select").addEventListener("change", (e) => {
  if (e.target.value && state.music) {
    state.music = null;
    renderMusic();
    e.target.value = e.target.selectedOptions[0].value;
  }
});
$("#drop-music").addEventListener("click", (e) => {
  if (e.target.id === "drop-song") {
    e.stopPropagation();
    state.music = null;
    renderMusic();
  }
}, true);

$("#toggle-library").addEventListener("click", async () => {
  const lib = $("#library");
  lib.hidden = !lib.hidden;
  if (!lib.hidden && !state.projects) {
    lib.innerHTML = `<small>Loading…</small>`;
    try {
      state.projects = await api("api/clip-studio/projects");
    } catch (err) {
      state.projects = [];
      toast(err.message);
    }
  }
  renderLibrary();
});
function renderLibrary() {
  const lib = $("#library");
  if (lib.hidden || !state.projects) return;
  lib.innerHTML = state.projects.length
    ? state.projects.map((p) => `<label><input type="checkbox" data-id="${p.id}" ${state.projectIds.has(p.id) ? "checked" : ""}/><span>${esc(p.name)}</span><small>${fmtDur(p.duration)}${p.hasTranscript ? " · transcript" : ""}</small></label>`).join("")
    : `<small>No HBA Clips videos yet.</small>`;
}
$("#library").addEventListener("change", (e) => {
  const id = e.target.dataset.id;
  if (!id) return;
  e.target.checked ? state.projectIds.add(id) : state.projectIds.delete(id);
  renderClips();
});

// ---------- new edit ----------

function uploadForm(url, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      xhr.status < 400 ? resolve(data) : reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed — is the server running?"));
    xhr.send(form);
  });
}

$("#new-edit").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.clips.length && !state.projectIds.size) return toast("Add at least one clip.");
  const options = {
    ...state.opts,
    vibe: $("#vibe").value,
    title: $("#title").value,
    look: $("#look").value,
    textStyle: $("#text-style").value,
    captions: $("#captions").checked,
    ideaIds: [...state.pickedIdeas],
    projectIds: [...state.projectIds],
    trackId: state.music ? null : $("#sound-select").value || null,
  };
  const form = new FormData();
  form.append("options", JSON.stringify(options));
  state.clips.forEach((f) => form.append("videos", f));
  if (state.music) form.append("music", state.music);

  const go = $("#go");
  const bar = $("#upload-progress");
  go.disabled = true;
  bar.hidden = false;
  const setBar = (f) => {
    bar.querySelector("i").style.width = `${Math.round(f * 100)}%`;
    bar.querySelector("span").textContent = f < 1 ? `Uploading… ${Math.round(f * 100)}%` : "Starting the edit…";
  };
  setBar(0);
  try {
    const edit = await uploadForm("api/edits", form, setBar);
    state.clips = [];
    state.music = null;
    state.projectIds.clear();
    renderClips();
    renderMusic();
    renderLibrary();
    state.edits.set(edit.id, edit);
    await refreshEdits();
    toast("Edit started", true);
  } catch (err) {
    toast(err.message);
  } finally {
    go.disabled = false;
    bar.hidden = true;
  }
});

// ---------- edits feed ----------

const ratio = (aspect) => `r${String(aspect || "9:16").replace(":", "x")}`;
const lookLabel = (id) => state.config?.looks[id]?.label || id;

function mediaHtml(edit) {
  const v = edit.versions.find((x) => x.n === edit.current);
  if (v) return `<video src="media/${edit.id}/${v.file}?t=${encodeURIComponent(v.createdAt)}" controls playsinline loop preload="metadata"></video>`;
  if (edit.status === "error" || edit.status === "cancelled") return `<div class="wait">No video yet</div>`;
  return `<div class="wait"><b>${edit.progress || 0}%</b>${esc(edit.status)}</div>`;
}

function statusHtml(edit) {
  const busy = BUSY.includes(edit.status);
  const v = edit.versions.find((x) => x.n === edit.current);
  const plan = edit.plan;
  const meta = v
    ? [`${v.length.toFixed(1)}s`, edit.options?.aspect, `${v.shots} shots`, lookLabel(v.look), v.bpm ? `${Math.round(v.bpm)} BPM` : null, `${edit.sources.length} source${edit.sources.length > 1 ? "s" : ""}`, v.mode === "claude" ? "directed by Claude" : "heuristic cut", `rendered in ${v.renderSeconds}s`].filter(Boolean)
    : [`${edit.sources.length} source${edit.sources.length > 1 ? "s" : ""}`, edit.options?.aspect, `${edit.options?.length}s target`];
  return `
    <header><h3>${esc(edit.name)}</h3><span class="status ${busy ? "busy" : edit.status}">${esc(edit.status)}</span></header>
    ${v?.concept ? `<p class="concept">${esc(v.concept)}</p>` : ""}
    ${v?.notice ? `<p class="notice">${esc(v.notice)}</p>` : ""}
    <div class="meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}</div>
    ${edit.error ? `<p class="err">${esc(edit.error)}</p>` : ""}
    ${busy ? `<div class="progress-row"><div class="bar"><i style="width:${edit.progress || 0}%"></i><span>${esc(edit.message || "")}</span></div><button class="btn danger" data-act="cancel">Stop</button></div>` : ""}
    ${edit.versions.length > 1 ? `<div class="versions">${edit.versions.map((x) => `<button data-act="version" data-n="${x.n}" class="${x.n === edit.current ? "on" : ""}">v${x.n}${x.rating === "fire" ? " 🔥" : ""}</button>`).join("")}</div>` : ""}
    <div class="actions">
      <button class="btn primary" data-act="reroll" ${busy ? "disabled" : ""}>↻ New cut</button>
      <button class="btn" data-act="refinish" ${busy || !plan ? "disabled" : ""}>Change look / text</button>
      ${v ? `<a class="btn" href="media/${edit.id}/${v.file}" download="${esc(edit.name)}-v${v.n}.mp4">Download</a>` : ""}
      <button class="btn ghost danger" data-act="delete">Delete</button>
    </div>
    ${v ? `<div class="rate"><span>Rate v${v.n}</span>${[["fire", "🔥 Fire"], ["good", "👍 Good"], ["meh", "😐 Meh"]].map(([r, l]) => `<button data-act="rate" data-r="${r}" class="${v.rating === r ? "on" : ""}">${l}</button>`).join("")}<input data-note placeholder="What worked or didn't? (teaches your style)" value="${esc(v.note || "")}"/></div>` : ""}`;
}

function shotsHtml(edit) {
  const plan = edit.plan;
  const v = edit.versions.at(-1);
  if (!plan || !v) return "";
  const wide = plan.width > plan.height;
  return `<details class="shots"><summary>Shot list · ${plan.shots.length} shots${plan.music ? ` on ${Math.round(plan.music.bpm)} BPM from ${plan.music.start.toFixed(1)}s` : ""}</summary><div class="strip">${plan.shots
    .map(
      (s, i) => `<div class="shot${wide ? " wide" : ""}" title="${esc(s.why || "")}"><img loading="lazy" src="media/${edit.id}/thumbs/shot-${i + 1}.jpg?v=${v.n}" alt=""/>
        <b>${s.source}${s.moment ? ` · ${esc(s.moment)}` : ""}</b> ${(s.slotEnd - s.slotStart).toFixed(2)}s<br/>
        ${i ? `<span class="tr">${esc(s.transition.type)}</span><br/>` : ""}${s.speed !== "normal" ? `${esc(s.speed)}<br/>` : ""}${s.effects.length ? `<span class="fx">${esc(s.effects.join(" + "))}</span>` : ""}${s.useAudio ? "<br/>🗣 dialogue" : ""}${s.text ? `<br/>“${esc(s.text)}”` : ""}</div>`,
    )
    .join("")}</div></details>`;
}

function refinishHtml(edit) {
  const o = edit.options || {};
  const p = edit.plan || {};
  const looks = Object.entries(state.config.looks).map(([id, l]) => `<option value="${id}" ${id === p.look ? "selected" : ""}>${esc(l.label)}</option>`).join("");
  const texts = Object.entries(state.config.textStyles).map(([id, t]) => `<option value="${id}" ${id === p.textStyle ? "selected" : ""}>${esc(t.label)}</option>`).join("");
  return `<form class="refinish" data-refinish>
    <label class="field"><span>Grade</span><select name="look">${looks}</select></label>
    <label class="field"><span>Grade strength</span><input name="lookIntensity" type="range" min="0" max="1.2" step="0.05" value="${p.lookIntensity ?? 0.85}"/></label>
    <label class="field"><span>Text style</span><select name="textStyle">${texts}</select></label>
    <label class="field"><span>Accent</span><input name="accent" value="#${esc(p.accent || "FFE600")}"/></label>
    <label class="field"><span>Title</span><input name="title" value="${esc(p.title || "")}"/></label>
    ${p.music ? `<label class="field"><span>Music starts at (s)</span><input name="musicStart" type="number" step="0.1" min="0" value="${p.music.start}"/></label>` : ""}
    <label class="field"><span>Sound effects</span><select name="sfx">${["full", "subtle", "off"].map((x) => `<option ${x === (o.sfx || "full") ? "selected" : ""}>${x}</option>`).join("")}</select></label>
    <label class="check"><input type="checkbox" name="captions" ${o.captions ? "checked" : ""}/> Captions on dialogue</label>
    <div class="row-end"><button type="button" class="btn ghost" data-act="close-refinish">Cancel</button><button class="btn primary">Re-render</button></div>
  </form>`;
}

function upsertCard(edit) {
  let card = state.cards.get(edit.id);
  if (!card) {
    const el = document.createElement("article");
    el.className = "edit";
    el.dataset.id = edit.id;
    el.innerHTML = `<div class="media"></div><div class="body"><div class="status-block"></div><div class="refinish-slot"></div><div class="shots-slot"></div></div>`;
    card = { el, keys: {} };
    state.cards.set(edit.id, card);
  }
  const v = edit.versions.find((x) => x.n === edit.current);
  const keys = {
    media: v ? `${v.file}:${v.createdAt}` : `${edit.status}:${edit.progress}`,
    status: JSON.stringify([edit.status, edit.progress, edit.message, edit.error, edit.current, edit.versions.map((x) => [x.n, x.rating]), edit.name]),
    shots: `${edit.versions.length}:${edit.plan?.shots?.length}`,
  };
  const media = $(".media", card.el);
  media.className = `media ${ratio(edit.options?.aspect)}`;
  if (keys.media !== card.keys.media) media.innerHTML = mediaHtml(edit);
  // Don't wipe a note the user is typing.
  const typing = card.el.contains(document.activeElement) && document.activeElement.matches("[data-note]");
  if (keys.status !== card.keys.status && !typing) $(".status-block", card.el).innerHTML = statusHtml(edit);
  if (keys.shots !== card.keys.shots) $(".shots-slot", card.el).innerHTML = shotsHtml(edit);
  card.keys = keys;
  return card.el;
}

async function refreshEdits() {
  let summaries;
  try {
    summaries = await api("api/edits");
  } catch {
    return;
  }
  const list = $("#edits");
  const ids = new Set(summaries.map((s) => s.id));
  for (const [id, card] of state.cards) if (!ids.has(id)) (card.el.remove(), state.cards.delete(id), state.edits.delete(id));
  for (const [i, s] of summaries.entries()) {
    const known = state.edits.get(s.id);
    if (!known || known.updatedAt !== s.updatedAt) state.edits.set(s.id, await api(`api/edits/${s.id}`).catch(() => known));
    const el = upsertCard(state.edits.get(s.id));
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
  }
  $("#empty").hidden = summaries.length > 0;
  clearTimeout(refreshEdits.timer);
  refreshEdits.timer = setTimeout(refreshEdits, summaries.some((s) => BUSY.includes(s.status)) ? 1500 : 6000);
}

$("#edits").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const card = b.closest(".edit");
  const id = card.dataset.id;
  const edit = state.edits.get(id);
  try {
    switch (b.dataset.act) {
      case "reroll":
        await api(`api/edits/${id}/reroll`, { method: "POST", body: {} });
        break;
      case "cancel":
        await api(`api/edits/${id}/cancel`, { method: "POST" });
        break;
      case "delete":
        if (!confirm(`Delete "${edit.name}" and all its versions?`)) return;
        await api(`api/edits/${id}`, { method: "DELETE" });
        break;
      case "version":
        await api(`api/edits/${id}/current`, { method: "POST", body: { version: Number(b.dataset.n) } });
        break;
      case "refinish":
        $(".refinish-slot", card).innerHTML = $(".refinish-slot", card).innerHTML ? "" : refinishHtml(edit);
        return;
      case "close-refinish":
        $(".refinish-slot", card).innerHTML = "";
        return;
      case "rate": {
        const note = $("[data-note]", card)?.value || "";
        await api(`api/edits/${id}/feedback`, { method: "POST", body: { version: edit.current, rating: b.dataset.r, note } });
        toast("Saved — your style guide learns from this", true);
        break;
      }
    }
    await refreshEdits();
  } catch (err) {
    toast(err.message);
  }
});

$("#edits").addEventListener("change", async (e) => {
  if (!e.target.matches("[data-note]")) return;
  const card = e.target.closest(".edit");
  const edit = state.edits.get(card.dataset.id);
  const v = edit.versions.find((x) => x.n === edit.current);
  if (!v?.rating) return; // the note is saved with the next rating click
  try {
    await api(`api/edits/${edit.id}/feedback`, { method: "POST", body: { version: v.n, rating: v.rating, note: e.target.value } });
    toast("Note saved", true);
  } catch (err) {
    toast(err.message);
  }
});

$("#edits").addEventListener("submit", async (e) => {
  if (!e.target.matches("[data-refinish]")) return;
  e.preventDefault();
  const f = new FormData(e.target);
  const card = e.target.closest(".edit");
  const body = {
    options: { look: f.get("look"), lookIntensity: Number(f.get("lookIntensity")), textStyle: f.get("textStyle"), accent: f.get("accent"), title: f.get("title"), sfx: f.get("sfx"), captions: f.get("captions") === "on" },
  };
  if (f.has("musicStart")) body.musicStart = Number(f.get("musicStart"));
  try {
    await api(`api/edits/${card.dataset.id}/rerender`, { method: "POST", body });
    $(".refinish-slot", card).innerHTML = "";
    await refreshEdits();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- style lab ----------

function renderIdeaChips() {
  const ready = state.ideas.filter((i) => i.status === "ready");
  $("#ideas-hint").textContent = ready.length ? (state.pickedIdeas.size ? "only the picked ones" : "none picked = learn from all") : "none yet — add some in Style Lab";
  $("#idea-chips").innerHTML = ready.map((i) => `<button type="button" class="chip ${state.pickedIdeas.has(i.id) ? "on" : ""}" data-idea="${i.id}">${esc(i.recipe?.name || i.title)}</button>`).join("");
}
$("#idea-chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-idea]");
  if (!b) return;
  state.pickedIdeas.has(b.dataset.idea) ? state.pickedIdeas.delete(b.dataset.idea) : state.pickedIdeas.add(b.dataset.idea);
  renderIdeaChips();
});

dropZone($("#drop-idea"), $("#idea-input"), (files) => {
  state.ideaFiles.push(...files.filter((f) => /^(video|image)\//.test(f.type) || /\.(mp4|mov|m4v|webm|jpe?g|png|webp|gif|heic)$/i.test(f.name)));
  $("#idea-files").textContent = state.ideaFiles.length ? state.ideaFiles.map((f) => f.name).join(", ") : "Videos get timed, color-measured and watched.";
  $("#drop-idea").classList.toggle("has", state.ideaFiles.length > 0);
});

$("#new-idea").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData();
  form.append("title", $("#idea-title").value);
  form.append("notes", $("#idea-notes").value);
  form.append("url", $("#idea-url").value);
  state.ideaFiles.forEach((f) => form.append("files", f));
  const button = e.target.querySelector(".go");
  button.disabled = true;
  try {
    await uploadForm("api/ideas", form, (f) => (button.textContent = f < 1 ? `Uploading ${Math.round(f * 100)}%` : "Adding…"));
    e.target.reset();
    state.ideaFiles = [];
    $("#idea-files").textContent = "Videos get timed, color-measured and watched.";
    $("#drop-idea").classList.remove("has");
    await refreshIdeas();
    toast("Idea added — modeling it now", true);
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
    button.textContent = "Add idea";
  }
});

function ideaHtml(idea) {
  const img = idea.media.find((m) => m.type === "image");
  const vid = idea.media.find((m) => m.type === "video");
  const bg = img ? `media-idea:${img.file}` : vid ? "sheet" : null;
  const thumbUrl = img ? `ideas-media/${idea.id}/${img.file}` : vid ? `ideas-media/${idea.id}/analysis-1/sheet-1.jpg` : null;
  const r = idea.recipe;
  const top = (list) => (list || []).slice().sort((a, b) => b.weight - a.weight).slice(0, 4).map((x) => x.type);
  const status = idea.status === "modeling" ? `<span class="chip static"><span class="spin"></span>modeling…</span>` : idea.status === "error" ? `<span class="chip static" style="color:var(--hot)">${esc(idea.error || "failed")}</span>` : "";
  return `<article class="idea" data-id="${idea.id}">
    ${bg ? `<div class="thumb" style="background-image:url('${thumbUrl}')"><span>${idea.media.length} reference${idea.media.length > 1 ? "s" : ""}</span></div>` : ""}
    <div class="inner">
      <h3>${esc(r?.name || idea.title)}</h3>
      ${status}
      ${r?.vibe ? `<p class="vibe">${esc(r.vibe)}</p>` : idea.notes ? `<p class="vibe">${esc(idea.notes.slice(0, 180))}</p>` : ""}
      ${r ? `<div class="chips">
        <span class="chip static">${esc(r.energy)}</span>
        <span class="chip static">${Number(r.beatsPerShot).toFixed(1)} beats/shot</span>
        <span class="chip static">${esc(lookLabel(r.look))}</span>
        ${r.text?.style && r.text.style !== "none" ? `<span class="chip static">${esc(state.config.textStyles[r.text.style]?.label || r.text.style)}</span>` : ""}
        ${top(r.transitions).map((t) => `<span class="chip static" style="color:var(--cyan)">${esc(t)}</span>`).join("")}
        ${top(r.effects).concat(top(r.speeds)).map((t) => `<span class="chip static" style="color:var(--accent)">${esc(t)}</span>`).join("")}
      </div>` : ""}
      ${idea.stats?.[0] ? `<div class="meta"><span>${idea.stats[0].cutsPerSecond} cuts/s</span><span>~${idea.stats[0].avgShotSeconds}s per shot</span>${idea.stats[0].bpm ? `<span>${Math.round(idea.stats[0].bpm)} BPM</span>` : ""}</div>` : ""}
      ${r?.rules?.length ? `<details><summary class="meta">${r.rules.length} rules</summary><ul>${r.rules.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}
      <div class="foot">
        <button class="btn ghost" data-act="remodel">Re-model</button>
        <button class="btn ghost danger" data-act="delete-idea">Delete</button>
      </div>
    </div>
  </article>`;
}

async function refreshIdeas() {
  try {
    state.ideas = await api("api/ideas");
  } catch {
    return;
  }
  $("#ideas").innerHTML = state.ideas.length ? state.ideas.map(ideaHtml).join("") : `<p class="empty">No style ideas yet. Your first one teaches every edit after it.</p>`;
  for (const id of state.pickedIdeas) if (!state.ideas.some((i) => i.id === id)) state.pickedIdeas.delete(id);
  renderIdeaChips();
  const modeling = state.ideas.some((i) => i.status === "modeling");
  clearTimeout(refreshIdeas.timer);
  if (modeling) refreshIdeas.timer = setTimeout(async () => {
    await refreshIdeas();
    if (!state.ideas.some((i) => i.status === "modeling")) loadStyle();
  }, 2000);
}

$("#ideas").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const id = b.closest(".idea").dataset.id;
  try {
    if (b.dataset.act === "remodel") await api(`api/ideas/${id}/remodel`, { method: "POST" });
    if (b.dataset.act === "delete-idea") {
      if (!confirm("Delete this style idea?")) return;
      await api(`api/ideas/${id}`, { method: "DELETE" });
    }
    await refreshIdeas();
  } catch (err) {
    toast(err.message);
  }
});

function markdown(md) {
  const lines = md.replace(/<!--[\s\S]*?-->/g, "").trim().split("\n");
  let html = "";
  let list = false;
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, "<code>$1</code>");
  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s+(.*)/);
    if (bullet) {
      if (!list) (html += "<ul>"), (list = true);
      html += `<li>${inline(bullet[1])}</li>`;
      continue;
    }
    if (list) (html += "</ul>"), (list = false);
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  if (list) html += "</ul>";
  return html;
}

async function loadStyle() {
  try {
    const { markdown: md } = await api("api/style");
    $("#style-md").innerHTML = md.trim() ? markdown(md) : `<p class="none">Add style ideas or rate a few edits and your style guide writes itself here.</p>`;
  } catch (err) {
    toast(err.message);
  }
}
$("#refresh-style").addEventListener("click", async (e) => {
  e.target.disabled = true;
  try {
    const { markdown: md } = await api("api/style/refresh", { method: "POST" });
    $("#style-md").innerHTML = md.trim() ? markdown(md) : `<p class="none">Nothing to learn from yet.</p>`;
  } catch (err) {
    toast(err.message);
  } finally {
    e.target.disabled = false;
  }
});

// ---------- boot ----------

(async function boot() {
  renderSegs();
  try {
    state.config = await api("api/config");
  } catch (err) {
    toast(err.message);
    return;
  }
  const d = $("#director");
  d.innerHTML = state.config.claude ? "Director: <b>Claude</b>" : "Director: <b>heuristic</b> · add ANTHROPIC_API_KEY for Claude";
  d.classList.toggle("demo", !state.config.claude);
  $("#look").innerHTML = `<option value="auto">Auto (match footage)</option>` + Object.entries(state.config.looks).map(([id, l]) => `<option value="${id}">${esc(l.label)}</option>`).join("");
  $("#text-style").innerHTML = `<option value="auto">Auto</option>` + Object.entries(state.config.textStyles).map(([id, t]) => `<option value="${id}">${esc(t.label)}</option>`).join("");
  renderMusic();
  await Promise.all([refreshEdits(), refreshIdeas(), loadSounds()]);
})();
