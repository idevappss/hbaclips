// Tracked channels and their day-by-day history. YouTube's public API only ever reports lifetime totals,
// so "views gained", the growth percentages and the chart all come from snapshots this file keeps itself.
// data/analytics/channels.json  → { channels: [...], settings: {...} }
// data/analytics/history/<channelId>.json → { id, days: { "2026-09-20": { views, subs, videos, at } } }
// data/analytics/history/<channelId>.videos.json → { id, videos: { <videoId>: { publishedAt, firstSeen, days: {...} } } }
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DAY = 86400000;
export const today = (d = new Date()) => new Date(d).toISOString().slice(0, 10);
const dayBefore = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10);
const num = (n) => (Number.isFinite(n) ? n : null);

export function createStore(dataDir) {
  const FILE = path.join(dataDir, "channels.json");
  const HISTORY = path.join(dataDir, "history");
  let db;
  let writes = Promise.resolve();

  async function load() {
    if (!db) {
      let data = {};
      try {
        data = JSON.parse(await fs.readFile(FILE, "utf8"));
      } catch (err) {
        if (err.code !== "ENOENT") throw err; // a hand-edit broke the JSON — never overwrite it
      }
      db = {
        channels: Array.isArray(data.channels) ? data.channels : [],
        settings: { rpm: 2, ...(data.settings || {}) },
      };
    }
    return db;
  }

  function persist() {
    const snapshot = JSON.stringify(db, null, 2);
    writes = writes
      .then(async () => {
        await fs.mkdir(dataDir, { recursive: true });
        const tmp = `${FILE}.${crypto.randomBytes(4).toString("hex")}.tmp`;
        await fs.writeFile(tmp, snapshot);
        await fs.rename(tmp, FILE);
      })
      .catch((err) => console.error("[analytics] saving channels failed:", err));
    return writes;
  }

  // ---- channels -----------------------------------------------------------

  const list = async () => (await load()).channels;
  const find = async (id) => (await load()).channels.find((c) => c.id === id) || null;

  async function add({ id, kind = "competitor", label = null }) {
    const data = await load();
    const existing = data.channels.find((c) => c.id === id);
    if (existing) {
      if (kind === "mine") existing.kind = "mine";
      await persist();
      return existing;
    }
    const channel = { id, kind, label, rpm: null, addedAt: new Date().toISOString(), profile: null, error: null };
    data.channels.push(channel);
    await persist();
    return channel;
  }

  async function update(id, patch) {
    const channel = await find(id);
    if (!channel) return null;
    if (patch.kind === "mine" || patch.kind === "competitor") channel.kind = patch.kind;
    if ("label" in patch) channel.label = patch.label ? String(patch.label).slice(0, 80) : null;
    if ("rpm" in patch) channel.rpm = Number.isFinite(Number(patch.rpm)) && Number(patch.rpm) > 0 ? Number(patch.rpm) : null;
    if ("compare" in patch) channel.compare = Boolean(patch.compare);
    await persist();
    return channel;
  }

  async function remove(id) {
    const data = await load();
    const before = data.channels.length;
    data.channels = data.channels.filter((c) => c.id !== id);
    if (data.channels.length === before) return false;
    await persist();
    await Promise.all([
      fs.rm(path.join(HISTORY, `${id}.json`), { force: true }),
      fs.rm(path.join(HISTORY, `${id}.videos.json`), { force: true }),
    ]);
    return true;
  }

  async function saveProfile(id, profile, error = null) {
    const channel = await find(id);
    if (!channel) return null;
    if (profile) {
      const { videos, ...rest } = profile;
      channel.profile = rest;
      channel.videos = videos.slice(0, 60);
      channel.error = null;
    } else {
      channel.error = error ? { message: error.message, code: error.code || null, at: new Date().toISOString() } : null;
    }
    await persist();
    return channel;
  }

  async function settings(patch) {
    const data = await load();
    if (patch && Number.isFinite(Number(patch.rpm)) && Number(patch.rpm) >= 0) data.settings.rpm = Number(patch.rpm);
    if (patch) await persist();
    return data.settings;
  }

  // ---- history ------------------------------------------------------------

  async function history(id) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(HISTORY, `${id}.json`), "utf8"));
      return { id, days: data.days || {} };
    } catch {
      return { id, days: {} };
    }
  }

  /** One row per UTC day; a later read the same day replaces it, so each day holds its latest totals. */
  async function record(id, stats, at = new Date()) {
    const file = path.join(HISTORY, `${id}.json`);
    const data = await history(id);
    data.days[today(at)] = { views: stats.views, subs: stats.subs, videos: stats.videos, at: new Date(at).toISOString() };
    await fs.mkdir(HISTORY, { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, file);
    return data;
  }

  // Views per video per day, for the videos young enough to still be moving. This is what makes
  // "how is this clip doing right now" answerable — YouTube only ever reports a video's lifetime views.
  const VIDEO_WINDOW_DAYS = 60;
  const VIDEO_LIMIT = 120;

  async function videoHistory(id) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(HISTORY, `${id}.videos.json`), "utf8"));
      return { id, videos: data.videos || {} };
    } catch {
      return { id, videos: {} };
    }
  }

  async function recordVideos(id, videos, at = new Date()) {
    const file = path.join(HISTORY, `${id}.videos.json`);
    const data = await videoHistory(id);
    const date = today(at);
    const cutoff = at.getTime() - VIDEO_WINDOW_DAYS * DAY;
    const young = videos
      .filter((v) => v.publishedAt && Date.parse(v.publishedAt) >= cutoff)
      .slice(0, VIDEO_LIMIT);

    for (const video of young) {
      const row = (data.videos[video.id] ||= { publishedAt: video.publishedAt, firstSeen: new Date(at).toISOString(), days: {} });
      row.title = video.title;
      row.days[date] = video.views;
    }
    // Forget videos that have aged out, so the file stays small however often the channel uploads.
    for (const [videoId, row] of Object.entries(data.videos)) {
      if (row.publishedAt && Date.parse(row.publishedAt) < cutoff) delete data.videos[videoId];
    }

    await fs.mkdir(HISTORY, { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, file);
    return data;
  }

  return { load, list, find, add, update, remove, saveProfile, settings, history, record, videoHistory, recordVideos };
}

