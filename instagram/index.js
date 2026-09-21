// Instagram for Clip Studio: account connection, the PUBLISHERS.instagram publisher, composer helpers and upkeep.
// How it plugs in and what it guarantees: shared/CONTRACT.md
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { createInstagramClient } from "./instagram.js";
import { createMaintenance } from "./maintenance.js";
import { createPublisher, findConnection } from "./publisher.js";
import { LIMITS, checkReel } from "./reel.js";
import { isValidTimeZone, nextSlots, normalizeSlots } from "./slots.js";
import { createStore } from "./store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SLOTS = ["09:00", "13:00", "19:00"];
const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (message) => new HttpError(400, message);
const notFound = (what) => new HttpError(404, `${what} not found.`);

const publicConnection = ({ accessToken, ...conn }) => ({ ...conn, connected: Boolean(accessToken) });
const publicJob = ({ mediaPath, caption, ...job }) => job;

export function createInstagramIntegration({ dataDir, projectsDir, env = process.env, fetch, log = console, now = () => new Date(), check = checkReel, publisherOptions }) {
  if (!dataDir) throw new Error("createInstagramIntegration needs a dataDir.");
  const store = createStore(path.join(dataDir, "instagram.json"));
  const ig = createInstagramClient({
    appId: env.IG_APP_ID,
    appSecret: env.IG_APP_SECRET,
    redirectUri: env.IG_REDIRECT_URI,
    apiVersion: env.IG_API_VERSION || undefined,
    fetch,
  });
  const publisher = createPublisher({ store, ig, mediaDir: path.join(dataDir, "uploads"), log, now, check, ...publisherOptions });
  const upkeep = createMaintenance({ store, ig, log, now });
  const oauthStates = new Map();
  const nowIso = () => now().toISOString();

  function upsertConnection(profile, { accessToken, expiresIn, timeZone }) {
    return store.update((s) => {
      let conn = s.connections.find((c) => c.id === profile.id);
      if (!conn) {
        conn = { id: profile.id, slots: DEFAULT_SLOTS, timeZone: isValidTimeZone(timeZone) ? timeZone : SERVER_TZ, dailyLimit: 3, connectedAt: nowIso() };
        s.connections.push(conn);
      }
      Object.assign(conn, profile, {
        accessToken,
        tokenIssuedAt: nowIso(),
        // Dashboard-generated tokens last 60 days; the first refresh replaces this estimate with the real expiry.
        tokenExpiresAt: new Date(now().getTime() + (expiresIn ?? 60 * 86400) * 1000).toISOString(),
        tokenExpiryEstimated: !expiresIn,
        tokenCheckedAt: null,
        tokenError: null,
        profileSyncedAt: nowIso(),
      });
      return publicConnection(conn);
    });
  }

  /** Next open posting times for a Clip Studio account, skipping `taken` (ISO strings already booked). */
  async function suggestTimes({ account, taken = [], count = 3 } = {}) {
    const conn = findConnection((await store.read()).connections, account);
    return nextSlots({
      slots: conn?.slots ?? DEFAULT_SLOTS,
      timeZone: conn?.timeZone || SERVER_TZ,
      dailyLimit: conn?.dailyLimit || 0,
      taken: (Array.isArray(taken) ? taken : []).map((t) => Date.parse(t)).filter(Number.isFinite),
      from: now(),
      count: Math.min(20, Math.max(1, Math.round(Number(count)) || 3)),
    }).map((d) => d.toISOString());
  }

  function resolveVideoPath({ videoPath, projectId, file }) {
    if (typeof videoPath === "string" && path.isAbsolute(videoPath)) return videoPath;
    if (projectsDir && projectId && file) {
      const resolved = path.resolve(projectsDir, String(projectId), String(file));
      if (resolved.startsWith(path.resolve(projectsDir) + path.sep)) return resolved;
    }
    throw bad("Send `videoPath` as an absolute path, or `projectId` and `file`.");
  }

  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  // ---------- connect page ----------

  router.use("/ui", express.static(path.join(HERE, "public")));
  router.get("/connect", (req, res) => {
    // The page loads its assets relative to /connect, so a trailing slash would break them.
    if (req.path.endsWith("/")) return res.redirect(301, `${req.baseUrl}/connect`);
    res.sendFile(path.join(HERE, "public", "connect.html"));
  });

  // ---------- accounts ----------

  router.get("/status", async (_req, res) => {
    res.json({
      oauth: ig.oauthConfigured,
      limits: LIMITS,
      serverTimeZone: SERVER_TZ,
      defaultSlots: DEFAULT_SLOTS,
      accounts: (await store.read()).connections.map(publicConnection),
    });
  });

  router.get("/accounts", async (_req, res) => res.json((await store.read()).connections.map(publicConnection)));

  router.post("/accounts", async (req, res) => {
    const pasted = String(req.body.accessToken || "").trim();
    if (!pasted) throw bad("Paste an Instagram access token.");
    let accessToken = pasted;
    let expiresIn = null;
    if (env.IG_APP_SECRET) {
      // Short-lived tokens get upgraded to 60-day ones. Long-lived tokens make this call fail, which is fine.
      ({ accessToken, expiresIn } = await ig.exchangeForLongLived(pasted).catch(() => ({ accessToken: pasted, expiresIn: null })));
    }
    const profile = await ig.getProfile(accessToken).catch((err) => {
      throw bad(`Instagram didn't accept that token: ${err.message}`);
    });
    res.status(201).json(await upsertConnection(profile, { accessToken, expiresIn, timeZone: req.body.timeZone }));
  });

  router.patch("/accounts/:id", async (req, res) => {
    const { slots, timeZone, dailyLimit } = req.body;
    const conn = await store.update((s) => {
      const c = s.connections.find((x) => x.id === req.params.id);
      if (!c) throw notFound("Account");
      if (slots !== undefined) c.slots = normalizeSlots(slots);
      if (timeZone !== undefined) {
        if (!isValidTimeZone(timeZone)) throw bad(`Unknown timezone "${timeZone}".`);
        c.timeZone = timeZone;
      }
      if (dailyLimit !== undefined) {
        const n = Number(dailyLimit);
        if (!Number.isInteger(n) || n < 0 || n > 50) throw bad("Max posts per day must be a whole number from 0 (no limit) to 50.");
        c.dailyLimit = n;
      }
      return publicConnection(c);
    }).catch((err) => {
      throw err.status ? err : bad(err.message); // normalizeSlots throws plain Errors with user-facing messages
    });
    res.json(conn);
  });

  router.post("/accounts/:id/sync", async (req, res) => {
    const conn = (await store.read()).connections.find((c) => c.id === req.params.id);
    if (!conn) throw notFound("Account");
    const profile = await ig.getProfile(conn.accessToken);
    res.json(
      await store.update((s) => {
        const c = s.connections.find((x) => x.id === req.params.id);
        Object.assign(c, profile, { profileSyncedAt: nowIso() });
        return publicConnection(c);
      }),
    );
  });

  /** Forgets the token here. Nothing changes on Instagram. */
  router.delete("/accounts/:id", async (req, res) => {
    await store.update((s) => {
      const i = s.connections.findIndex((c) => c.id === req.params.id);
      if (i < 0) throw notFound("Account");
      s.connections.splice(i, 1);
    });
    res.json({ ok: true });
  });

  router.get("/oauth/start", (_req, res) => {
    if (!ig.oauthConfigured) throw bad("Set IG_APP_ID, IG_APP_SECRET and IG_REDIRECT_URI in .env to log in with Instagram.");
    for (const [key, expires] of oauthStates) if (expires < Date.now()) oauthStates.delete(key);
    const state = crypto.randomBytes(16).toString("hex");
    oauthStates.set(state, Date.now() + 10 * 60_000);
    res.redirect(ig.authorizeUrl(state));
  });

  router.get("/oauth/callback", async (req, res) => {
    const back = (params) => res.redirect(`${req.baseUrl}/connect?${new URLSearchParams(params)}`);
    const { code, state, error_description: denied } = req.query;
    if (!state || !oauthStates.has(state)) return back({ error: "That login link expired. Try connecting again." });
    oauthStates.delete(state);
    if (!code) return back({ error: denied || "Instagram login was canceled." });
    try {
      const { accessToken, expiresIn } = await ig.exchangeCode(String(code));
      const profile = await ig.getProfile(accessToken);
      await upsertConnection(profile, { accessToken, expiresIn });
      back({ connected: profile.username });
    } catch (err) {
      back({ error: err.message });
    }
  });

  // ---------- composer helpers ----------

  router.post("/check", async (req, res) => res.json(await check({ caption: req.body.caption, videoPath: resolveVideoPath(req.body) })));

  router.get("/suggested-times", async (req, res) => {
    const { igUserId, handle, taken, count } = req.query;
    res.json({ times: await suggestTimes({ account: { igUserId, handle }, taken: taken ? String(taken).split(",") : [], count }) });
  });

  // ---------- publish records ----------

  router.get("/publications", async (req, res) => {
    const { postId, accountId } = req.query;
    const jobs = (await store.read()).jobs.filter((j) => (!postId || j.postId === postId) && (!accountId || j.accountId === accountId));
    res.json(jobs.map(publicJob));
  });

  router.post("/publications/:postId/:accountId/insights", async (req, res) => {
    const job = await upkeep.refreshInsightsFor(`${req.params.postId}:${req.params.accountId}`).catch((err) => {
      throw err.name === "InstagramError" ? err : bad(err.message);
    });
    res.json(publicJob(job));
  });

  router.use((err, _req, res, _next) => {
    const status = err.status || (err.name === "InstagramError" ? 502 : 500);
    if (status >= 500) log.error("[instagram]", err);
    res.status(status).json({ error: status === 500 ? "Something went wrong in the Instagram integration." : err.message });
  });

  return {
    router,
    publish: publisher.publish,
    /** True when this Clip Studio account links to a connected Instagram login, i.e. publish() can post for it. */
    canPublish: async (account) => Boolean(findConnection((await store.read()).connections, account)?.accessToken),
    checkReel: ({ caption, videoPath }) => check({ caption, videoPath }),
    suggestTimes,
    start: () => upkeep.start(),
    stop: () => upkeep.stop(),
    store,
  };
}
