// Dope edits, merged engine: the Dope Clips planner (edits/, see shared/EDIT_PLAN.md) directs each edit,
// and this app previews and renders the resulting edit-plan/1 with HyperFrames (lib/editplan.js).
// A project stores a light entry per edit ({ id, engine: "dope", design, render }); the planner owns the rest.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { planEdit } from "../edits/index.js";
import { loadEdit } from "../edits/store.js";
import { LOOKS, TEXT_STYLES } from "../edits/looks.js";
import { SFX_DIR, buildPlanHtml, stageSegments } from "./editplan.js";
import { projectDir, saveProject } from "./store.js";
import { ROOT } from "./tools.js";

const PLANNING = ["queued", "analyzing", "directing"];
const VIBE_ENERGY = { hype: "hype", cinematic: "medium", smooth: "chill" };
const VIBE_BRIEF = {
  hype: "High-energy hype edit: hard cuts on the beat, punchy effects, big moments.",
  cinematic: "Cinematic edit: moody, filmic, room for slow motion and emotional moments.",
  smooth: "Smooth edit: clean flowing cuts, calm energy, let the footage breathe.",
};
const FINISH_KEYS = ["look", "lookIntensity", "textStyle", "accent", "title", "captions", "sfx"];

export const DOPE_LOOKS = Object.fromEntries(Object.entries(LOOKS).map(([id, look]) => [id, look.label]));
export const DOPE_TEXT_STYLES = Object.fromEntries(Object.entries(TEXT_STYLES).map(([id, style]) => [id, style.label]));

