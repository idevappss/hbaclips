// Auto-post: keep one clip going out every day, on its own. When it's on, the app looks for finished clips that
// scored at or above the bar (80 by default) and passed review, takes the best three, and schedules them one a day
// at the creator's chosen time — always continuing past whatever is already on the calendar, so the run never
// doubles up on a day. Turning it off stops new scheduling; posts already on the calendar stay.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT } from "./tools.js";
import { listProjects, loadProject } from "./store.js";
import { createPost, listAccounts, listPosts } from "./scheduler.js";
import { finishedRender } from "./pipeline.js";

const FILE = path.join(ROOT, "data", "autopost.json");
const EVERY_MIN = 20;

const DEFAULTS = {
  on: false,
  time: "18:00", // local time of day every post goes out
  accountIds: [],
  minScore: 80, // the clip's own score out of 100
  perRun: 3, // how many are lined up each time it looks
  lastRunAt: null,
  lastMessage: null,
  history: [],
};

let db = null;
let writes = Promise.resolve();

async function load() {
  if (!db) {
    try {
      db = { ...DEFAULTS, ...JSON.parse(await fs.readFile(FILE, "utf8")) };
    } catch {
      db = { ...DEFAULTS };
    }
  }
  return db;
}

function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  writes = writes
    .then(async () => {
      await fs.mkdir(path.dirname(FILE), { recursive: true });
      const tmp = `${FILE}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(tmp, snapshot);
      await fs.rename(tmp, FILE);
    })
    .catch((err) => console.error("Saving auto-post failed:", err.message));
  return writes;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The day a post is on, as a local YYYY-MM-DD key. */
const dayKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** A local Date for `day` (a Date) at the settings' time of day. */
function at(day, time) {
  const [h, m] = (HHMM.test(time) ? time : DEFAULTS.time).split(":").map(Number);
  const out = new Date(day);
  out.setHours(h, m, 0, 0);
  return out;
}

/**
 * The next `count` free days for posting, at the chosen time: today when that time hasn't passed yet, then forward,
 * skipping every day that already has a post on it (scheduled by hand or by an earlier run).
 */
export function nextSlots(posts, time, count, now = new Date()) {
  const taken = new Set(posts.map((p) => dayKey(new Date(p.scheduledAt))));
  const slots = [];
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  for (let i = 0; slots.length < count && i < 400; i++) {
    const when = at(new Date(day.getTime() + i * 86400000), time);
    // A time that has already gone by today isn't a slot; the run starts tomorrow instead.
    if (when.getTime() <= now.getTime() + 60_000) continue;
    if (taken.has(dayKey(when))) continue;
    slots.push(when);
  }
  return slots;
}

/**
 * Clips that qualify right now, best first: rendered, scored at or above the bar, review passed, not already on the
 * calendar or posted, and not one the creator passed on.
 */
export async function eligibleClips({ minScore = DEFAULTS.minScore } = {}) {
  const posts = await listPosts();
  const done = new Set(posts.map((p) => `${p.projectId}/${p.clipId}`));
  const out = [];
  for (const summary of await listProjects()) {
    const project = await loadProject(summary.id);
    for (const clip of project?.clips || []) {
      const render = finishedRender(clip);
      if (!render?.file) continue;
      if (done.has(`${project.id}/${clip.id}`)) continue;
      if (clip.feedback?.verdict === "pass") continue;
      if ((clip.score ?? 0) < minScore) continue;
      // A clip the review flagged isn't "guaranteed to do well", so it waits for the creator.
      if (render.review && render.review.pass === false) continue;
      out.push({
        projectId: project.id,
        projectName: project.name,
        clipId: clip.id,
        title: clip.title,
        score: clip.score ?? null,
        reviewScore: render.review?.score ?? null,
        loved: clip.feedback?.verdict === "like",
        file: render.file,
        duration: +(render.duration ?? clip.end - clip.start).toFixed(1),
        caption: clip.caption,
        hashtags: clip.hashtags || [],
        clip,
        project,
      });
    }
  }
  // Best first: the clips the creator hearted lead, then the strongest picks that also reviewed well.
  return out.sort((a, b) => Number(b.loved) - Number(a.loved) || b.score - a.score || (b.reviewScore ?? 0) - (a.reviewScore ?? 0));
}

export async function getSettings() {
  await load();
  const { history, ...rest } = db;
  const accounts = await listAccounts();
  const posts = await listPosts();
  const queue = await eligibleClips({ minScore: db.minScore });
  return {
    ...rest,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, platform: a.platform })),
    ready: queue.length,
    nextUp: queue.slice(0, db.perRun).map(({ clip, project, ...c }) => c),
    slots: nextSlots(posts, db.time, db.perRun).map((d) => d.toISOString()),
    scheduled: posts.filter((p) => p.clip?.auto && new Date(p.scheduledAt) > new Date()).length,
    recent: (history || []).slice(-10).reverse(),
  };
}

export async function updateSettings(patch = {}) {
  await load();
  if (typeof patch.on === "boolean") db.on = patch.on;
  if (typeof patch.time === "string" && HHMM.test(patch.time)) db.time = patch.time;
  if (Array.isArray(patch.accountIds)) db.accountIds = patch.accountIds.filter((id) => typeof id === "string").slice(0, 10);
  if (Number.isFinite(Number(patch.minScore))) db.minScore = Math.min(100, Math.max(50, Math.round(Number(patch.minScore))));
  if (Number.isFinite(Number(patch.perRun))) db.perRun = Math.min(7, Math.max(1, Math.round(Number(patch.perRun))));
  await persist();
  return getSettings();
}

let running = null;

/**
 * Line up the next batch: up to `perRun` qualifying clips, one a day at the chosen time, always after whatever is
 * already on the calendar. Returns what it scheduled.
 * @param force  run even when auto-post is switched off (the "Schedule now" button)
 */
export async function runAutoPost({ force = false, now = new Date() } = {}) {
  await load();
  if (running) return running;
  running = (async () => {
    const scheduled = [];
    let message = null;
    try {
      if (!db.on && !force) return { scheduled, message: "Auto-post is off" };
      const accounts = await listAccounts();
      const accountIds = db.accountIds.filter((id) => accounts.some((a) => a.id === id));
      if (!accountIds.length) {
        message = accounts.length ? "Pick which account auto-post should use" : "Connect an account first";
        return { scheduled, message };
      }
      const queue = await eligibleClips({ minScore: db.minScore });
      if (!queue.length) {
        message = `No clips at ${db.minScore}+ waiting`;
        return { scheduled, message };
      }
      const slots = nextSlots(await listPosts(), db.time, Math.min(db.perRun, queue.length), now);
      for (const [i, pick] of queue.slice(0, slots.length).entries()) {
        const post = await createPost({
          projectId: pick.projectId,
          projectName: pick.projectName,
          clipId: pick.clipId,
          title: pick.title,
          file: pick.file,
          duration: pick.duration,
          caption: [pick.caption, (pick.hashtags || []).join(" ")].filter(Boolean).join("\n\n"),
          accountIds,
          scheduledAt: slots[i].toISOString(),
          clip: { title: pick.title, score: pick.score, ratings: pick.clip.ratings ?? null, payoff: pick.clip.payoff ?? null, reason: pick.clip.reason ?? null, duration: pick.duration, style: pick.clip.design?.style ?? null, reviewScore: pick.reviewScore, kind: "clip", auto: true },
        });
        scheduled.push({ postId: post.id, title: pick.title, score: pick.score, at: slots[i].toISOString(), projectId: pick.projectId, clipId: pick.clipId });
      }
      message = scheduled.length ? `Scheduled ${scheduled.length} clip${scheduled.length === 1 ? "" : "s"}, one a day` : "Every day ahead already has a post";
      return { scheduled, message };
    } finally {
      db.lastRunAt = new Date().toISOString();
      db.lastMessage = message;
      if (scheduled.length) db.history = [...(db.history || []), ...scheduled].slice(-50);
      await persist();
    }
  })().finally(() => (running = null));
  return running;
}

/** Look every 20 minutes (and shortly after start) for clips to line up. */
export function startAutoPost() {
  const tick = () => runAutoPost().catch((err) => console.error("[auto-post]", err.message));
  setTimeout(tick, 45_000);
  return setInterval(tick, EVERY_MIN * 60_000);
}
