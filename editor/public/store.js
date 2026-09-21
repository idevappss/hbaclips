// Editor state: the document with undo/redo history, the selection, the playhead, and autosave. Views subscribe
// to the parts they draw, so the playhead moving never redraws the tracks.
import { locate } from "./model.js";

const HISTORY = 200;

export function createStore({ document, save }) {
  const listeners = new Map();
  const on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  };
  const emit = (event, detail) => listeners.get(event)?.forEach((fn) => fn(detail));

  const s = {
    doc: document,
    past: [],
    future: [],
    selection: [],
    time: 0,
    playing: false,
    gesture: null,
    // The saved revision lives outside the document, so undoing to an older snapshot never rewinds it.
    rev: document.rev || 0,
    save: { state: "saved", at: document.savedAt ? new Date(document.savedAt) : null, error: null },
  };

  // ---------- history ----------
  const setDoc = (doc, { transient = false, label = "" } = {}) => {
    s.doc = doc;
    const alive = s.selection.filter((id) => locate(doc, id));
    if (alive.length !== s.selection.length) select(alive);
    emit("doc", { transient, label });
    if (!transient) scheduleSave();
  };

  /** Run `fn` on a copy of the document and keep the result as one undoable step (unless fn returns false). */
  function commit(label, fn) {
    const next = structuredClone(s.doc);
    if (fn(next) === false) return false;
    s.past.push({ label, doc: s.doc });
    if (s.past.length > HISTORY) s.past.shift();
    s.future = [];
    setDoc(next, { label });
    emit("history");
    return true;
  }

  /** Drags: every move re-applies `fn` to the document as it was when the drag began; `end` makes it one step. */
  const gesture = {
    begin() {
      s.gesture = { base: s.doc };
    },
    update(fn) {
      if (!s.gesture) return;
      const next = structuredClone(s.gesture.base);
      if (fn(next) === false) return;
      setDoc(next, { transient: true });
    },
    end(label) {
      if (!s.gesture) return;
      const { base } = s.gesture;
      s.gesture = null;
      if (JSON.stringify(base.tracks) === JSON.stringify(s.doc.tracks)) return;
      s.past.push({ label, doc: base });
      s.future = [];
      setDoc(s.doc, { label });
      emit("history");
    },
    cancel() {
      if (!s.gesture) return;
      const { base } = s.gesture;
      s.gesture = null;
      setDoc(base, { transient: true });
    },
  };

  function undo() {
    const step = s.past.pop();
    if (!step) return null;
    s.future.push({ label: step.label, doc: s.doc });
    setDoc(step.doc, { label: step.label });
    emit("history");
    return step.label;
  }
  function redo() {
    const step = s.future.pop();
    if (!step) return null;
    s.past.push({ label: step.label, doc: s.doc });
    setDoc(step.doc, { label: step.label });
    emit("history");
    return step.label;
  }

  // ---------- selection & playhead ----------
  function select(ids) {
    const next = [...new Set(ids)];
    if (next.join() === s.selection.join()) return;
    s.selection = next;
    emit("selection", next);
  }

  let timeFrame = 0;
  function setTime(t, { from = "user" } = {}) {
    s.time = Math.max(0, t);
    // Many updates per frame collapse into one notification.
    if (!timeFrame) {
      timeFrame = requestAnimationFrame(() => {
        timeFrame = 0;
        emit("time", { t: s.time, from });
      });
    }
  }
  function setPlaying(playing) {
    if (s.playing === playing) return;
    s.playing = playing;
    emit("playing", playing);
  }

  // ---------- autosave ----------
  let saveTimer = 0;
  let saving = null;
  let dirty = false;
  const setSave = (patch) => {
    Object.assign(s.save, patch);
    emit("save", s.save);
  };
  function scheduleSave() {
    dirty = true;
    setSave({ state: "pending" });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 700);
  }
  async function flush() {
    clearTimeout(saveTimer);
    if (saving) return saving;
    if (!dirty) return;
    dirty = false;
    setSave({ state: "saving", error: null });
    saving = (async () => {
      try {
        const result = await save(s.doc, s.rev);
        s.rev = result.rev;
        s.doc.rev = result.rev;
        setSave({ state: dirty ? "pending" : "saved", at: new Date(result.savedAt) });
        emit("saved", result);
      } catch (err) {
        dirty = true;
        setSave({ state: "error", error: err.message });
        saveTimer = setTimeout(flush, 5000);
      } finally {
        saving = null;
      }
      if (dirty && s.save.state !== "error") flush();
    })();
    return saving;
  }

  return {
    get doc() {
      return s.doc;
    },
    get selection() {
      return s.selection;
    },
    get time() {
      return s.time;
    },
    get playing() {
      return s.playing;
    },
    get saveState() {
      return s.save;
    },
    get dragging() {
      return Boolean(s.gesture);
    },
    canUndo: () => s.past.length > 0,
    canRedo: () => s.future.length > 0,
    undoLabel: () => s.past.at(-1)?.label || "",
    redoLabel: () => s.future.at(-1)?.label || "",
    on,
    emit,
    commit,
    gesture,
    undo,
    redo,
    select,
    setTime,
    setPlaying,
    flush,
    /** Swap in a document from the server (reset, another tab) without making it undoable. */
    replace(doc) {
      s.past = [];
      s.future = [];
      s.doc = doc;
      s.rev = doc.rev || 0;
      emit("doc", { label: "replace" });
      emit("history");
    },
  };
}