/** The planner's queue helpers aren't exported, so replans, stops and deletes go through its mounted router. */
async function plannerApi(method, route, body, action) {
  const res = await fetch(`http://127.0.0.1:${Number(process.env.PORT) || 5173}/edits/api${route}`, {
    method,
    // Named in the planner's job audit trail (edit.jobs[].via).
    headers: { "User-Agent": `clip-studio/${action}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The edit planner returned ${res.status}.`);
  return data;
}

/** Queue a planned edit for a project and record it on the project. */
export async function startDopeEdit(project, input = {}) {
  const vibe = VIBE_ENERGY[input.vibe] ? input.vibe : "hype";
  const record = await planEdit({
    projectIds: [project.id],
    trackId: input.trackId || null,
    options: {
      length: input.length,
      aspect: input.aspect,
      energy: VIBE_ENERGY[vibe],
      vibe: VIBE_BRIEF[vibe],
      title: input.title,
      look: input.look || "auto",
      textStyle: input.textStyle || "auto",
      captions: Boolean(input.captions),
      sfx: input.sfx || "full",
    },
  });
  const entry = {
    id: record.id,
    engine: "dope",
    createdAt: new Date().toISOString(),
    trackId: input.trackId || null,
    design: { vibe, length: record.options.length, aspect: record.options.aspect, title: record.options.title },
  };
  project.edits = [entry, ...(project.edits || [])];
  await saveProject(project);
  return entry;
}

// ---------- live preview ----------

const previews = new Map(); // "<editId>:<cutKey>" → staging promise
const previewErrors = new Map();

/** Identifies the footage a plan cuts (what stageSegments reads), so finish tweaks that keep the shots reuse their preview media. */
const cutKey = (plan) =>
  crypto.createHash("sha1").update(JSON.stringify(plan.shots.map((s) => [s.index, s.file, s.in, s.parts]))).digest("hex").slice(0, 12);
const previewDir = (project, editId, cut) => path.join(projectDir(project.id), "edits", editId, `preview-${cut}`);

async function previewMedia(project, editId, cut) {
  try {
    return JSON.parse(await fs.readFile(path.join(previewDir(project, editId, cut), "media.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Stage small segments for one plan's live preview, once, in the background. */
function preparePreview(project, record) {
  const cut = cutKey(record.editPlan);
  const key = `${record.id}:${cut}`;
  if (previews.has(key)) return;
  const dir = previewDir(project, record.id, cut);
  previewErrors.delete(key);
  previews.set(
    key,
    (async () => {
      const media = await stageSegments(record.editPlan, dir, { maxHeight: 640, preview: true });
      await fs.writeFile(path.join(dir, "media.json"), JSON.stringify(media));
      // Previews of earlier cuts are superseded.
      const root = path.dirname(dir);
      for (const name of await fs.readdir(root).catch(() => [])) {
        if (name.startsWith("preview-") && name !== path.basename(dir)) await fs.rm(path.join(root, name), { recursive: true, force: true });
      }
    })().catch((err) => {
      console.error(`[dope ${record.id}] preview staging failed:`, err.message);
      previewErrors.set(key, err.message);
      previews.delete(key);
    }),
  );
}

/** A project's edit entry with the planner's live state merged in (what the UI polls). */
export async function describeDopeEdit(project, entry) {
  const record = await loadEdit(entry.id);
  if (!record) return { ...entry, status: "error", message: "This edit is gone", error: "The planner no longer has this edit — delete it and make a new one." };
  const plan = record.editPlan;
  const planning = PLANNING.includes(record.status);
  // A failed tweak keeps the last good plan on the record, so the edit stays usable with a note.
  const status = planning ? "scanning" : plan ? "ready" : "error";
  const updateError = !planning && plan && record.status === "error" ? record.error || record.message : null;

  let preview = null;
  if (status === "ready") {
    const version = record.planVersion;
    const cut = cutKey(plan);
    const key = `${record.id}:${cut}`;
    if (await previewMedia(project, record.id, cut)) preview = { status: "ready", version, cut };
    else if (previewErrors.has(key)) preview = { status: "error", version, cut, error: previewErrors.get(key) };
    else {
      preparePreview(project, record);
      preview = { status: "preparing", version, cut };
    }
  }

  return {
    ...entry,
    status,
    progress: record.progress || 0,
    message: planning || !plan ? record.message : `${plan.shots.length} shots · ${plan.length.toFixed(1)}s · ${plan.grade?.label || plan.look}`,
    error: status === "error" ? record.error || record.message : null,
    updateError,
    planVersion: record.planVersion || 0,
    renderStale: entry.render?.status === "done" && entry.render.planVersion != null && entry.render.planVersion !== record.planVersion,
    replanning: planning && Boolean(plan),
    preview,
    previewBase: preview?.status === "ready" ? `/files/${project.id}/edits/${record.id}/preview-${preview.cut}/` : null,
    duration: plan?.length ?? null,
    shotCount: plan?.shots.length ?? 0,
    concept: plan?.director?.concept || "",
    notice: plan?.director?.notice || null,
    finish: Object.fromEntries(FINISH_KEYS.map((key) => [key, record.options?.[key] ?? null])),
    resolved: plan ? { look: plan.look, lookIntensity: plan.lookIntensity, textStyle: plan.textStyle, accent: plan.accent, title: plan.title } : null,
  };
}

/** The live-preview composition for an edit's current plan, or null while its preview is still being staged. */
export async function dopePreviewHtml(project, editId) {
  const record = await loadEdit(editId);
  if (!record?.editPlan) return null;
  const plan = record.editPlan;
  const cut = cutKey(plan);
  const media = await previewMedia(project, editId, cut);
  if (!media) return null;
  const hasMusic = Boolean(plan.audio?.music?.file || plan.music?.file);
  const { html } = buildPlanHtml({
    plan,
    media,
    mediaBase: `/files/${project.id}/edits/${editId}/preview-${cut}/`,
    musicSrc: hasMusic ? `/api/projects/${project.id}/edits/${editId}/music` : null,
    sfxSrc: (name) => `/edits/sfx/${name}.mp3`,
    assetBase: "/studio-assets/",
    runtimeSrc: "/vendor/hyperframe-runtime.js",
  });
  return html;
}

/** A director edit's planned length in seconds (the project entry doesn't store it), or null. */
export async function dopePlanLength(editId) {
  const plan = (await loadEdit(editId))?.editPlan;
  return Number.isFinite(plan?.length) ? Math.round(plan.length * 10) / 10 : null;
}

export async function dopeMusicFile(editId) {
  const plan = (await loadEdit(editId))?.editPlan;
  return plan?.audio?.music?.file || plan?.music?.file || null;
}

// ---------- rendering ----------

/** Stage full-size media, music and SFX for an edit's plan and write its HyperFrames composition. */
export async function prepareDopeRender({ item, compositionDir, signal, setRender }) {
  const record = await loadEdit(item.id);
  if (!record?.editPlan) throw new Error("This edit doesn't have a plan to render yet.");
  const plan = record.editPlan;
  const assets = path.join(compositionDir, "assets");
  // Remembered on the render so the card can say when later tweaks have made it out of date.
  await setRender({ planVersion: record.planVersion });

  const media = await stageSegments(plan, path.join(assets, "segments"), {
    maxHeight: Math.max(plan.width, plan.height),
    signal,
    onProgress: (fraction) => setRender({ message: `Cutting shots… ${Math.round(fraction * 100)}%` }),
  });

  let musicSrc = null;
  const musicFile = plan.audio?.music?.file || plan.music?.file;
  if (musicFile) {
    const name = `music${path.extname(musicFile)}`;
    await fs.copyFile(musicFile, path.join(assets, name));
    musicSrc = `assets/${name}`;
  }
  await fs.mkdir(path.join(assets, "sfx"), { recursive: true });
  for (const name of new Set((plan.sfx || []).map((cue) => cue.name))) {
    await fs.copyFile(path.join(SFX_DIR, `${name}.mp3`), path.join(assets, "sfx", `${name}.mp3`)).catch(() => {});
  }
  await fs.cp(path.join(ROOT, "assets", "vendor"), path.join(assets, "vendor"), { recursive: true });

  const { html } = buildPlanHtml({ plan, media, mediaBase: "assets/segments/", musicSrc, sfxSrc: (name) => `assets/sfx/${name}.mp3` });
  await fs.writeFile(path.join(compositionDir, "index.html"), html);
}

// ---------- changes ----------

/** Same shots, new finish (look, strength, text style, accent, title, captions, SFX). */
export function changeDopeFinish(editId, finish = {}) {
  const options = Object.fromEntries(FINISH_KEYS.filter((key) => finish[key] !== undefined).map((key) => [key, finish[key]]));
  return plannerApi("POST", `/edits/${editId}/replan`, { keepShots: true, options }, "finish");
}

/** A whole new direction with different shots. */
export const rerollDopeEdit = (editId) => plannerApi("POST", `/edits/${editId}/replan`, { keepShots: false }, "reroll");

export const stopDopePlanning = (editId) => plannerApi("POST", `/edits/${editId}/cancel`, null, "stop");

export async function deleteDopeEdit(editId) {
  await plannerApi("DELETE", `/edits/${editId}`, null, "delete").catch((err) => console.error(`[dope ${editId}] delete:`, err.message));
}
