// VideoEditor: the "Preview & Edit" workspace for one clip. app.js mounts it at #/edit/<project>/<clip>.
//   header · tool rail + asset panel · canvas · inspector · timeline
import { createAssets } from "./assets.js";
import { createCanvas } from "./canvas.js";
import { createHeader } from "./header.js";
import { createInspector } from "./inspector.js";
import * as M from "./model.js";
import { createStore } from "./store.js";
import { createTimeline } from "./timeline.js";
import { $, I, api, clamp, esc, mod, r3 } from "./ui.js";

const css = new URL("./editor.css", import.meta.url).href;
const SIZES = { left: [240, 420, 300], right: [300, 440, 340], bottom: [220, 560, 340] };

export async function mountEditor(root, { projectId, clipId }) {
  if (!document.querySelector(`link[data-editor-css]`)) document.head.insertAdjacentHTML("beforeend", `<link rel="stylesheet" href="${css}" data-editor-css />`);
  document.body.classList.add("editor-mode");
  root.innerHTML = `<div class="ve ve-loading"><div class="ve-boot"><span class="spinner"></span><p>Opening the editor…</p></div></div>`;

  const base = `/api/editor/projects/${projectId}/clips/${clipId}`;
  let data;
  try {
    data = await api(base);
  } catch (err) {
    root.innerHTML = `<div class="ve ve-loading"><div class="ve-boot"><p>${esc(err.message)}</p><a class="btn-ghost" href="#/p/${esc(projectId)}">${I.back(15)}<span>Back to project</span></a></div></div>`;
    return () => document.body.classList.remove("editor-mode");
  }

  const sizes = readSizes();
  root.innerHTML = `
    <div class="ve" style="--ve-left:${sizes.left}px;--ve-right:${sizes.right}px;--ve-bottom:${sizes.bottom}px">
      <header class="ve-header"></header>
      <nav class="ve-rail"></nav>
      <aside class="ve-assets"></aside>
      <div class="ve-resize v" data-resize="left"></div>
      <main class="ve-canvas"></main>
      <div class="ve-resize v" data-resize="right"></div>
      <aside class="ve-inspector"></aside>
      <div class="ve-resize h" data-resize="bottom"></div>
      <section class="ve-timeline"></section>
      <div class="ve-toast" hidden></div>
      <div class="ve-menu" hidden></div>
      <div class="ve-modal-host"></div>
    </div>`;
  const shell = $(".ve", root);

  // ---------- state ----------
  const store = createStore({
    document: data.document,
    save: async (doc, baseRev) => {
      try {
        return await api(`${base}/document`, { method: "PUT", body: { document: doc, baseRev } });
      } catch (err) {
        if (err.status === 409 && err.data?.document) {
          store.replace(err.data.document);
          toast("This clip changed in another tab, so that version is loaded now");
          return { rev: err.data.document.rev, savedAt: err.data.document.savedAt };
        }
        throw err;
      }
    },
  });

  // ---------- media for the timeline ----------
  const peakCache = new Map();
  function loadPeaks(key, url) {
    if (peakCache.has(key)) return;
    peakCache.set(key, null);
    fetch(url)
      .then(async (res) => {
        if (!res.ok || res.status === 204) return;
        const rate = Number(res.headers.get("X-Peak-Rate")) || 50;
        peakCache.set(key, { data: new Uint8Array(await res.arrayBuffer()), rate });
        timeline.draw();
      })
      .catch(() => {});
  }

  const ctx = {
    context: data,
    sourceDuration: data.project.source.duration || Infinity,
    sourceAspect: data.project.source.width && data.project.source.height ? data.project.source.width / data.project.source.height : 16 / 9,
    previewUrl: `${base}/preview`,
    sounds: new Map(),
    thumbUrl: (sec) => `/api/editor/projects/${projectId}/thumbs/${Math.max(0, sec)}`,
    peaks(clip) {
      if (clip.sound) {
        loadPeaks(`s:${clip.sound}`, `/api/editor/sounds/${clip.sound}/peaks`);
        const p = peakCache.get(`s:${clip.sound}`);
        // Background music loops, so its waveform wraps around too.
        return p ? { ...p, length: clip.loop ? p.data.length : 0 } : null;
      }
      loadPeaks("source", `/api/editor/projects/${projectId}/peaks`);
      const p = peakCache.get("source");
      return p ? { ...p, length: 0 } : null;
    },
    seek: (t, opts) => canvas.seek(t, opts),
    openClip: async (id) => {
      await store.flush();
      location.hash = `#/edit/${projectId}/${id}`;
    },
    contextMenu: (x, y) => openMenu(x, y),
    actions: {},
  };

  // ---------- actions (toolbar, shortcuts, menus) ----------
  let clipboard = null;
  const selectionOr = (fallback) => (store.selection.length ? store.selection : fallback());
  const videoUnderPlayhead = () => {
    const ids = store.doc.tracks.filter((t) => !t.locked && (t.kind === "video" || t.role === "voice")).map((t) => M.clipAt(t, store.time)?.id).filter(Boolean);
    return ids.slice(0, 1);
  };

  const actions = (ctx.actions = {
    undo: () => {
      const label = store.undo();
      if (label) toast(`Undid ${label}`);
    },
    redo: () => {
      const label = store.redo();
      if (label) toast(`Redid ${label}`);
    },
    split() {
      const t = M.snapFrame(store.time);
      const ids = selectionOr(videoUnderPlayhead).filter((id) => {
        const hit = M.locate(store.doc, id);
        return hit && t > hit.clip.start && t < M.end(hit.clip);
      });
      if (!ids.length) return toast("Put the playhead over a clip to split it");
      let made = [];
      store.commit("split", (doc) => {
        const done = new Set();
        for (const id of ids) {
          if (done.has(id)) continue;
          M.group(doc, id).forEach((m) => done.add(m.clip.id));
          made = made.concat(M.split(doc, id, t));
        }
        return made.length > 0;
      });
    },
    delete() {
      if (!store.selection.length) return;
      store.commit("delete", (doc) => M.remove(doc, store.selection));
      store.select([]);
    },
    ripple() {
      if (!store.selection.length) return;
      store.commit("ripple delete", (doc) => M.rippleRemove(doc, store.selection));
      store.select([]);
    },
    duplicate() {
      if (!store.selection.length) return;
      let made = [];
      store.commit("duplicate", (doc) => (made = M.duplicate(doc, store.selection)).length > 0);
      if (made.length) store.select(made);
      else toast("There's no room on that track for a copy");
    },
    copy() {
      if (!store.selection.length) return;
      clipboard = M.expand(store.doc, store.selection).map(({ track, clip }) => ({ trackId: track.id, clip: structuredClone(clip) }));
      toast(`Copied ${clipboard.length === 1 ? "1 clip" : `${clipboard.length} clips`}`);
    },
    paste() {
      if (!clipboard?.length) return;
      let made = [];
      store.commit("paste", (doc) => {
        const first = Math.min(...clipboard.map((c) => c.clip.start));
        const links = new Map();
        for (const { trackId, clip } of clipboard) {
          const track = doc.tracks.find((t) => t.id === trackId);
          if (!track || track.locked) continue;
          const copy = structuredClone(clip);
          copy.id = M.newId(doc, clip.id.replace(/\d+$/, "").slice(0, 6) || "x");
          if (clip.link) {
            if (!links.has(clip.link)) links.set(clip.link, M.newId(doc, "l"));
            copy.link = links.get(clip.link);
          }
          if (M.place(doc, track, copy, store.time + (clip.start - first))) made.push(copy.id);
        }
        return made.length > 0;
      });
      if (made.length) store.select(made);
    },
    link() {
      const hit = store.selection.length ? M.locate(store.doc, store.selection[0]) : null;
      if (!hit || !M.isMedia(hit.clip)) return;
      if (hit.clip.link) {
        store.commit("unlink", (doc) => {
          const link = M.locate(doc, hit.clip.id).clip.link;
          for (const { clip } of M.allClips(doc)) if (clip.link === link) delete clip.link;
        });
        return toast("Picture and sound unlinked");
      }
      // Relink: pair it with the clip on the other media track that lines up with it.
      store.commit("link", (doc) => {
        const me = M.locate(doc, hit.clip.id).clip;
        const other = M.allClips(doc).find(({ track, clip }) => clip.id !== me.id && M.isMedia(clip) && !clip.sound && track.kind !== hit.track.kind && Math.abs(clip.start - me.start) < 0.05 && Math.abs(clip.duration - me.duration) < 0.05);
        if (!other) return false;
        me.link = other.clip.link = M.newId(doc, "l");
      }) ? toast("Linked") : toast("Line up a video piece and its audio to link them");
    },
    reset: async () => {
      if (!confirm("Put this clip back to the AI's edit? Your timeline changes go (you can undo right after).")) return;
      try {
        const { document: fresh } = await api(`${base}/document`, { method: "DELETE" });
        store.commit("reset to AI edit", (doc) => {
          doc.tracks = fresh.tracks;
          doc.design = fresh.design;
          doc.aspect = fresh.aspect;
        });
        store.select([]);
      } catch (err) {
        toast(err.message);
      }
    },
    addText(kind) {
      let id = null;
      store.commit("add text", (doc) => {
        const track = doc.tracks.find((t) => t.kind === "text");
        if (!track) return false;
        const clip = { id: M.newId(doc, "t"), type: "text", start: r3(store.time), duration: 3, content: kind === "title" ? "Your hook headline" : "Text", highlight: "", style: { preset: "plain" } };
        if (!M.place(doc, track, clip, store.time)) return false;
        id = clip.id;
      });
      if (id) store.select([id]);
      else toast("No room on the Titles track there");
    },
    useSound(soundId, at = null) {
      const sound = ctx.sounds.get(soundId);
      if (!sound) return;
      store.commit("set music", (doc) => {
        const track = doc.tracks.find((t) => t.kind === "audio" && t.role === "music");
        if (!track || track.locked) return false;
        const old = track.clips[0];
        const total = M.duration(doc);
        const start = at ?? 0;
        track.clips = [{ id: M.newId(doc, "m"), type: "audio", start: r3(start), duration: r3(Math.max(1, total - start)), sourceStart: 0, sourceEnd: r3(Math.min(sound.duration || total, total)), speed: 1, volume: old?.volume ?? 0.13, sound: sound.id, name: sound.name, loop: true }];
        track.muted = false;
      });
      toast(`Background music: ${sound.name}`);
    },
    classic: async () => {
      await store.flush();
      location.hash = `#/p/${projectId}?edit=${clipId}`;
    },
    share: async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        toast("Link to this editor copied");
      } catch {
        toast("Couldn't reach the clipboard");
      }
    },
    export: () => openExport(),

    // ---------- director ----------
    async runDirector({ want, note }) {
      ctx.director = { state: "running" };
      assets.draw();
      try {
        await store.flush();
        const plan = await api(`${base}/director`, { method: "POST", body: { document: store.doc, want, note } });
        store.commit("AI edit", (doc) => {
          const keep = doc.tracks.filter((t) => t.kind !== "overlay" && t.kind !== "emphasis");
          doc.tracks = [...plan.tracks, ...keep];
        });
        const count = plan.tracks.reduce((n, t) => n + t.clips.length, 0);
        ctx.director = { state: "done", message: `${plan.concept || ""}${plan.notice ? ` ${plan.notice}` : ""} ${count ? `${count} overlay${count === 1 ? "" : "s"} added to the timeline. Undo removes them.` : "Nothing matched well enough to add."}`.trim() };
        toast(count ? `AI edit: ${count} overlay${count === 1 ? "" : "s"} on the timeline` : "The director didn't find anything to add");
        watchMattes();
      } catch (err) {
        ctx.director = { state: "error", message: err.message };
      }
      assets.draw();
    },
    addOverlay({ asset, page = null }) {
      const u = ctx.uploads?.get(asset);
      if (!u || u.status !== "ready") return toast("That upload is still processing");
      let id = null;
      store.commit(u.kind === "video" ? "add recording" : "add slide", (doc) => {
        const track = ensureTrack(doc, "overlay");
        if (track.locked) return false;
        const video = u.kind === "video";
        const duration = video ? Math.min(u.duration || 6, u.role === "broll" ? 5 : 12) : 5;
        const clip = { id: M.newId(doc, "o"), type: "overlay", start: r3(store.time), duration: r3(duration), source: video ? (u.role === "broll" ? "broll" : "screen") : "slide", asset: u.id, name: u.name, layout: video ? (u.role === "broll" ? "full" : "split") : "split", side: "right", ...(video ? { sourceStart: 0 } : { page }) };
        if (!M.place(doc, track, clip, store.time)) return false;
        id = clip.id;
      });
      if (id) store.select([id]);
      else toast("There's already an overlay at the playhead. Move the playhead to a free spot.");
    },
    addEmphasis() {
      let id = null;
      store.commit("add big caption", (doc) => {
        const track = ensureTrack(doc, "emphasis");
        if (track.locked) return false;
        const clip = { id: M.newId(doc, "e"), type: "emphasis", start: r3(store.time), duration: 2.5, text: "Your key line" };
        if (!M.place(doc, track, clip, store.time)) return false;
        id = clip.id;
      });
      if (id) {
        store.select([id]);
        watchMattes();
      } else toast("There's already a big caption at the playhead");
    },
  });

  function ensureTrack(doc, kind) {
    let track = doc.tracks.find((t) => t.kind === kind);
    if (!track) {
      track = kind === "overlay" ? { id: "overlays", kind, name: "Overlays", hidden: false, locked: false, clips: [] } : { id: "emphasis", kind, name: "Big captions", hidden: false, locked: false, clips: [] };
      const at = kind === "overlay" ? 0 : doc.tracks.findIndex((t) => t.kind === "overlay") + 1;
      doc.tracks.splice(at, 0, track);
    }
    return track;
  }

  // Person cutouts behind big captions are made on the server after a save; the preview reloads when one lands.
  let matteTimer = 0;
  let mattesDone = "";
  function watchMattes() {
    clearTimeout(matteTimer);
    const has = store.doc.tracks.some((t) => t.kind === "emphasis" && t.clips.length);
    if (!has) return;
    matteTimer = setTimeout(async () => {
      try {
        await store.flush();
        const { mattes } = await api(`${base}/mattes`);
        const states = Object.values(mattes);
        const done = states.filter((m) => m.state === "done").map((m) => m.file).sort().join();
        if (mattesDone && done !== mattesDone) canvas.reload();
        mattesDone = done;
        ctx.mattes = mattes;
        timeline.draw();
        if (states.some((m) => m.state === "queued" || m.state === "running")) watchMattes();
      } catch {
        watchMattes();
      }
    }, 2500);
  }
  store.on("saved", () => watchMattes());
  ctx.toast = (text) => toast(text);

  // ---------- views ----------
  const header = createHeader($(".ve-header", shell), store, ctx);
  const assets = createAssets($(".ve-rail", shell), $(".ve-assets", shell), store, ctx);
  const canvas = createCanvas($(".ve-canvas", shell), store, ctx);
  const inspector = createInspector($(".ve-inspector", shell), store, ctx);
  const timeline = createTimeline($(".ve-timeline", shell), store, ctx);
  timeline.draw();
  watchMattes();

  // Sounds dragged in from the media panel become the background music, starting where they're dropped.
  const lanes = $(".tl-rows", shell);
  lanes.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("application/x-clip-sound")) return;
    e.preventDefault();
    lanes.classList.add("drop");
  });
  lanes.addEventListener("dragleave", () => lanes.classList.remove("drop"));
  lanes.addEventListener("drop", (e) => {
    lanes.classList.remove("drop");
    const id = e.dataTransfer.getData("application/x-clip-sound");
    if (!id) return;
    e.preventDefault();
    actions.useSound(id, timeline.timeAt(e.clientX));
  });

  // ---------- keyboard ----------
  function onKey(e) {
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) {
      if (e.key === "Escape") e.target.blur();
      return;
    }
    if (document.querySelector(".ve-modal")) return;
    const cmd = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    const run = (fn) => {
      e.preventDefault();
      fn();
    };
    if (key === " ") return run(canvas.toggle);
    if (cmd && key === "z") return run(e.shiftKey ? actions.redo : actions.undo);
    if (cmd && key === "y") return run(actions.redo);
    if (cmd && key === "b") return run(actions.split);
    if (cmd && key === "d") return run(actions.duplicate);
    if (cmd && key === "c") return run(actions.copy);
    if (cmd && key === "v") return run(actions.paste);
    if (cmd && key === "a") return run(() => store.select(M.allClips(store.doc).filter(({ track }) => !track.locked).map(({ clip }) => clip.id)));
    if (cmd) return;
    if (key === "backspace" || key === "delete") return run(e.shiftKey ? actions.ripple : actions.delete);
    if (key === "arrowleft" || key === "arrowright") return run(() => canvas.seek(store.time + (key === "arrowleft" ? -1 : 1) * (e.shiftKey ? 1 : M.FRAME)));
    if (key === "home") return run(() => canvas.seek(0));
    if (key === "end") return run(() => canvas.seek(M.duration(store.doc)));
    if (key === "escape") return run(() => store.select([]));
    if (key === "=" || key === "+") return run(() => timeline.zoomBy(1.4));
    if (key === "-") return run(() => timeline.zoomBy(1 / 1.4));
    if (key === "z" && e.shiftKey) return run(timeline.fit);
    if (key === "n") return run(timeline.toggleSnap);
    if (key === "f") return run(canvas.fullscreen);
    if (key === "?" || (key === "/" && e.shiftKey)) return run(openShortcuts);
  }
  window.addEventListener("keydown", onKey);

  // ---------- resizable panels ----------
  shell.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest("[data-resize]");
    if (!handle) return;
    e.preventDefault();
    const which = handle.dataset.resize;
    const [min, max] = SIZES[which];
    const start = { x: e.clientX, y: e.clientY, size: sizes[which] };
    handle.classList.add("on");
    const move = (ev) => {
      const delta = which === "left" ? ev.clientX - start.x : which === "right" ? start.x - ev.clientX : start.y - ev.clientY;
      sizes[which] = Math.round(clamp(start.size + delta, min, Math.min(max, which === "bottom" ? window.innerHeight - 320 : max)));
      shell.style.setProperty(`--ve-${which}`, `${sizes[which]}px`);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      handle.classList.remove("on");
      try {
        localStorage.setItem("editor.sizes", JSON.stringify(sizes));
      } catch {}
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  // ---------- toast, context menu, modals ----------
  let toastTimer = 0;
  function toast(text) {
    const el = $(".ve-toast", shell);
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2200);
  }

  function openMenu(x, y) {
    const menu = $(".ve-menu", shell);
    const items = [
      ["split", I.split, "Split at playhead", `${mod}B`],
      ["duplicate", I.duplicate, "Duplicate", `${mod}D`],
      ["copy", I.duplicate, "Copy", `${mod}C`],
      ["paste", I.duplicate, "Paste at playhead", `${mod}V`, !clipboard],
      null,
      ["link", I.link, "Link / unlink", ""],
      null,
      ["ripple", I.ripple, "Ripple delete", "⇧Del"],
      ["delete", I.trash, "Delete", "Del", false, "danger"],
    ];
    menu.innerHTML = items.map((it) => (it ? `<button data-menu="${it[0]}" class="${it[5] || ""}" ${it[4] ? "disabled" : ""}>${it[1](14)}<span>${it[2]}</span><kbd>${it[3]}</kbd></button>` : `<hr />`)).join("");
    menu.hidden = false;
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - box.width - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - box.height - 8)}px`;
    const close = (ev) => {
      if (ev.type === "keydown" && ev.key !== "Escape") return;
      menu.hidden = true;
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", close, true);
    };
    const outside = (ev) => {
      const btn = ev.target.closest?.("[data-menu]");
      if (btn && !btn.disabled) {
        ev.preventDefault();
        actions[btn.dataset.menu]?.();
      }
      close(ev);
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", close, true);
  }

  function modal(html, onClick) {
    const host = $(".ve-modal-host", shell);
    host.innerHTML = `<div class="ve-backdrop"><div class="ve-modal" role="dialog" aria-modal="true">${html}</div></div>`;
    const close = () => {
      host.innerHTML = "";
      window.removeEventListener("keydown", onEsc, true);
    };
    const onEsc = (e) => e.key === "Escape" && (e.stopPropagation(), close());
    window.addEventListener("keydown", onEsc, true);
    host.querySelector(".ve-backdrop").addEventListener("pointerdown", (e) => e.target.classList.contains("ve-backdrop") && close());
    host.querySelector(".ve-modal").addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) return close();
      onClick?.(e, close);
    });
    return host.querySelector(".ve-modal");
  }

  function openShortcuts() {
    const rows = [
      ["Play / pause", "Space"],
      ["Undo", `${mod} Z`],
      ["Redo", `${mod} ⇧ Z`],
      ["Split at playhead", `${mod} B`],
      ["Delete", "Del"],
      ["Ripple delete", "⇧ Del"],
      ["Duplicate", `${mod} D`],
      ["Copy / paste", `${mod} C · ${mod} V`],
      ["Previous / next frame", "← →"],
      ["Jump 1 second", "⇧ ← →"],
      ["Zoom timeline", "− / =  ·  pinch"],
      ["Fit timeline", "⇧ Z"],
      ["Snapping on / off", "N  ·  hold ⌥ while dragging"],
      ["Full screen", "F"],
    ];
    modal(`<div class="vm-head"><h3>Keyboard shortcuts</h3><button class="ibtn" data-close>${I.close(16)}</button></div>
      <dl class="vm-keys">${rows.map(([a, b]) => `<div><dt>${a}</dt><dd><kbd>${b}</kbd></dd></div>`).join("")}</dl>`);
  }

  function openExport() {
    const { clip } = data;
    const title = store.doc.tracks.filter((t) => t.kind === "text").flatMap((t) => t.clips).sort((a, b) => a.start - b.start)[0];
    const opt = (label, values, on, note = "") => `<div class="vm-opt"><span>${label}</span><div class="seg">${values.map((v) => `<button ${v === on ? `class="on"` : "disabled"}>${v}</button>`).join("")}</div>${note ? `<small>${note}</small>` : ""}</div>`;
    modal(
      `<div class="vm-head"><h3>Export clip</h3><button class="ibtn" data-close>${I.close(16)}</button></div>
      <div class="vm-body">
        ${opt("Format", ["MP4"], "MP4")}
        ${opt("Resolution", ["720p", "1080p", "4K"], "1080p")}
        ${opt("Frame rate", ["24", "30", "60"], "30")}
        ${opt("Captions", ["Burned in", "SRT file", "None"], "Burned in")}
        <p class="vm-note">${I.sparkle(13)}<span>Exports use your title, look and format from here. Timeline trims, splits and moves join the export with the new render pipeline, so until then the render follows the AI's cut.</span></p>
      </div>
      <div class="vm-foot"><button class="btn-ghost" data-close>Cancel</button><button class="btn-primary" data-go>${I.export(15)}<span>Export clip</span></button></div>`,
      async (e, close) => {
        const go = e.target.closest("[data-go]");
        if (!go) return;
        go.disabled = true;
        try {
          await store.flush();
          const design = { ...store.doc.design, aspect: store.doc.aspect, showTitle: Boolean(title) };
          await api(`/api/projects/${projectId}/clips/${clipId}`, { method: "PATCH", body: { ...(title ? { title: title.content, highlight: title.highlight || "" } : {}), design } });
          await api(`/api/projects/${projectId}/clips/${clipId}/render`, { method: "POST", body: {} });
          close();
          toast(`Rendering “${clip.title}”. It shows up on the project page when it's done.`);
        } catch (err) {
          go.disabled = false;
          toast(err.message);
        }
      },
    );
  }

  // Leaving with unsaved changes: save first.
  const beforeUnload = (e) => {
    if (store.saveState.state === "saved") return;
    store.flush();
    e.preventDefault();
  };
  window.addEventListener("beforeunload", beforeUnload);

  return () => {
    store.flush();
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("beforeunload", beforeUnload);
    clearTimeout(matteTimer);
    [header, assets, canvas, inspector, timeline].forEach((v) => v.destroy());
    document.body.classList.remove("editor-mode");
  };
}

function readSizes() {
  const fallback = Object.fromEntries(Object.entries(SIZES).map(([k, v]) => [k, v[2]]));
  try {
    const saved = JSON.parse(localStorage.getItem("editor.sizes") || "{}");
    return Object.fromEntries(Object.entries(SIZES).map(([k, [min, max, def]]) => [k, clamp(Number(saved[k]) || def, min, max)]));
  } catch {
    return fallback;
  }
}
