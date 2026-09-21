// Analytics: how every connected channel is actually doing. YouTube channels are read from the public
// Data API and snapshotted daily so growth, gains and the chart are real measurements rather than guesses.
// Instagram numbers come from the Instagram module's own insights, which the tab reads over HTTP.
// Owned by the ANALYTICS session.
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ROOT } from "../lib/tools.js";
import { fetchChannel, hasKey, resolveChannelId } from "./youtube.js";
import { fetchChannelKeyless, resolveChannelIdKeyless } from "./scrape.js";
import { change, createStore, series, totalPercent } from "./store.js";
import { channelInsights } from "./insights.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(ROOT, "data", "analytics");

const REFRESH_EVERY = 30 * 60 * 1000; // how often the loop looks for stale channels
const STALE_AFTER = 6 * 60 * 60 * 1000; // a channel is re-read this long after its last read
export const RANGES = { "7d": 7, "30d": 30, "3m": 90, "6m": 180, "1y": 365 };

const pct = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

/**
 * With an API key, channels are read from the YouTube Data API: 200 uploads, tags, comment counts, topics.
 * Without one, they're read from what YouTube serves the public anyway — the RSS feed and the channel page.
 * That covers every headline card; it sees only the last 15 uploads and carries no tags or comment counts.
 */
const read = {
  resolve: (input) => (hasKey() ? resolveChannelId(input) : resolveChannelIdKeyless(input)),
  channel: (id, opts) => (hasKey() ? fetchChannel(id, opts) : fetchChannelKeyless(id, opts)),
};

