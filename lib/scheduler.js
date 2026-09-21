// Social accounts and scheduled posts, persisted to data/scheduler.json.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { PROJECTS_DIR, ROOT } from "./tools.js";

const FILE = path.join(ROOT, "data", "scheduler.json");

export const PLATFORMS = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube Shorts",
  x: "X",
  facebook: "Facebook",
  linkedin: "LinkedIn",
};

/**
 * Auto-publishers keyed by platform (see shared/CONTRACT.md):
 *   async ({ post, account, videoPath }) => ({ mediaId, permalink, publishedAt, username })
 * They throw on failure; `err.retryable` marks errors worth another attempt.
 * Platforms without one move to "due" at their time for a manual post.
 */
export const PUBLISHERS = {};

/**
 * Optional per-platform check: async (account) => boolean. When it says no (e.g. an Instagram account
 * that isn't linked to a connected login), the post goes to "due" for a manual post instead of failing.
 */
export const CAN_PUBLISH = {};

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 5 * 60_000;

let db;
let writes = Promise.resolve();
const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString("hex")}`;

async function load() {
  if (!db) {
    try {
      db = JSON.parse(await fs.readFile(FILE, "utf8"));
    } catch {
      db = { accounts: [], posts: [] };
    }
    // First load happens at boot: a publish that was in flight when the server stopped goes back
    // on the schedule. Publishers are idempotent per (post, account), so this can't double-post.
    for (const post of db.posts) for (const t of post.targets) if (t.status === "publishing") t.status = "scheduled";
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
    .catch((err) => console.error("Saving the schedule failed:", err));
  return writes;
}

export function postStatus(post) {
  const statuses = post.targets.map((t) => t.status);
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("due")) return "due";
  if (statuses.includes("publishing")) return "publishing";
  if (statuses.includes("scheduled")) return "scheduled";
  return "published";
}

const withStatus = (post) => ({ ...post, status: postStatus(post) });

function parseWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Pick a valid date and time.");
  return date.toISOString();
}

function checkAccounts(accountIds) {
  const ids = [...new Set(Array.isArray(accountIds) ? accountIds : [])];
  if (!ids.length) throw new Error("Choose at least one account.");
  for (const id of ids) {
    if (!db.accounts.some((a) => a.id === id)) throw new Error("One of the selected accounts no longer exists.");
  }
  return ids;
}

// ---------- accounts ----------

export async function listAccounts() {
  return (await load()).accounts;
}

export async function addAccount({ platform, name, handle }) {
  await load();
  if (!PLATFORMS[platform]) throw new Error("Pick a platform.");
  const cleanName = String(name || "").trim().slice(0, 60);
  if (!cleanName) throw new Error("Give the account a name.");
  const account = {
    id: newId("acct"),
    platform,
    name: cleanName,
    handle: String(handle || "").trim().replace(/^@+/, "").slice(0, 60),
    createdAt: new Date().toISOString(),
  };
  db.accounts.push(account);
  await persist();
  return account;
}

export async function removeAccount(id) {
  await load();
  if (!db.accounts.some((a) => a.id === id)) throw new Error("Account not found");
  db.accounts = db.accounts.filter((a) => a.id !== id);
  // Take the account off anything that hasn't gone out; published history stays.
  for (const post of db.posts) post.targets = post.targets.filter((t) => t.accountId !== id || t.status === "published");
  db.posts = db.posts.filter((p) => p.targets.length);
  await persist();
}

// ---------- posts ----------

export async function listPosts() {
  return (await load()).posts.map(withStatus).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

export async function createPost({ projectId, projectName, clipId, title, file, duration, caption, accountIds, scheduledAt, clip = null }) {
  await load();
  const post = {
    id: newId("post"),
    projectId,
    projectName,
    clipId,
    title,
    file,
    duration,
    caption: String(caption || "").slice(0, 5000),
    // Why this clip was picked, kept with the post so its results can teach picking later (lib/performance.js).
    ...(clip ? { clip } : {}),
    scheduledAt: parseWhen(scheduledAt),
    targets: checkAccounts(accountIds).map((accountId) => ({ accountId, status: "scheduled" })),
    createdAt: new Date().toISOString(),
  };
  db.posts.push(post);
  await persist();
  kickTick();
  return withStatus(post);
}

export async function updatePost(id, { caption, accountIds, scheduledAt }) {
  await load();
  const post = db.posts.find((p) => p.id === id);
  if (!post) throw new Error("Post not found");
  if (typeof caption === "string") post.caption = caption.slice(0, 5000);
  if (accountIds !== undefined) {
    post.targets = checkAccounts(accountIds).map(
      (accountId) => post.targets.find((t) => t.accountId === accountId) || { accountId, status: "scheduled" },
    );
  }
  if (scheduledAt !== undefined) {
    post.scheduledAt = parseWhen(scheduledAt);
    // Moving a post into the future puts its unposted accounts back on the schedule.
    if (new Date(post.scheduledAt) > new Date()) {
      for (const t of post.targets) {
        if (t.status === "due" || t.status === "failed") Object.assign(t, { status: "scheduled", error: undefined, attempts: 0, retryAt: undefined });
      }
    }
  }
  await persist();
  kickTick();
  return withStatus(post);
}

/** Mark one account's copy of a post as posted (or undo it). */
export async function setPublished(postId, accountId, published) {
  await load();
  const post = db.posts.find((p) => p.id === postId);
  const target = post?.targets.find((t) => t.accountId === accountId);
  if (!target) throw new Error("Post not found");
  if (published) {
    Object.assign(target, { status: "published", publishedAt: new Date().toISOString(), error: undefined });
  } else {
    Object.assign(target, { status: new Date(post.scheduledAt) <= new Date() ? "due" : "scheduled", publishedAt: undefined });
  }
  await persist();
  return withStatus(post);
}

export async function deletePost(id) {
  await load();
  const before = db.posts.length;
  db.posts = db.posts.filter((p) => p.id !== id);
  if (db.posts.length === before) throw new Error("Post not found");
  await persist();
}

/** Drop every post made from a deleted project — its video files are gone. */
export async function removePostsForProject(projectId) {
  await load();
  const before = db.posts.length;
  db.posts = db.posts.filter((p) => p.projectId !== projectId);
  if (db.posts.length !== before) await persist();
}

let ticking = false;

/** Run a tick without making the caller wait for it (publishes can take many minutes). */
function kickTick() {
  tick().catch((err) => console.error("Scheduler tick failed:", err));
}

/**
 * Hand posts whose time has come to their platform's publisher, or mark them due for a manual post.
 * A target flips to "publishing" (persisted) before its publisher starts, so overlapping ticks never
 * pick it up twice; the publish itself runs in the background.
 */
export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await load();
    const now = Date.now();
    const jobs = [];
    let changed = false;
    for (const post of db.posts) {
      if (new Date(post.scheduledAt).getTime() > now) continue;
      for (const target of post.targets) {
        if (target.status !== "scheduled") continue;
        if (target.retryAt && new Date(target.retryAt).getTime() > now) continue;
        const account = db.accounts.find((a) => a.id === target.accountId);
        const canPublish = account && CAN_PUBLISH[account.platform];
        const publish =
          account && PUBLISHERS[account.platform] && (!canPublish || (await canPublish(account).catch(() => false)))
            ? PUBLISHERS[account.platform]
            : null;
        target.status = publish ? "publishing" : "due";
        if (publish) jobs.push({ post, target, account, publish });
        changed = true;
      }
    }
    if (changed) await persist();
    for (const job of jobs) publishTarget(job);
  } finally {
    ticking = false;
  }
}

async function publishTarget({ post, target, account, publish }) {
  try {
    const result = await publish({ post, account, videoPath: path.join(PROJECTS_DIR, post.projectId, post.file) });
    Object.assign(target, {
      status: "published",
      publishedAt: result?.publishedAt || new Date().toISOString(),
      permalink: result?.permalink,
      mediaId: result?.mediaId,
      error: undefined,
      retryAt: undefined,
    });
  } catch (err) {
    target.attempts = (target.attempts || 0) + 1;
    if (err.retryable && target.attempts < MAX_ATTEMPTS) {
      Object.assign(target, { status: "scheduled", error: err.message, retryAt: new Date(Date.now() + RETRY_BASE_MS * target.attempts).toISOString() });
    } else {
      Object.assign(target, { status: "failed", error: err.message, retryAt: undefined });
    }
  }
  await persist();
}

export async function summary() {
  const posts = await listPosts();
  const now = Date.now();
  return {
    due: posts.reduce((n, p) => n + p.targets.filter((t) => t.status === "due" || t.status === "failed").length, 0),
    upcoming: posts.filter((p) => new Date(p.scheduledAt).getTime() > now).length,
  };
}
