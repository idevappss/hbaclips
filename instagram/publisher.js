// Publishes one HBA Clips post to one Instagram account: container → upload → processing → publish.
//
// publish() is idempotent per (post.id, account.id). Each step is saved as it happens, so calling again —
// an overlapping scheduler tick, or a retry after a restart — resumes the earlier attempt or returns its
// result. A new container is only created once the previous one provably can't go live, so nothing posts twice.
import fs from "node:fs/promises";
import path from "node:path";
import { checkReel } from "./reel.js";

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [5_000, 30_000];
const MIN = 60_000;

export class PublishError extends Error {
  constructor(message, { retryable = false, code } = {}) {
    super(message);
    this.name = "PublishError";
    this.retryable = retryable;
    if (code) this.code = code;
  }
}

const cleanHandle = (handle) => String(handle || "").trim().replace(/^@+/, "").toLowerCase();

/** The connected Instagram login behind a HBA Clips account: by igUserId, else by matching handle. */
export function findConnection(connections, account) {
  if (!account) return null;
  if (account.igUserId) return connections.find((c) => c.id === String(account.igUserId)) || null;
  const handle = cleanHandle(account.handle);
  return (handle && connections.find((c) => cleanHandle(c.username) === handle)) || null;
}

export function createPublisher({
  store,
  ig,
  mediaDir,
  log = console,
  now = () => new Date(),
  pollMs = 10_000,
  processingTimeoutMs = 15 * MIN,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  check = checkReel,
}) {
  const running = new Map();
  const nowIso = () => now().toISOString();

  const saveJob = (key, patch) =>
    store.update((s) => {
      let job = s.jobs.find((j) => j.key === key);
      if (!job) {
        job = { key, createdAt: nowIso() };
        s.jobs.push(job);
      }
      Object.assign(job, patch, { updatedAt: nowIso() });
      return { ...job };
    });

  async function failJob(key, message, { retryable, code, ...patch } = {}) {
    await saveJob(key, { ...patch, status: "failed", error: message, retryable: Boolean(retryable) });
    log.warn(`[instagram] ${key}: ${message}`);
    return new PublishError(message, { retryable, code });
  }

  const resultOf = (job) => ({ mediaId: job.mediaId, permalink: job.permalink, publishedAt: job.publishedAt, username: job.username });

  function publish({ post, account, videoPath }) {
    if (!post?.id || !account?.id) return Promise.reject(new PublishError("publish() needs a post and an account."));
    const key = `${post.id}:${account.id}`;
    if (!running.has(key)) running.set(key, run(key, { post, account, videoPath }).finally(() => running.delete(key)));
    return running.get(key);
  }

  async function run(key, { post, account, videoPath }) {
    const state = await store.read();
    const conn = findConnection(state.connections, account);
    const base = { postId: post.id, accountId: account.id };
    if (!conn?.accessToken) {
      const who = cleanHandle(account.handle) ? `@${cleanHandle(account.handle)}` : account.name || "This account";
      throw await failJob(key, `${who} isn't connected to Instagram yet. Connect it on the Instagram page, then try again.`, { ...base, code: "not_connected" });
    }
    Object.assign(base, { igUserId: conn.id, username: conn.username });

    const job = state.jobs.find((j) => j.key === key);
    if (job?.status === "published") return resultOf(job);
    if (job?.containerId) {
      const resumed = await resume(key, conn, job);
      if (resumed) return resumed;
    }

    const caption = String(post.caption ?? "");
    const checked = await check({ caption, videoPath });
    if (!checked.ok) throw await failJob(key, checked.errors.join(" "), base);

    for (let attempt = 1; ; attempt++) {
      try {
        return await attempt_(key, conn, { ...base, caption, videoPath, thumbOffsetMs: post.thumbOffsetMs });
      } catch (err) {
        // PublishErrors are already recorded and may follow a media_publish call, so they're never retried here.
        if (err instanceof PublishError) throw err;
        if (err.permanent || attempt >= MAX_ATTEMPTS) {
          // A video Instagram failed to process three times in a row won't fare better later.
          throw await failJob(key, err.message, { retryable: !err.permanent && !err.processingFailed });
        }
        log.warn(`[instagram] ${key}: ${err.message} Retrying (${attempt}/${MAX_ATTEMPTS - 1})…`);
        await sleep(RETRY_DELAYS_MS[attempt - 1]);
      }
    }
  }

  /** An earlier attempt left a container behind. Returns a result if that attempt can be finished, or null to start over. */
  async function resume(key, conn, job) {
    let statusCode = null;
    try {
      ({ statusCode } = await ig.containerStatus(conn, job.containerId));
    } catch (err) {
      // Before media_publish was requested, an old container can't go live on its own, so it's safe to abandon.
      if (job.step !== "publishing") return null;
      throw await failJob(key, `Couldn't check whether the earlier attempt already posted: ${err.message}`, { retryable: !err.permanent });
    }
    if (statusCode === "PUBLISHED") return markPublished(key, conn, job, await findPublishedMedia(conn, job));
    if (statusCode === "FINISHED" || (statusCode === "IN_PROGRESS" && ["processing", "publishing"].includes(job.step))) {
      log.info(`[instagram] ${key}: resuming container ${job.containerId}`);
      return finish(key, conn, await saveJob(key, { status: "publishing", error: null, retryable: null }));
    }
    return null; // ERROR, EXPIRED, or an upload that never completed
  }

  /** One fresh container. Throws plain errors only before media_publish, so the caller may retry those. */
  async function attempt_(key, conn, info) {
    const limit = await ig.publishingLimit(conn).catch(() => null);
    if (limit?.quotaTotal && limit.quotaUsage >= limit.quotaTotal) {
      throw await failJob(key, `@${conn.username} has hit Instagram's limit of ${limit.quotaTotal} API posts in 24 hours. Try again later.`, { retryable: true });
    }

    // Upload a private copy so a re-render can't swap the file mid-upload. On APFS this is a free clone.
    await fs.mkdir(mediaDir, { recursive: true });
    const snapshot = path.join(mediaDir, `${key.replace(/[^\w.-]/g, "_")}${path.extname(info.videoPath).toLowerCase()}`);
    await fs.copyFile(info.videoPath, snapshot, fs.constants.COPYFILE_FICLONE);

    const prior = (await store.read()).jobs.find((j) => j.key === key);
    let job = await saveJob(key, {
      postId: info.postId,
      accountId: info.accountId,
      igUserId: info.igUserId,
      username: info.username,
      status: "publishing",
      step: "creating",
      containerId: null,
      attempts: (prior?.attempts || 0) + 1,
      startedAt: nowIso(),
      caption: info.caption,
      mediaPath: snapshot,
      error: null,
      retryable: null,
    });

    const container = await ig.createReelContainer(conn, { caption: info.caption, shareToFeed: true, thumbOffsetMs: info.thumbOffsetMs });
    job = await saveJob(key, { step: "uploading", containerId: container.id });
    await ig.uploadVideo(conn, { uri: container.uri, filePath: snapshot });
    job = await saveJob(key, { step: "processing" });
    return finish(key, conn, job);
  }

  async function finish(key, conn, job) {
    const deadline = now().getTime() + processingTimeoutMs;
    let misses = 0;
    for (;;) {
      let statusCode;
      let status;
      try {
        ({ statusCode, status } = await ig.containerStatus(conn, job.containerId));
        misses = 0;
      } catch (err) {
        if (err.permanent || ++misses >= 5) {
          throw await failJob(key, `Lost contact with Instagram while it processed the video: ${err.message}`, { retryable: !err.permanent });
        }
        await sleep(pollMs);
        continue;
      }

      if (statusCode === "FINISHED") {
        job = await saveJob(key, { step: "publishing" });
        let published;
        try {
          published = await ig.publishContainer(conn, job.containerId);
        } catch (err) {
          // It may have gone through anyway; the next call checks the container before doing anything else.
          throw await failJob(key, `Instagram didn't confirm the post: ${err.message}`, { retryable: !err.permanent });
        }
        return markPublished(key, conn, job, published.id);
      }
      if (statusCode === "PUBLISHED") return markPublished(key, conn, job, await findPublishedMedia(conn, job));
      if (statusCode === "ERROR" || statusCode === "EXPIRED") {
        if (job.step === "publishing") {
          throw await failJob(key, `Instagram rejected the video after processing (${status || statusCode}).`, { retryable: true });
        }
        throw Object.assign(new Error(`Instagram couldn't process the video${status ? ` (${status})` : ""}.`), { processingFailed: true });
      }
      if (now().getTime() >= deadline) {
        throw await failJob(key, "Instagram is still processing the video. Trying again will pick up where it left off.", { retryable: true });
      }
      await sleep(pollMs);
    }
  }

  async function findPublishedMedia(conn, job) {
    const since = Date.parse(job.startedAt || 0) - 5 * MIN;
    const recent = await ig.recentMedia(conn, 25).catch(() => []);
    return recent.find((m) => (m.caption || "") === (job.caption || "") && Date.parse(m.timestamp) >= since)?.id ?? null;
  }

  async function markPublished(key, conn, job, mediaId) {
    const media = mediaId ? await ig.getMedia(conn, mediaId).catch(() => null) : null;
    const done = await saveJob(key, {
      status: "published",
      step: null,
      mediaId,
      permalink: media?.permalink ?? null,
      publishedAt: media?.timestamp ? new Date(media.timestamp).toISOString() : nowIso(),
      error: null,
      retryable: null,
    });
    if (done.mediaPath) await fs.rm(done.mediaPath, { force: true });
    log.info(`[instagram] published ${key} to @${conn.username}${done.permalink ? ` → ${done.permalink}` : ""}`);
    return resultOf(done);
  }

  return { publish };
}
