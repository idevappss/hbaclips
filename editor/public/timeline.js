// The multi-track timeline: ruler, track headers, clips (filmstrips, waveforms, caption and title blocks), the
// playhead, and every pointer gesture on them. Clips are keyed DOM nodes updated in place, and the playhead moves
// on its own, so scrubbing and playback never rebuild the tracks.
import * as M from "./model.js";
import { $, $$, I, clamp, esc, mod, r3, tc, tip } from "./ui.js";

const HEAD = 176; // track header column
const PAD = 18; // space before 0s
const ZOOM = { min: 4, max: 600 };
const HEIGHT = { text: 36, caption: 36, video: 62, audio: 46, overlay: 48, emphasis: 36 };
const KIND_ICON = { text: I.text, caption: I.captions, video: I.video, audio: I.audio, overlay: I.media, emphasis: I.sparkle };
const LAYOUT_LABEL = { full: "Full screen", split: "Side by side", pip: "Corner", card: "Card" };

export function createTimeline(root, store, ctx) {
  root.innerHTML = `
    <div class="tl-bar">
      <div class="tl-tools">
        <button class="tbtn" data-act="undo" title="${tip("Undo", `${mod}Z`)}">${I.undo(16)}</button>
        <button class="tbtn" data-act="redo" title="${tip("Redo", `${mod}⇧Z`)}">${I.redo(16)}</button>
        <span class="tl-sep"></span>
        <button class="tbtn lbl" data-act="split" title="${tip("Split at playhead", `${mod}B`)}">${I.split(16)}<span>Split</span></button>
        <button class="tbtn lbl" data-act="ripple" title="${tip("Delete and close the gap", "⇧Del")}">${I.ripple(16)}<span>Ripple</span></button>
        <button class="tbtn lbl" data-act="delete" title="${tip("Delete", "Del")}">${I.trash(16)}<span>Delete</span></button>
        <button class="tbtn" data-act="duplicate" title="${tip("Duplicate", `${mod}D`)}">${I.duplicate(16)}</button>
        <span class="tl-sep"></span>
        <button class="tbtn" data-act="link" title="${tip("Link or unlink picture and sound")}">${I.link(16)}</button>
        <button class="tbtn" disabled title="Detach audio · coming with audio editing">${I.detach(16)}</button>
        <button class="tbtn lbl" disabled title="Auto captions · coming with AI tools">${I.sparkle(16)}<span>Auto captions</span></button>
      </div>
      <div class="tl-zoom">
        <button class="tbtn on" data-act="snap" title="${tip("Snapping", "N")}">${I.magnet(16)}</button>
        <span class="tl-sep"></span>
        <button class="tbtn" data-act="zoom-out" title="${tip("Zoom out", "-")}">${I.zoomOut(16)}</button>
        <input type="range" class="tl-zoom-range" min="0" max="1000" step="1" aria-label="Timeline zoom" />
        <button class="tbtn" data-act="zoom-in" title="${tip("Zoom in", "=")}">${I.zoomIn(16)}</button>
        <button class="tbtn" data-act="fit" title="${tip("Fit to window", "⇧Z")}">${I.fit(16)}</button>
      </div>
    </div>
    <div class="tl-scroll">
      <div class="tl-canvas">
        <div class="tl-ruler"><div class="tl-corner"><span data-slot="time">00:00:00</span></div><div class="tl-ticks"></div></div>
        <div class="tl-rows"></div>
        <div class="tl-snapline" hidden></div>
        <div class="tl-playhead"><i></i></div>
      </div>
    </div>`;

  const scroll = $(".tl-scroll", root);
  const canvas = $(".tl-canvas", root);
  const rowsEl = $(".tl-rows", root);
  const ticks = $(".tl-ticks", root);
  const playhead = $(".tl-playhead", root);
  const snapline = $(".tl-snapline", root);
  const zoomRange = $(".tl-zoom-range", root);

  let zoom = 40; // px per second
  let fitted = false;
  let snapping = true;
  const rows = new Map(); // track id → { el, lane, clips: Map(id → { el, key }) }

  const x = (t) => PAD + t * zoom; // inside a lane
  const timeAt = (clientX) => {
    const lane = rowsEl.getBoundingClientRect();
    return Math.max(0, (clientX - lane.left - HEAD - PAD) / zoom);
  };

  // ---------- zoom ----------
  const toRange = (z) => Math.round((1000 * Math.log(z / ZOOM.min)) / Math.log(ZOOM.max / ZOOM.min));
  const fromRange = (v) => ZOOM.min * Math.pow(ZOOM.max / ZOOM.min, v / 1000);
  function setZoom(next, anchorClientX = null) {
    next = clamp(next, ZOOM.min, ZOOM.max);
    const view = scroll.getBoundingClientRect();
    const anchorX = anchorClientX ?? view.left + HEAD + (view.width - HEAD) / 2;
    const tAnchor = timeAt(anchorX);
    zoom = next;
    zoomRange.value = toRange(zoom);
    draw();
    // Keep the time under the cursor (or the middle of the view) in place.
    scroll.scrollLeft = Math.max(0, PAD + tAnchor * zoom - (anchorX - view.left - HEAD));
  }
  function fit() {
    const width = scroll.clientWidth - HEAD - PAD * 2;
    if (width <= 0) return;
    zoom = clamp(width / (M.duration(store.doc) * 1.03), ZOOM.min, ZOOM.max);
    zoomRange.value = toRange(zoom);
    scroll.scrollLeft = 0;
    draw();
  }
  zoomRange.addEventListener("input", () => setZoom(fromRange(Number(zoomRange.value))));
  scroll.addEventListener(
    "wheel",
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return; // plain wheel scrolls; pinch and ⌘-wheel zoom
      e.preventDefault();
      setZoom(zoom * Math.exp(-e.deltaY * 0.01), e.clientX);
    },
    { passive: false },
  );

  // ---------- ruler ----------
  function drawRuler(width) {
    const steps = [1 / 30, 2 / 30, 5 / 30, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    const major = steps.find((s) => s * zoom >= 84) || 300;
    const minor = major >= 1 ? major / (major % 2 === 0 || major === 5 ? 5 : 2) : major / 2;
    const seconds = width / zoom;
    const parts = [];
    for (let t = 0; t <= seconds; t += minor) {
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      const label = isMajor ? (major < 1 ? tc(t, { frames: true }) : tc(t)) : "";
      parts.push(`<i class="${isMajor ? "mj" : ""}" style="left:${x(t)}px">${label ? `<b>${label}</b>` : ""}</i>`);
    }
    ticks.innerHTML = parts.join("");
  }

  // ---------- tracks & clips ----------
  function headHtml(track) {
    const toggles = [
      track.kind === "audio" ? `<button class="hbtn ${track.muted ? "on" : ""}" data-toggle="muted" title="${track.muted ? "Unmute" : "Mute"}">${(track.muted ? I.volumeOff : I.volume)(14)}</button>` : `<button class="hbtn ${track.hidden ? "on" : ""}" data-toggle="hidden" title="${track.hidden ? "Show" : "Hide"}">${(track.hidden ? I.eyeOff : I.eye)(14)}</button>`,
      `<button class="hbtn ${track.locked ? "on" : ""}" data-toggle="locked" title="${track.locked ? "Unlock" : "Lock"}">${(track.locked ? I.lock : I.unlock)(14)}</button>`,
    ];
    return `<span class="th-icon">${KIND_ICON[track.kind](15)}</span><span class="th-name">${esc(track.name)}</span><span class="th-tools">${toggles.join("")}</span>`;
  }

  function clipKey(track, clip) {
    const base = `${zoom}|${clip.duration}|${track.hidden}|${track.muted}`;
    if (clip.type === "video") return `${base}|${clip.sourceStart}|${clip.speed}`;
    if (clip.type === "audio") return `${base}|${clip.sourceStart}|${clip.sound || ""}|${clip.volume}|${ctx.peaks(clip) ? 1 : 0}`;
    if (clip.type === "caption") return `${base}|${clip.words.map((w) => w.text).join(" ")}`;
    if (clip.type === "overlay") return `${base}|${clip.asset}|${clip.page}|${clip.layout}|${clip.side}|${ctx.uploads?.get(clip.asset)?.status || ""}`;
    if (clip.type === "emphasis") return `${base}|${clip.text}|${ctx.mattes?.[clip.id]?.state || ""}`;
    return `${base}|${clip.content}`;
  }

  function clipInner(track, clip, width) {
    const handles = `<i class="tl-h l" data-edge="start"></i><i class="tl-h r" data-edge="end"></i>`;
    if (clip.type === "video") {
      const tileW = 62 * ctx.sourceAspect;
      const count = Math.min(240, Math.max(1, Math.ceil(width / tileW)));
      const tiles = Array.from({ length: count }, (_, i) => {
        const sec = Math.floor(clip.sourceStart + ((i + 0.5) * tileW * (clip.speed || 1)) / zoom);
        return `<img src="${ctx.thumbUrl(sec)}" loading="lazy" decoding="async" draggable="false" alt="" style="width:${tileW}px" />`;
      }).join("");
      return `<div class="tl-film">${tiles}</div>${handles}`;
    }
    if (clip.type === "audio") {
      const label = clip.sound ? clip.name || "Music" : "Original audio";
      return `<canvas class="tl-wave"></canvas><span class="tl-label">${(clip.sound ? I.audio : I.volume)(12)}${esc(label)}</span>${handles}`;
    }
    if (clip.type === "caption") return `<span class="tl-label">${esc(clip.words.map((w) => w.text).join(" "))}</span>${handles}`;
    if (clip.type === "overlay") {
      const u = ctx.uploads?.get(clip.asset);
      const slide = clip.source === "slide" ? u?.slides?.find((x) => x.page === clip.page) : null;
      const src = slide?.src || u?.poster;
      const what = clip.source === "slide" ? `Slide ${clip.page}` : clip.source === "broll" ? "B-roll" : "Phone";
      return `${src ? `<img class="tl-ov-thumb" src="${esc(src)}" alt="" draggable="false" />` : ""}<span class="tl-label"><b>${what}</b>${esc(LAYOUT_LABEL[clip.layout] || "")}${u ? "" : " · missing upload"}</span>${handles}`;
    }
    if (clip.type === "emphasis") {
      const m = ctx.mattes?.[clip.id]?.state;
      const dot = m === "done" ? "" : m === "queued" || m === "running" ? `<i class="tl-dot busy" title="Cutting out the speaker so the words sit behind them"></i>` : m === "error" ? `<i class="tl-dot err" title="Couldn't cut out the speaker here, so the words sit in front"></i>` : "";
      return `<span class="tl-label">${I.sparkle(12)}${esc(clip.text || "Big caption")}${dot}</span>${handles}`;
    }
    return `<span class="tl-label">${I.text(12)}${esc(clip.content || "Text")}</span>${handles}`;
  }

  function drawWave(canvasEl, clip, width, height) {
    const peaks = ctx.peaks(clip);
    if (!peaks) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.min(Math.round(width), 8000));
    canvasEl.width = Math.round(w * dpr);
    canvasEl.height = Math.round(height * dpr);
    const g = canvasEl.getContext("2d");
    g.scale(dpr, dpr);
    g.fillStyle = getComputedStyle(canvasEl).color;
    const { data, rate, length } = peaks;
    const gain = Math.min(1.6, 0.6 + (clip.volume ?? 1));
    const mid = height / 2;
    const step = 2;
    for (let px = 0; px < w; px += step) {
      const t0 = ((px / w) * clip.duration) * (clip.speed || 1);
      const t1 = (((px + step) / w) * clip.duration) * (clip.speed || 1);
      let i0 = Math.floor((clip.sourceStart + t0) * rate);
      let i1 = Math.max(i0 + 1, Math.floor((clip.sourceStart + t1) * rate));
      let peak = 0;
      for (let i = i0; i < i1; i++) peak = Math.max(peak, data[length ? i % length : i] || 0);
      const h = Math.max(1, (peak / 255) * (height * 0.46) * gain);
      g.fillRect(px, mid - h, step - 0.6, h * 2);
    }
  }

  function draw() {
    const doc = store.doc;
    const total = M.duration(doc);
    const width = Math.max(scroll.clientWidth - HEAD, x(total) + Math.max(240, (scroll.clientWidth - HEAD) * 0.4));
    canvas.style.width = `${HEAD + width}px`;
    drawRuler(width);
    const selected = new Set(store.selection);

    const seen = new Set();
    doc.tracks.forEach((track, order) => {
      seen.add(track.id);
      let row = rows.get(track.id);
      if (!row) {
        const el = document.createElement("div");
        el.className = "tl-row";
        el.dataset.track = track.id;
        el.innerHTML = `<div class="tl-head"></div><div class="tl-lane"></div>`;
        row = { el, head: $(".tl-head", el), lane: $(".tl-lane", el), clips: new Map(), headKey: "" };
        rows.set(track.id, row);
      }
      if (rowsEl.children[order] !== row.el) rowsEl.insertBefore(row.el, rowsEl.children[order] || null);
      row.el.dataset.kind = track.kind;
      row.el.dataset.role = track.role || "";
      row.el.style.height = `${HEIGHT[track.kind]}px`;
      row.el.classList.toggle("is-hidden", track.hidden || track.muted);
      row.el.classList.toggle("is-locked", track.locked);
      const headKey = `${track.name}|${track.hidden}|${track.muted}|${track.locked}`;
      if (row.headKey !== headKey) {
        row.head.innerHTML = headHtml(track);
        row.headKey = headKey;
      }

      const live = new Set();
      for (const clip of track.clips) {
        live.add(clip.id);
        let item = row.clips.get(clip.id);
        if (!item) {
          const el = document.createElement("div");
          el.className = `tl-clip k-${clip.type}${clip.sound ? " k-music" : ""}`;
          el.dataset.id = clip.id;
          row.lane.append(el);
          item = { el, key: "" };
          row.clips.set(clip.id, item);
        }
        const left = x(clip.start);
        const w = Math.max(2, clip.duration * zoom);
        item.el.style.transform = `translateX(${left}px)`;
        item.el.style.width = `${w}px`;
        item.el.classList.toggle("sel", selected.has(clip.id));
        item.el.classList.toggle("narrow", w < 26);
        const key = clipKey(track, clip);
        if (item.key !== key) {
          item.el.innerHTML = clipInner(track, clip, w);
          item.key = key;
          const wave = $(".tl-wave", item.el);
          if (wave) drawWave(wave, clip, w, HEIGHT[track.kind] - 8);
        }
      }
      for (const [id, item] of row.clips) {
        if (!live.has(id)) {
          item.el.remove();
          row.clips.delete(id);
        }
      }
    });
    for (const [id, row] of rows) {
      if (!seen.has(id)) {
        row.el.remove();
        rows.delete(id);
      }
    }
    movePlayhead();
    syncButtons();
  }

  function markSelection() {
    const selected = new Set(store.selection);
    for (const row of rows.values()) for (const [id, item] of row.clips) item.el.classList.toggle("sel", selected.has(id));
    syncButtons();
  }

  function syncButtons() {
    const has = store.selection.length > 0;
    const act = (name) => $(`[data-act="${name}"]`, root);
    act("undo").disabled = !store.canUndo();
    act("redo").disabled = !store.canRedo();
    act("undo").title = store.canUndo() ? tip(`Undo ${store.undoLabel()}`, `${mod}Z`) : "Nothing to undo";
    act("redo").title = store.canRedo() ? tip(`Redo ${store.redoLabel()}`, `${mod}⇧Z`) : "Nothing to redo";
    for (const name of ["ripple", "delete", "duplicate"]) act(name).disabled = !has;
    const hit = has ? M.locate(store.doc, store.selection[0]) : null;
    act("link").disabled = !hit || !M.isMedia(hit.clip);
    act("link").classList.toggle("on", Boolean(hit?.clip.link));
  }

  // ---------- playhead ----------
  function movePlayhead() {
    const px = HEAD + x(store.time);
    playhead.style.transform = `translateX(${px}px)`;
    $('[data-slot="time"]', root).textContent = tc(store.time, { frames: true });
  }
  function follow() {
    if (!store.playing || store.dragging) return;
    const px = x(store.time);
    const view = scroll.clientWidth - HEAD;
    if (px > scroll.scrollLeft + view - 40 || px < scroll.scrollLeft) scroll.scrollLeft = Math.max(0, px - 60);
  }

  // ---------- gestures ----------
  const within = () => 8 / zoom;
  const showSnap = (t) => {
    snapline.hidden = t === null;
    if (t !== null) snapline.style.transform = `translateX(${HEAD + x(t)}px)`;
  };

  function scrub(e) {
    const seek = (ev) => {
      let t = timeAt(ev.clientX);
      if (snapping && !ev.altKey) {
        const snapped = M.snapTo(M.snapPoints(store.doc), t, within());
        t = snapped.t;
      }
      ctx.seek(Math.min(t, M.duration(store.doc)));
    };
    seek(e);
    const up = () => {
      window.removeEventListener("pointermove", seek);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("tl-grabbing");
    };
    window.addEventListener("pointermove", seek);
    window.addEventListener("pointerup", up);
    document.body.classList.add("tl-grabbing");
  }

  function dragClip(e, clipEl, edge) {
    const id = clipEl.dataset.id;
    const hit = M.locate(store.doc, id);
    if (!hit || hit.track.locked) return;
    const startX = e.clientX;
    const origin = { start: hit.clip.start, end: M.end(hit.clip) };
    const exclude = new Set(M.group(store.doc, id).map((m) => m.clip.id));
    const points = M.snapPoints(store.doc, { exclude, playhead: store.time });
    let active = false;

    const moveTo = (ev) => {
      const dt = (ev.clientX - startX) / zoom;
      if (!active) {
        if (Math.abs(ev.clientX - startX) < 3) return;
        active = true;
        store.gesture.begin();
        document.body.classList.add(edge ? "tl-trimming" : "tl-grabbing");
      }
      const snap = snapping && !ev.altKey;
      let at = null;
      if (edge === "start") {
        let t = origin.start + dt;
        if (snap) ({ t, at } = M.snapTo(points, t, within()));
        store.gesture.update((doc) => M.trimStart(doc, id, t));
      } else if (edge === "end") {
        let t = origin.end + dt;
        if (snap) ({ t, at } = M.snapTo(points, t, within()));
        store.gesture.update((doc) => M.trimEnd(doc, id, t, { sourceDuration: ctx.sourceDuration }));
      } else {
        let t = origin.start + dt;
        if (snap) {
          const a = M.snapTo(points, t, within());
          const b = M.snapTo(points, t + (origin.end - origin.start), within());
          if (a.at !== null && (b.at === null || Math.abs(a.t - t) <= Math.abs(b.t - (t + origin.end - origin.start)))) ({ t, at } = a);
          else if (b.at !== null) {
            t = b.t - (origin.end - origin.start);
            at = b.at;
          }
        }
        store.gesture.update((doc) => M.move(doc, id, t));
      }
      showSnap(at);
      if (edge) ctx.seek(edge === "start" ? M.locate(store.doc, id)?.clip.start ?? store.time : Math.max(0, (M.locate(store.doc, id) ? M.end(M.locate(store.doc, id).clip) : store.time) - M.FRAME), { quiet: true });
    };
    const up = () => {
      window.removeEventListener("pointermove", moveTo);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", esc_);
      document.body.classList.remove("tl-grabbing", "tl-trimming");
      showSnap(null);
      if (active) store.gesture.end(edge ? "trim" : "move");
    };
    const esc_ = (ev) => {
      if (ev.key !== "Escape") return;
      store.gesture.cancel();
      active = false;
      up();
    };
    window.addEventListener("pointermove", moveTo);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", esc_);
  }

  rowsEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const toggle = e.target.closest("[data-toggle]");
    if (toggle) {
      const trackId = toggle.closest(".tl-row").dataset.track;
      const key = toggle.dataset.toggle;
      store.commit(`${key === "locked" ? "lock" : key === "muted" ? "mute" : "hide"} track`, (doc) => {
        const track = doc.tracks.find((t) => t.id === trackId);
        track[key] = !track[key];
      });
      return;
    }
    if (e.target.closest(".tl-head")) return;
    const clipEl = e.target.closest(".tl-clip");
    if (!clipEl) {
      store.select([]);
      return scrub(e);
    }
    e.preventDefault();
    const id = clipEl.dataset.id;
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      store.select(store.selection.includes(id) ? store.selection.filter((s) => s !== id) : [...store.selection, id]);
      return;
    }
    if (!store.selection.includes(id)) store.select([id]);
    dragClip(e, clipEl, e.target.dataset.edge || null);
  });
  rowsEl.addEventListener("dblclick", (e) => {
    const clipEl = e.target.closest(".tl-clip");
    if (clipEl) ctx.seek(M.locate(store.doc, clipEl.dataset.id)?.clip.start ?? store.time);
  });
  rowsEl.addEventListener("contextmenu", (e) => {
    const clipEl = e.target.closest(".tl-clip");
    if (!clipEl) return;
    e.preventDefault();
    if (!store.selection.includes(clipEl.dataset.id)) store.select([clipEl.dataset.id]);
    ctx.contextMenu(e.clientX, e.clientY);
  });
  $(".tl-ruler", root).addEventListener("pointerdown", (e) => e.button === 0 && scrub(e));

  $(".tl-bar", root).addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === "zoom-in") return setZoom(zoom * 1.5);
    if (act === "zoom-out") return setZoom(zoom / 1.5);
    if (act === "fit") return fit();
    if (act === "snap") {
      snapping = !snapping;
      btn.classList.toggle("on", snapping);
      return;
    }
    ctx.actions[act]?.();
  });

  // ---------- wiring ----------
  const offs = [
    store.on("doc", draw),
    store.on("selection", markSelection),
    store.on("history", syncButtons),
    store.on("time", () => {
      movePlayhead();
      follow();
    }),
  ];
  const resize = new ResizeObserver(() => {
    if (!fitted && scroll.clientWidth > HEAD + 100) {
      fitted = true;
      fit();
    } else draw();
  });
  resize.observe(scroll);

  return {
    draw,
    fit,
    timeAt,
    zoomBy: (f) => setZoom(zoom * f),
    toggleSnap: () => $('[data-act="snap"]', root).click(),
    destroy() {
      offs.forEach((off) => off());
      resize.disconnect();
    },
  };
}
