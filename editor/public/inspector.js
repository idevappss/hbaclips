// Right side: settings for whatever is selected — the clip itself when nothing is, or a title, caption, video
// piece or audio clip. Only what applies to the selection is shown.
import * as M from "./model.js";
import { $, $$, I, clamp, esc, r3, secs, tc } from "./ui.js";

export function createInspector(root, store, ctx) {
  let tab = "text";
  let drawnFor = "";

  const field = (label, control, hint = "") => `<label class="in-field"><span>${label}</span>${control}${hint ? `<small>${hint}</small>` : ""}</label>`;
  const numInput = (key, value, { step = 0.1, min = 0, max = 9999, unit = "s" } = {}) =>
    `<div class="in-num"><input type="number" data-num="${key}" value="${r3(value)}" step="${step}" min="${min}" max="${max}" /><i>${unit}</i></div>`;
  const section = (title, body, extra = "") => `<section class="in-sec"><h4>${title}${extra}</h4>${body}</section>`;
  const tabs = (list) => `<div class="in-tabs">${list.map(([id, label, soon]) => `<button data-tab="${id}" class="${tab === id ? "on" : ""}" ${soon ? `disabled title="Coming soon"` : ""}>${label}</button>`).join("")}</div>`;

  function timing(clip) {
    return section(
      "Timing",
      `<div class="in-row3">
        ${field("Start", numInput("start", clip.start))}
        ${field("End", numInput("end", M.end(clip)))}
        ${field("Duration", numInput("duration", clip.duration, { min: M.MIN_DUR }))}
      </div>`,
    );
  }

  function clipPanel() {
    const doc = store.doc;
    const { aspects, styles, clip } = ctx.context;
    const pieces = doc.tracks.find((t) => t.kind === "video")?.clips.length || 0;
    return `
      <div class="in-title"><span class="in-kind">${I.video(14)}Clip</span><h3>${esc(clip.title || "Untitled clip")}</h3></div>
      ${section("Format", `<div class="in-aspects">${Object.entries(aspects)
        .map(([id, a]) => `<button data-aspect="${id}" class="${doc.aspect === id ? "on" : ""}" title="${esc(a.hint)}"><i style="aspect-ratio:${a.width}/${a.height}"></i><b>${id}</b><small>${esc(a.hint.split(" · ")[0])}</small></button>`)
        .join("")}</div>`)}
      ${section("Look", `<div class="in-styles">${styles
        .map((s) => `<button data-style="${s.id}" class="${doc.design.style === s.id ? "on" : ""}"><b>${esc(s.label)}</b><small>${esc(s.description)}</small></button>`)
        .join("")}</div>`)}
      ${section("Overview", `<dl class="in-stats">
        <div><dt>Length</dt><dd>${tc(M.duration(doc))}</dd></div>
        <div><dt>Pieces</dt><dd>${pieces}</dd></div>
        <div><dt>Captions</dt><dd>${doc.tracks.find((t) => t.kind === "caption")?.clips.length || 0}</dd></div>
      </dl>`)}
      ${section("Start over", `<p class="in-note">Put the timeline back to the AI's edit. You can undo this.</p><button class="btn-ghost sm" data-act="reset">${I.reset(14)}<span>Reset to AI edit</span></button>`)}`;
  }

  function textPanel(clip) {
    const presets = [["plain", "Plain"], ["card", "Card"], ["pill", "Pill"]];
    const firstTitle = store.doc.tracks.filter((t) => t.kind === "text").flatMap((t) => t.clips).sort((a, b) => a.start - b.start)[0];
    return `
      <div class="in-title"><span class="in-kind k-text">${I.text(14)}Title</span></div>
      ${tabs([["text", "Text"], ["animation", "Animation", true], ["style", "Style", true], ["properties", "Properties", true]])}
      ${section("Text content", `<div class="in-area"><textarea data-text="content" rows="4" maxlength="200">${esc(clip.content)}</textarea><small data-count>${clip.content.length}/200</small></div>`)}
      ${section("Highlight word", `<input class="in-input" data-text="highlight" maxlength="40" value="${esc(clip.highlight || "")}" placeholder="A word from the title" />`)}
      ${section("Title look", `<div class="seg fill">${presets.map(([id, label]) => `<button data-preset="${id}" class="${(clip.style?.preset || "plain") === id ? "on" : ""}">${label}</button>`).join("")}</div>`)}
      ${timing(clip)}
      ${firstTitle && firstTitle.id !== clip.id ? `<p class="in-note warn">Only the first title plays in the preview for now; more titles arrive with the full text editor.</p>` : ""}`;
  }

  function captionPanel(clip) {
    return `
      <div class="in-title"><span class="in-kind k-caption">${I.captions(14)}Caption</span></div>
      ${section("Words", `<div class="in-area"><textarea data-caption rows="3">${esc(clip.words.map((w) => w.text).join(" "))}</textarea></div><p class="in-note">Fix spelling here. Timings stay with each word.</p>`)}
      ${section("Word timing", `<div class="in-words">${clip.words
        .map((w) => `<span class="${w.e <= 0 || w.s >= clip.duration ? "off" : ""}"><b>${esc(w.text)}</b><small>${secs(clip.start + w.s)}</small></span>`)
        .join("")}</div>`)}
      ${timing(clip)}`;
  }

  function videoPanel(clip) {
    return `
      <div class="in-title"><span class="in-kind k-video">${I.video(14)}Video</span></div>
      ${tabs([["text", "Video"], ["animation", "Animation", true], ["adjust", "Adjust", true], ["speed", "Speed", true]])}
      ${section("Trim", `<div class="in-row3">
        ${field("In", numInput("sourceStart", clip.sourceStart), "in the source")}
        ${field("Out", numInput("sourceEnd", clip.sourceEnd), "in the source")}
        ${field("Duration", numInput("duration", clip.duration, { min: M.MIN_DUR }))}
      </div><p class="in-note">Drag either edge of the clip on the timeline to trim it. Its audio trims with it while they're linked.</p>`)}
      ${section("On the timeline", `<div class="in-row3">${field("Starts at", numInput("start", clip.start))}${field("Ends at", numInput("end", M.end(clip)))}</div>`)}
      ${section("Speed", `<div class="seg fill">${[0.5, 1, 1.5, 2].map((s) => `<button disabled class="${(clip.speed || 1) === s ? "on" : ""}" title="Speed changes are coming soon">${s}×</button>`).join("")}</div>`)}`;
  }

  function audioPanel(clip, track) {
    const music = Boolean(clip.sound);
    const voiceNote = `<p class="in-note">Voice level controls arrive with audio editing. Mute the whole track from its header.</p>`;
    return `
      <div class="in-title"><span class="in-kind k-audio">${(music ? I.audio : I.volume)(14)}${music ? "Music" : "Original audio"}</span>${music ? `<h3>${esc(clip.name || "Background music")}</h3>` : ""}</div>
      ${music ? section("Volume", `<div class="in-slider"><input type="range" min="0" max="0.8" step="0.01" value="${Math.abs((clip.volume ?? 0.13) - 0.11) < 0.001 ? 0.13 : clip.volume ?? 0.13}" data-volume /><b data-volume-out>${Math.round((Math.abs((clip.volume ?? 0.13) - 0.11) < 0.001 ? 0.13 : clip.volume ?? 0.13) * 100)}%</b></div><p class="in-note">Sits under the voice. 13% is the house level.</p>`) : section("Volume", voiceNote)}
      ${section("Track", `<label class="in-toggle"><input type="checkbox" data-mute ${track.muted ? "checked" : ""} /><span class="track"></span>Mute ${esc(track.name.toLowerCase())}</label>`)}
      ${timing(clip)}`;
  }

  function overlayPanel(clip) {
    const u = ctx.uploads?.get(clip.asset);
    const slide = clip.source === "slide";
    const layouts = slide ? [["split", "Side by side"], ["full", "Full screen"], ["card", "Card"], ["pip", "Corner"]] : clip.source === "screen" ? [["split", "Side by side"]] : [["full", "Full screen"]];
    const pages = slide && u?.slides?.length > 1 ? u.slides : null;
    const thumb = slide ? u?.slides?.find((x) => x.page === clip.page)?.src : u?.poster;
    return `
      <div class="in-title"><span class="in-kind k-overlay">${I.media(14)}${slide ? `Slide ${clip.page}` : clip.source === "broll" ? "B-roll" : "Phone recording"}</span><h3>${esc(u?.name || clip.name || "Missing upload")}</h3></div>
      ${thumb ? `<div class="in-ov-thumb"><img src="${esc(thumb)}" alt="" /></div>` : ""}
      ${clip.why ? `<p class="in-note in-why">${I.sparkle(12)}<span>${esc(clip.why)}</span></p>` : ""}
      ${section("Layout", `<div class="in-layouts">${layouts.map(([id, label]) => `<button data-layout="${id}" class="${clip.layout === id ? "on" : ""}"><i class="lay-${id} ${clip.side === "left" ? "flip" : ""}"><b></b><em></em></i><span>${label}</span></button>`).join("")}</div>`)}
      ${clip.layout !== "card" && clip.source !== "broll" ? section(clip.layout === "full" || clip.layout === "pip" ? "Speaker bubble" : slide ? "Slide goes" : "Phone goes", `<div class="seg fill"><button data-side="left" class="${clip.side === "left" ? "on" : ""}">${clip.layout === "full" || clip.layout === "pip" ? "Right corner" : "Left"}</button><button data-side="right" class="${clip.side !== "left" ? "on" : ""}">${clip.layout === "full" || clip.layout === "pip" ? "Left corner" : "Right"}</button></div>`) : ""}
      ${pages ? section("Slide", `<div class="in-pages">${pages.map((p) => `<button data-page="${p.page}" class="${p.page === clip.page ? "on" : ""}" title="Slide ${p.page}">${p.src ? `<img src="${esc(p.src)}" alt="" loading="lazy" />` : `<span>${p.page}</span>`}</button>`).join("")}</div>`) : ""}
      ${slide && clip.focus ? section("Zoom", `<p class="in-note">The slide zooms into the part you're talking about.</p><button class="btn-ghost sm" data-unfocus>${I.fit(14)}<span>Show the whole slide</span></button>`) : ""}
      ${!slide ? section("Recording", `<div class="in-row3">${field("Starts from", numInput("sourceStart", clip.sourceStart || 0), "in the recording")}</div>`) : ""}
      ${timing(clip)}`;
  }

  function emphasisPanel(clip) {
    const m = ctx.mattes?.[clip.id]?.state;
    const status = m === "done" ? "The words sit behind you." : m === "queued" || m === "running" ? "Cutting you out of the video so the words sit behind you. The preview updates when it's ready." : m === "error" ? "Couldn't cut you out here, so the words sit in front." : "";
    return `
      <div class="in-title"><span class="in-kind k-emphasis">${I.sparkle(14)}Big caption</span></div>
      ${clip.why ? `<p class="in-note in-why">${I.sparkle(12)}<span>${esc(clip.why)}</span></p>` : ""}
      ${section("Words", `<div class="in-area"><textarea data-emph rows="2" maxlength="60">${esc(clip.text)}</textarea></div><p class="in-note">2–6 words land best. They glow big behind you, then the regular captions come back.</p>`)}
      ${status ? `<p class="in-note ${m === "error" ? "warn" : ""}">${status}</p>` : ""}
      ${timing(clip)}`;
  }

  function draw(force = false) {
    const sel = store.selection;
    const key = `${sel.join()}|${tab}`;
    // Keep focus while typing: a doc change from this panel doesn't redraw the field being edited.
    if (!force && key === drawnFor && root.contains(document.activeElement) && document.activeElement.matches("input, textarea")) return;
    drawnFor = key;
    if (sel.length > 1) {
      root.innerHTML = `<div class="in-title"><span class="in-kind">${I.duplicate(14)}${sel.length} clips selected</span></div>
        ${section("Selection", `<div class="in-btns"><button class="btn-ghost sm" data-act="duplicate">${I.duplicate(14)}<span>Duplicate</span></button><button class="btn-ghost sm danger" data-act="delete">${I.trash(14)}<span>Delete</span></button></div>`)}`;
      return;
    }
    const hit = sel.length ? M.locate(store.doc, sel[0]) : null;
    if (!hit) root.innerHTML = clipPanel();
    else if (hit.clip.type === "text") root.innerHTML = textPanel(hit.clip);
    else if (hit.clip.type === "caption") root.innerHTML = captionPanel(hit.clip);
    else if (hit.clip.type === "video") root.innerHTML = videoPanel(hit.clip);
    else if (hit.clip.type === "overlay") root.innerHTML = overlayPanel(hit.clip);
    else if (hit.clip.type === "emphasis") root.innerHTML = emphasisPanel(hit.clip);
    else root.innerHTML = audioPanel(hit.clip, hit.track);
  }

  const selected = () => (store.selection.length === 1 ? M.locate(store.doc, store.selection[0]) : null);

  function setTiming(id, key, value) {
    const hit = M.locate(store.doc, id);
    if (!hit || !Number.isFinite(value)) return;
    const { clip } = hit;
    store.commit(key === "start" ? "move" : "trim", (doc) => {
      if (key === "start") return M.move(doc, id, value);
      if (key === "end") return M.trimEnd(doc, id, value, { sourceDuration: ctx.sourceDuration });
      if (key === "duration") return M.trimEnd(doc, id, clip.start + value, { sourceDuration: ctx.sourceDuration });
      if (key === "sourceStart" && clip.type === "overlay") return void (M.locate(doc, id).clip.sourceStart = r3(Math.max(0, value)));
      if (key === "sourceStart") return M.trimStart(doc, id, clip.start + (value - clip.sourceStart) / (clip.speed || 1));
      if (key === "sourceEnd") return M.trimEnd(doc, id, M.end(clip) + (value - clip.sourceEnd) / (clip.speed || 1), { sourceDuration: ctx.sourceDuration });
      return false;
    });
    draw(true);
  }

  root.addEventListener("change", (e) => {
    const hit = selected();
    const num = e.target.closest("[data-num]");
    if (num && hit) return setTiming(hit.clip.id, num.dataset.num, Number(num.value));
    const mute = e.target.closest("[data-mute]");
    if (mute && hit) {
      store.commit(mute.checked ? "mute track" : "unmute track", (doc) => {
        doc.tracks.find((t) => t.id === hit.track.id).muted = mute.checked;
      });
    }
    const vol = e.target.closest("[data-volume]");
    if (vol && hit) {
      store.commit("change volume", (doc) => {
        M.locate(doc, hit.clip.id).clip.volume = r3(clamp(Number(vol.value), 0, 0.8));
      });
    }
    const caption = e.target.closest("[data-caption]");
    if (caption && hit) {
      const texts = caption.value.trim().split(/\s+/).filter(Boolean);
      store.commit("edit caption", (doc) => {
        const c = M.locate(doc, hit.clip.id).clip;
        if (texts.length === c.words.length) c.words.forEach((w, i) => (w.text = texts[i]));
        else {
          // A different number of words: spread them over the time the old ones took.
          const s0 = c.words[0]?.s ?? 0;
          const e1 = c.words.at(-1)?.e ?? c.duration;
          const span = Math.max(0.1, e1 - s0) / Math.max(1, texts.length);
          c.words = texts.map((text, i) => ({ text, s: r3(s0 + i * span), e: r3(s0 + (i + 1) * span) }));
        }
      });
      draw(true);
    }
  });

  let typing = 0;
  root.addEventListener("input", (e) => {
    const hit = selected();
    const text = e.target.closest("[data-text]");
    if (text && hit) {
      const value = text.value;
      const key = text.dataset.text;
      if (key === "content") $("[data-count]", root).textContent = `${value.length}/200`;
      // Typing is one undo step per pause, not one per key.
      clearTimeout(typing);
      typing = setTimeout(() => store.commit(`edit ${key === "content" ? "text" : "highlight"}`, (doc) => void (M.locate(doc, hit.clip.id).clip[key] = value)), 350);
    }
    const emph = e.target.closest("[data-emph]");
    if (emph && hit) {
      const value = emph.value.replace(/\s+/g, " ");
      clearTimeout(typing);
      typing = setTimeout(() => store.commit("edit big caption", (doc) => void (M.locate(doc, hit.clip.id).clip.text = value.trim())), 400);
    }
    const vol = e.target.closest("[data-volume]");
    if (vol) $("[data-volume-out]", root).textContent = `${Math.round(Number(vol.value) * 100)}%`;
  });

  root.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]");
    if (t && !t.disabled) {
      tab = t.dataset.tab;
      return draw(true);
    }
    const aspect = e.target.closest("[data-aspect]");
    if (aspect) {
      store.commit("change format", (doc) => {
        doc.aspect = aspect.dataset.aspect;
        doc.design.aspect = aspect.dataset.aspect;
      });
      return draw(true);
    }
    const style = e.target.closest("[data-style]");
    if (style) {
      const preset = ctx.context.styles.find((s) => s.id === style.dataset.style);
      store.commit("change look", (doc) => {
        const { aspect, cropX, autoFrame, musicBed, musicLevel } = doc.design;
        doc.design = { ...preset.design, style: preset.id, aspect, cropX, autoFrame, musicBed, musicLevel };
        // A look without a headline (Editorial Talk) takes the title off the timeline too; undo brings it back.
        if (preset.design.showTitle === false) for (const t of doc.tracks.filter((x) => x.kind === "text")) t.clips = [];
      });
      return draw(true);
    }
    const presetBtn = e.target.closest("[data-preset]");
    const hit = selected();
    if (presetBtn && hit) {
      store.commit("change title look", (doc) => {
        const c = M.locate(doc, hit.clip.id).clip;
        c.style = { ...(c.style || {}), preset: presetBtn.dataset.preset };
      });
      return draw(true);
    }
    const overlayEdit = (label, fn) => {
      if (!hit) return;
      store.commit(label, (doc) => fn(M.locate(doc, hit.clip.id).clip));
      draw(true);
    };
    const layout = e.target.closest("[data-layout]");
    if (layout) return overlayEdit("change layout", (c) => void (c.layout = layout.dataset.layout));
    const side = e.target.closest("[data-side]");
    if (side) return overlayEdit("change side", (c) => void (c.side = side.dataset.side));
    const page = e.target.closest("[data-page]");
    if (page) return overlayEdit("change slide", (c) => {
      c.page = Number(page.dataset.page);
      delete c.focus;
    });
    if (e.target.closest("[data-unfocus]")) return overlayEdit("show whole slide", (c) => void delete c.focus);
    const act = e.target.closest("[data-act]");
    if (act) ctx.actions[act.dataset.act]?.();
  });

  const offs = [store.on("selection", () => draw(true)), store.on("doc", ({ transient }) => (transient ? null : draw()))];
  draw(true);
  return {
    destroy: () => offs.forEach((off) => off()),
  };
}
