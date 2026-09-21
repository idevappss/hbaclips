// Background upkeep: refreshes 60-day tokens before they lapse and pulls insights for recently published Reels.
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const TOKEN_REFRESH_WINDOW_DAYS = 10;
const TOKEN_CHECK_EVERY_MIN = 12 * 60;
const INSIGHTS_EVERY_MIN = 180;
const INSIGHTS_FOR_DAYS = 30;

export function createMaintenance({ store, ig, log = console, now = () => new Date(), everyMs = 10 * MIN }) {
  let timer = null;
  let running = null;
  const nowIso = () => now().toISOString();

  const patch = (collection, match, values) =>
    store.update((s) => {
      const item = s[collection].find(match);
      if (item) Object.assign(item, values);
      return item && { ...item };
    });

  async function refreshTokens() {
    const t = now().getTime();
    for (const conn of (await store.read()).connections) {
      if (!conn.accessToken) continue;
      const expiresAt = conn.tokenExpiresAt ? Date.parse(conn.tokenExpiresAt) : null;
      // A pasted token's real expiry is unknown until the first refresh reports it, so refresh those as soon as allowed.
      if (expiresAt && !conn.tokenExpiryEstimated && expiresAt - t > TOKEN_REFRESH_WINDOW_DAYS * DAY) continue;
      if (conn.tokenIssuedAt && t - Date.parse(conn.tokenIssuedAt) < DAY) continue; // Instagram won't refresh tokens younger than 24h
      if (conn.tokenCheckedAt && t - Date.parse(conn.tokenCheckedAt) < TOKEN_CHECK_EVERY_MIN * MIN) continue;
      try {
        const { accessToken, expiresIn } = await ig.refreshToken(conn);
        await patch("connections", (c) => c.id === conn.id, {
          accessToken,
          tokenIssuedAt: nowIso(),
          tokenExpiresAt: new Date(t + expiresIn * 1000).toISOString(),
          tokenExpiryEstimated: false,
          tokenCheckedAt: nowIso(),
          tokenError: null,
        });
        log.info(`[instagram] refreshed the token for @${conn.username}`);
      } catch (err) {
        await patch("connections", (c) => c.id === conn.id, { tokenCheckedAt: nowIso(), tokenError: err.message });
        log.warn(`[instagram] couldn't refresh the token for @${conn.username}: ${err.message}`);
      }
    }
  }

  /** Pull current metrics for one publish record. Throws if Instagram refuses. */
  async function refreshInsightsFor(key) {
    const state = await store.read();
    const job = state.jobs.find((j) => j.key === key);
    if (!job) throw new Error("Publish record not found.");
    if (job.status !== "published" || !job.mediaId) throw new Error("Insights are available once the Reel is live.");
    const conn = state.connections.find((c) => c.id === job.igUserId);
    if (!conn?.accessToken) throw new Error(`@${job.username} isn't connected anymore.`);
    const insights = await ig.mediaInsights(conn, job.mediaId);
    return patch("jobs", (j) => j.key === key, { insights, insightsAt: nowIso(), insightsError: null });
  }

  async function refreshInsights() {
    const t = now().getTime();
    for (const job of (await store.read()).jobs) {
      if (job.status !== "published" || !job.mediaId) continue;
      if (t - Date.parse(job.publishedAt) > INSIGHTS_FOR_DAYS * DAY) continue;
      if (job.insightsAt && t - Date.parse(job.insightsAt) < INSIGHTS_EVERY_MIN * MIN) continue;
      await refreshInsightsFor(job.key).catch((err) => patch("jobs", (j) => j.key === job.key, { insightsAt: nowIso(), insightsError: err.message }));
    }
  }

  function tick() {
    running ??= (async () => {
      try {
        await refreshTokens();
        await refreshInsights();
      } catch (err) {
        log.error("[instagram] upkeep failed:", err);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    tick,
    refreshInsightsFor,
    start() {
      if (timer) return;
      timer = setInterval(tick, everyMs);
      tick();
    },
    stop() {
      clearInterval(timer);
      timer = null;
      return running;
    },
  };
}
