// The canvas: the clip playing exactly as it renders (HyperFrames player on the saved document), with its
// transport, the clip switcher and the AI score. It keeps the store's playhead and the player in step.
import * as M from "./model.js";
import { $, I, clamp, esc, tc, tip } from "./ui.js";

const RATINGS = { hook: "Hook", payoff: "Payoff", standalone: "Stands alone", context: "Context", boundaries: "Clean cuts", distinct: "Distinct", visual: "Visual" };
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function createCanvas(root, store, ctx) {
  const { clip, clips, aspects } = ctx.context;
  const index = clips.findIndex((c) => c.id === clip.id);
  const prev = clips[index - 1];
  const next = clips[index + 1];
  const pad = (n) => String(n).padStart(2, "0");

  root.innerHTML = `
    <div class="cv-top">
      <div class="cv-nav">
        <button class="ibtn" data-go="${prev?.id || ""}" ${prev ? "" : "disabled"} title="${prev ? esc(`Previous: ${prev.title}`) : "First clip"}">${I.chevLeft(16)}</button>
        <span class="cv-count">Clip <b>${pad(clip.rank || index + 1)}</b> <i>/ ${pad(clips.length)}</i></span>
        <button class="ibtn" data-go="${next?.id || ""}" ${next ? "" : "disabled"} title="${next ? esc(`Next: ${next.title}`) : "Last clip"}">${I.chevRight(16)}</button>
      </div>
      ${Number.isFinite(clip.score) ? `<div class="cv-score-wrap"><button class="cv-score ${clip.score >= 85 ? "hot" : ""}" data-score><b>${clip.score}</b><span>AI score</span>${I.chevDown(14)}</button>${scorePanel(clip)}</div>` : ""}
    </div>
    <div class="cv-stage">
      <div class="cv-frame">
        <hyperframes-player class="cv-player" muted-autoplay="false"></hyperframes-player>
        <div class="cv-loading" hidden><span class="spinner"></span></div>
      </div>
    </div>
    <div class="cv-transport">
      <div class="cv-time"><b data-slot="now">00:00</b><span>/</span><span data-slot="total">00:00</span></div>
      <div class="cv-play">
        <button class="ibtn" data-act="prev-frame" title="${tip("Previous frame", "←")}">${I.prevFrame(16)}</button>
        <button class="play-btn" data-act="play" title="${tip("Play", "Space")}">${I.play(18)}</button>
        <button class="ibtn" data-act="next-frame" title="${tip("Next frame", "→")}">${I.nextFrame(16)}</button>
      </div>
      <div class="cv-opts">
        <div class="cv-vol">
          <button class="ibtn" data-act="mute" title="Mute">${I.volume(16)}</button>
          <input type="range" min="0" max="1" step="0.01" value="1" aria-label="Volume" />
        </div>
        <label class="pill-select" title="Playback speed"><select data-speed>${SPEEDS.map((s) => `<option value="${s}" ${s === 1 ? "selected" : ""}>${s}×</option>`).join("")}</select>${I.chevDown(12)}</label>
        <label class="pill-select" title="Format"><select data-aspect>${Object.entries(aspects).map(([id, a]) => `<option value="${id}">${id} · ${esc(a.hint)}</option>`).join("")}</select>${I.chevDown(12)}</label>
        <button class="ibtn" data-act="fullscreen" title="${tip("Full screen", "F")}">${I.fullscreen(16)}</button>
      </div>
    </div>`;

  const player = $(".cv-player", root);
  const frame = $(".cv-frame", root);
  const stage = $(".cv-stage", root);
  const loading = $(".cv-loading", root);
  const playBtn = $('[data-act="play"]', root);
  const aspectSelect = $("[data-aspect]", root);
  const volume = $(".cv-vol input", root);
  let resume = null; // { t, playing } to restore after the preview reloads
  let raf = 0;

  // ---------- sizing ----------
  function layout() {
    const a = aspects[store.doc.aspect] || aspects["9:16"];
    const box = stage.getBoundingClientRect();
    const scale = Math.min(box.width / a.width, box.height / a.height);
    frame.style.width = `${Math.floor(a.width * scale)}px`;
    frame.style.height = `${Math.floor(a.height * scale)}px`;
    player.setAttribute("width", a.width);
    player.setAttribute("height", a.height);
    aspectSelect.value = store.doc.aspect;
  }
  const sizer = new ResizeObserver(layout);
  sizer.observe(stage);

  // ---------- the preview ----------
  let loadTimer = 0;
  function load({ keep = true } = {}) {
    clearTimeout(loadTimer);
    if (keep) resume = { t: store.time, playing: store.playing };
    if (store.playing) player.pause();
    stopClock();
    store.setPlaying(false);
    loading.hidden = false;
    layout();
    player.setAttribute("src", `${ctx.previewUrl}?rev=${store.doc.rev || 0}&v=${Date.now()}`);
  }
  player.addEventListener("ready", () => {
    loading.hidden = true;
    player.volume = Number(volume.value);
    player.playbackRate = Number($("[data-speed]", root).value);
    const r = resume;
    resume = null;
    const t = clamp(r?.t ?? store.time, 0, M.duration(store.doc));
    player.seek(t);
    store.setTime(t, { from: "player" });
    if (r?.playing) play();
  });
  player.addEventListener("error", () => (loading.hidden = true));
  player.addEventListener("ended", () => {
    stopClock();
    store.setPlaying(false);
  });

  // ---------- playback ----------
  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (!player.paused) store.setTime(player.currentTime, { from: "player" });
  };
  const stopClock = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  function play() {
    if (!player.ready) return;
    if (store.time >= M.duration(store.doc) - M.FRAME) seek(0);
    player.play();
    store.setPlaying(true);
    if (!raf) tick();
  }
  function pause() {
    player.pause();
    stopClock();
    store.setPlaying(false);
    store.setTime(player.currentTime, { from: "player" });
  }
  function seek(t, { quiet = false } = {}) {
    t = clamp(t, 0, M.duration(store.doc));
    const wasPlaying = store.playing && !quiet;
    if (player.ready) player.seek(t);
    store.setTime(t);
    // Seeking pauses the player; keep playing through a click on the timeline.
    if (wasPlaying && player.ready) player.play();
    else if (store.playing) pause();
  }
  const toggle = () => (store.playing ? pause() : play());

  store.on("playing", (playing) => {
    playBtn.innerHTML = (playing ? I.pause : I.play)(18);
    playBtn.title = tip(playing ? "Pause" : "Play", "Space");
  });
  store.on("time", ({ t }) => {
    $('[data-slot="now"]', root).textContent = tc(t);
  });
  const total = () => ($('[data-slot="total"]', root).textContent = tc(M.duration(store.doc)));
  store.on("doc", ({ transient }) => {
    total();
    if (!transient) layout();
  });
  // Every save changes what plays, so the preview follows the saved document.
  store.on("saved", () => {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => (store.dragging ? null : load()), 120);
  });

  // ---------- controls ----------
  root.addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]");
    if (go && go.dataset.go) return ctx.openClip(go.dataset.go);
    if (e.target.closest("[data-score]")) return $(".cv-score-wrap", root).classList.toggle("open");
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "play") toggle();
    if (act === "prev-frame") seek(store.time - M.FRAME);
    if (act === "next-frame") seek(store.time + M.FRAME);
    if (act === "fullscreen") fullscreen();
    if (act === "mute") {
      player.muted = !player.muted;
      btn.innerHTML = (player.muted ? I.volumeOff : I.volume)(16);
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".cv-score-wrap")) $(".cv-score-wrap", root)?.classList.remove("open");
  });
  volume.addEventListener("input", () => {
    player.volume = Number(volume.value);
    if (player.muted && Number(volume.value) > 0) player.muted = false;
  });
  $("[data-speed]", root).addEventListener("change", (e) => (player.playbackRate = Number(e.target.value)));
  aspectSelect.addEventListener("change", () => {
    const value = aspectSelect.value;
    store.commit("change format", (doc) => {
      doc.aspect = value;
      doc.design.aspect = value;
    });
    layout();
  });
  // Full screen shows the stage, not the bare frame: the frame keeps its format (9:16 with black bars either side)
  // instead of being stretched to the screen's shape.
  const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen?.());

  total();
  load({ keep: false });

  return {
    play,
    pause,
    toggle,
    seek,
    reload: load,
    fullscreen,
    destroy() {
      stopClock();
      sizer.disconnect();
      clearTimeout(loadTimer);
      player.pause?.();
    },
  };
}

function scorePanel(clip) {
  const ratings = Object.entries(clip.ratings || {}).filter(([k, v]) => RATINGS[k] && Number.isFinite(v));
  return `<div class="cv-score-panel" role="dialog">
    <div class="sp-head"><b>${clip.score}</b><span>AI score<small>How likely this clip is to hold and spread</small></span></div>
    ${ratings.length ? `<ul class="sp-list">${ratings.map(([k, v]) => `<li><span>${RATINGS[k]}</span><i><em style="width:${clamp(v / 5, 0, 1) * 100}%"></em></i><b>${Math.round(v * 20)}</b></li>`).join("")}</ul>` : ""}
    ${clip.reason ? `<div class="sp-note"><span>${I.sparkle(13)} Why it works</span><p>${esc(clip.reason)}</p></div>` : ""}
  </div>`;
}