export function createAnalytics({ dataDir = DATA_DIR } = {}) {
  const store = createStore(dataDir);
  let timer = null;
  let running = null;
  let lastRefreshAt = null;

  // ---- reading one channel ------------------------------------------------

  /** Everything the stat cards show, measured against this channel's own history. */
  async function summarize(channel, { at = new Date() } = {}) {
    const { days } = await store.history(channel.id);
    const profile = channel.profile;
    const videos = channel.videos || [];
    const rpm = channel.rpm ?? (await store.settings()).rpm;

    const views7 = change(days, "views", 7, at);
    const views30 = change(days, "views", 30, at);
    const subs7 = change(days, "subs", 7, at);
    const videos7 = change(days, "videos", 7, at);

    // Earnings follow the last 30 days of views, scaled up when the history is younger than that.
    // With no history yet, the views on the last 30 days of uploads stand in.
    const since = at.getTime() - 30 * 86400000;
    const freshUploadViews = videos.filter((v) => Date.parse(v.publishedAt || 0) >= since).reduce((a, v) => a + v.views, 0);
    const monthlyViews = views30?.covered ? (views30.value / views30.covered) * 30 : freshUploadViews || null;
    const earningsFrom = views30?.covered ? (views30.partial ? "partial history" : "last 30 days") : "recent uploads";

    const recent7 = videos.filter((v) => Date.parse(v.publishedAt || 0) >= at.getTime() - 7 * 86400000);

    return {
      id: channel.id,
      kind: channel.kind,
      label: channel.label,
      compare: Boolean(channel.compare),
      addedAt: channel.addedAt,
      error: channel.error,
      platform: "youtube",
      title: profile?.title || channel.label || channel.id,
      handle: profile?.handle || null,
      avatar: profile?.avatar || null,
      url: profile?.url || `https://www.youtube.com/channel/${channel.id}`,
      country: profile?.country || null,
      category: profile?.category || null,
      topics: profile?.topics || [],
      startedAt: profile?.startedAt || null,
      fetchedAt: profile?.fetchedAt || null,
      source: profile?.source || "api",
      partial: profile?.partial || null,
      historyDays: Object.keys(days).length,
      cards: {
        totalViews: { value: profile?.stats.views ?? null, percent: pct(totalPercent(days, "views", 30, at)) },
        viewsGained: views7 ? { ...views7, percent: pct(views7.percent) } : null,
        subscribers: {
          value: profile?.stats.subs ?? null,
          hidden: Boolean(profile?.stats.subsHidden),
          percent: pct(totalPercent(days, "subs", 30, at)),
          gained: subs7 ? { ...subs7, percent: pct(subs7.percent) } : null,
        },
        earnings: { value: monthlyViews == null ? null : (monthlyViews / 1000) * rpm, monthlyViews, rpm, from: earningsFrom },
        videosPublished: { value: profile?.stats.videos ?? null, gained: videos7?.value ?? recent7.length },
        avgVideoLength: { seconds: profile?.avgDurationSec ?? null },
        uploadFrequency: { perWeek: profile?.uploadsPerWeek ?? null, shortsShare: profile?.shortsShare ?? null },
        newUploads: { count: recent7.length, views: recent7.reduce((a, v) => a + v.views, 0) },
      },
    };
  }

  async function detail(id, { at = new Date() } = {}) {
    const channel = await store.find(id);
    if (!channel) return null;
    const summary = await summarize(channel, { at });
    const [{ days }, { videos: videoRows }] = await Promise.all([store.history(id), store.videoHistory(id)]);
    const insights = channelInsights({
      videos: channel.videos || [],
      videoRows,
      days,
      stats: channel.profile?.stats || {},
      now: at,
    });
    const paceById = new Map(insights.paces.map((row) => [row.id, row]));
    const videos = (channel.videos || []).map((v) => {
      const ageDays = v.publishedAt ? Math.max(0.25, (at.getTime() - Date.parse(v.publishedAt)) / 86400000) : null;
      const pace = paceById.get(v.id) || null;
      return {
        ...v,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        viewsPerDay: ageDays ? Math.round(v.views / ageDays) : null,
        engagement: v.views ? ((v.likes + v.comments) / v.views) * 100 : null,
        likesPer1k: v.views ? (v.likes / v.views) * 1000 : null,
        multiple: insights.baseline && ageDays ? Math.round((v.views / ageDays / insights.baseline) * 100) / 100 : null,
        today: pace?.today ?? null,
        week: pace?.week ?? null,
        firstDayViews: pace?.sincePublish ? pace.firstDayViews : null,
        series: pace?.series || null,
      };
    });
    const { paces, ...rest } = insights;
    return { ...summary, videos, insights: rest };
  }

  // ---- refreshing ---------------------------------------------------------

  /** Read a channel from YouTube and write today's snapshot. Errors are kept on the channel, not thrown. */
  async function refreshChannel(id, { at = new Date() } = {}) {
    try {
      const profile = await read.channel(id, { now: at });
      await store.saveProfile(id, profile);
      await store.record(id, profile.stats, at);
      await store.recordVideos(id, profile.videos, at);
      return { id, ok: true };
    } catch (err) {
      await store.saveProfile(id, null, err);
      console.error(`[analytics] ${id}: ${err.message}`);
      return { id, ok: false, error: err.message, code: err.code || null };
    }
  }

  /** Refresh every channel that hasn't been read in the last six hours (or all of them, with force). */
  async function refresh({ force = false, id = null } = {}) {
    if (running) return running;
    running = (async () => {
      const at = new Date();
      const channels = (await store.list()).filter((c) => (id ? c.id === id : true));
      const stale = channels.filter((c) => force || id || !c.profile?.fetchedAt || at - Date.parse(c.profile.fetchedAt) > STALE_AFTER);
      const results = [];
      for (const channel of stale) results.push(await refreshChannel(channel.id, { at }));
      lastRefreshAt = new Date().toISOString();
      return { checked: channels.length, refreshed: results.length, results, at: lastRefreshAt };
    })();
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  function start() {
    if (timer) return;
    if (!hasKey()) console.log("[analytics] no YOUTUBE_API_KEY — reading public channel pages instead (last 15 uploads)");
    refresh().catch(() => {});
    timer = setInterval(() => refresh().catch(() => {}), REFRESH_EVERY);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // ---- HTTP ---------------------------------------------------------------

  const handle = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (err) {
      const status = err.code === "no_key" || err.code === "bad_key" ? 428 : err.code === "not_found" ? 404 : 400;
      res.status(status).json({ error: err.message, code: err.code || null });
    }
  };

  const router = express.Router();
  router.use(express.json({ limit: "256kb" }));
  router.use("/ui", express.static(path.join(HERE, "public"), { setHeaders: (res) => res.set("Cache-Control", "no-cache") }));

  router.get("/status", handle(async () => ({
    hasKey: hasKey(),
    source: hasKey() ? "api" : "keyless",
    settings: await store.settings(),
    channels: (await store.list()).length,
    lastRefreshAt,
    refreshing: Boolean(running),
  })));

  router.get("/", handle(async () => {
    const channels = await store.list();
    return {
      hasKey: hasKey(),
      source: hasKey() ? "api" : "keyless",
      settings: await store.settings(),
      lastRefreshAt,
      refreshing: Boolean(running),
      channels: await Promise.all(channels.map((c) => summarize(c))),
    };
  }));

  router.post("/channels", handle(async (req) => {
    const id = await read.resolve(req.body?.input ?? req.body?.url ?? req.body?.handle);
    const kind = req.body?.kind === "mine" ? "mine" : "competitor";
    await store.add({ id, kind, label: req.body?.label || null });
    await refreshChannel(id);
    return { channel: await detail(id) };
  }));

  router.get("/channels/:id", handle(async (req) => {
    const found = await detail(req.params.id);
    if (!found) {
      const err = new Error("That channel isn't tracked here.");
      err.code = "not_found";
      throw err;
    }
    return { channel: found };
  }));

  router.patch("/channels/:id", handle(async (req) => {
    const channel = await store.update(req.params.id, req.body || {});
    if (!channel) {
      const err = new Error("That channel isn't tracked here.");
      err.code = "not_found";
      throw err;
    }
    return { channel: await detail(req.params.id) };
  }));

  router.delete("/channels/:id", handle(async (req) => ({ removed: await store.remove(req.params.id) })));

  router.get("/channels/:id/series", handle(async (req) => {
    const { days } = await store.history(req.params.id);
    const metric = ["views", "subs", "videos"].includes(req.query.metric) ? req.query.metric : "views";
    const grain = req.query.grain === "monthly" ? "monthly" : "daily";
    const range = RANGES[req.query.range] || 30;
    const points = series(days, metric, { grain, range });
    return { id: req.params.id, metric, grain, range, points, total: points.reduce((a, p) => a + p.value, 0), historyDays: Object.keys(days).length };
  }));

  router.post("/refresh", handle(async (req) => refresh({ force: true, id: req.body?.id || null })));

  router.patch("/settings", handle(async (req) => ({ settings: await store.settings(req.body || {}) })));

  return { router, start, stop, refresh, detail, summarize, store, DATA_DIR: dataDir };
}

const analytics = createAnalytics();
export const { router, start, stop, refresh } = analytics;
export default analytics;