// ---------------------------------------------------------------------------
// Reading the history

/** Days present, oldest first. */
const dates = (days) => Object.keys(days).sort();

/** Totals on `date`, or the last day recorded before it (nothing before the first snapshot). */
export function totalsOn(days, date) {
  let best = null;
  for (const d of dates(days)) {
    if (d > date) break;
    best = { date: d, ...days[d] };
  }
  return best;
}

/**
 * Change over the last `span` days and how that compares with the span before it.
 * `partial` means the history doesn't reach back that far yet — the number is real but covers fewer days.
 */
export function change(days, metric, span, at = new Date()) {
  const all = dates(days);
  if (!all.length) return null;
  const end = all[all.length - 1];
  const start = totalsOn(days, dayBefore(end, span));
  const first = { date: all[0], ...days[all[0]] };
  const from = start || first;
  const latest = days[end];
  const covered = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${from.date}T00:00:00Z`)) / DAY);
  if (!covered) return { value: null, percent: null, partial: true, covered: 0, span, of: latest[metric] };

  const value = latest[metric] - from[metric];
  const prevFrom = totalsOn(days, dayBefore(from.date, span));
  const previous = prevFrom && prevFrom.date !== from.date ? from[metric] - prevFrom[metric] : null;
  const percent = previous ? ((value - previous) / Math.abs(previous)) * 100 : null;
  return { value, percent: num(percent), previous, partial: covered < span, covered, span, of: latest[metric] };
}

/** Growth of the running total itself, the way "Total views +2.1%" reads. */
export function totalPercent(days, metric, span, at = new Date()) {
  const all = dates(days);
  if (!all.length) return null;
  const end = all[all.length - 1];
  const from = totalsOn(days, dayBefore(end, span));
  if (!from || from.date === end || !from[metric]) return null;
  return ((days[end][metric] - from[metric]) / from[metric]) * 100;
}

/**
 * Daily (or monthly) gains for the chart. Gaps — the app was off for a few days — are spread evenly across
 * the missing days rather than landing as one spike.
 * → [{ date, value, filled }]
 */
export function series(days, metric, { grain = "daily", range = 30 } = {}) {
  const all = dates(days);
  if (all.length < 2) return [];
  const daily = [];
  for (let i = 1; i < all.length; i++) {
    const from = all[i - 1];
    const to = all[i];
    const gap = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
    const total = days[to][metric] - days[from][metric];
    const each = total / gap;
    for (let step = 1; step <= gap; step++) {
      daily.push({ date: dayBefore(to, gap - step), value: each, filled: step < gap });
    }
  }
  // The window ends at the last reading, not at wall-clock today, so the chart's total matches the
  // "views gained" card exactly even when the newest reading is a few hours old in another timezone.
  const cutoff = dayBefore(all[all.length - 1], range - 1);
  const windowed = daily.filter((d) => d.date >= cutoff);
  if (grain !== "monthly") return windowed.map((d) => ({ ...d, value: Math.round(d.value) }));

  const months = new Map();
  for (const d of windowed) {
    const key = d.date.slice(0, 7);
    months.set(key, (months.get(key) || 0) + d.value);
  }
  return [...months.entries()].map(([date, value]) => ({ date, value: Math.round(value), filled: false }));
}

/**
 * What a tracked video did: views it gained over the last day and week, its early pace if this app was
 * already watching when it went up, and a daily series for the sparkline.
 * `sincePublish` is false when tracking started after the video did — its early numbers aren't ours to claim.
 */
export function videoPace(row, at = new Date()) {
  if (!row?.days) return null;
  const all = Object.keys(row.days).sort();
  if (!all.length) return null;
  const end = all[all.length - 1];
  const latest = row.days[end];
  const on = (date) => {
    let best = null;
    for (const d of all) {
      if (d > date) break;
      best = { date: d, views: row.days[d] };
    }
    return best;
  };
  // Readings can be days apart (the app was off). A gap wider than the span is scaled down to it rather
  // than reported as if it all happened in one day; a shorter history is reported as it stands, marked partial.
  const back = (span) => {
    const from = on(dayBefore(end, span)) || first;
    if (from.date === end) return null;
    const gap = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${from.date}T00:00:00Z`)) / DAY);
    const value = latest - from.views;
    return { value: gap > span ? Math.round((value * span) / gap) : value, span, covered: Math.min(gap, span), exact: gap === span };
  };

  const first = { date: all[0], views: row.days[all[0]] };
  const publishedAt = row.publishedAt ? Date.parse(row.publishedAt) : null;
  const firstSeen = row.firstSeen ? Date.parse(row.firstSeen) : null;
  // Tracking counts as "from publish" when the first reading landed within a day of the upload.
  const sincePublish = Boolean(publishedAt && firstSeen && firstSeen - publishedAt < 1.5 * DAY);

  return {
    views: latest,
    day: back(1),
    week: back(7),
    sincePublish,
    firstDayViews: sincePublish ? (all[1] ? row.days[all[1]] : first.views) : null,
    days: all.length,
    series: all.slice(1).map((d, i) => ({ date: d, value: Math.max(0, row.days[d] - row.days[all[i]]) })),
  };
}
