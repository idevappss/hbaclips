// YouTube Data API v3 client for the Analytics tab: resolving a channel from anything the creator pastes,
// and one cheap snapshot call per channel (~5 quota units) that carries every number the tab shows.
// Public data only — no OAuth, no channel login. Owned by the ANALYTICS session.
const API = "https://www.googleapis.com/youtube/v3";

/** Topic URLs come back as Wikipedia links; the last segment is the readable name. */
const topicName = (url) => {
  const slug = decodeURIComponent(String(url).split("/").pop() || "");
  return slug.replace(/_\([^)]*\)$/, "").replace(/_/g, " ").trim();
};

/** YouTube's own video categories, for channels that carry no topics. */
const CATEGORIES = {
  1: "Film & Animation", 2: "Autos & Vehicles", 10: "Music", 15: "Pets & Animals", 17: "Sports",
  19: "Travel & Events", 20: "Gaming", 22: "People & Blogs", 23: "Comedy", 24: "Entertainment",
  25: "News & Politics", 26: "Howto & Style", 27: "Education", 28: "Science & Technology",
  29: "Nonprofits & Activism", 30: "Movies", 31: "Anime/Animation", 35: "Documentary", 43: "Shows",
};

const apiKey = () => process.env.YOUTUBE_API_KEY || process.env.YT_API_KEY || "";
export const hasKey = () => Boolean(apiKey());

function fail(message, code, retryable = false) {
  const err = new Error(message);
  err.code = code;
  err.retryable = retryable;
  return err;
}

async function call(resource, params) {
  const key = apiKey();
  if (!key) throw fail("Add YOUTUBE_API_KEY to .env, then restart, and this tab fills itself in.", "no_key");
  const url = new URL(`${API}/${resource}`);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, String(v));
  url.searchParams.set("key", key);

  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    throw fail(`YouTube didn't answer: ${err.message}`, "network", true);
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;

  const reason = data?.error?.errors?.[0]?.reason || `http_${res.status}`;
  if (reason === "quotaExceeded" || reason === "dailyLimitExceeded")
    throw fail("This API key used up YouTube's daily quota. It resets at midnight Pacific.", "quota", true);
  if (reason === "keyInvalid" || res.status === 400)
    throw fail("YouTube rejected the API key. Check YOUTUBE_API_KEY in .env.", "bad_key");
  if (res.status === 403)
    throw fail("YouTube refused the request — enable \"YouTube Data API v3\" for this key in Google Cloud.", "forbidden");
  throw fail(data?.error?.message || res.statusText, reason, res.status >= 500);
}

/** "PT1M48S" → 108. */
export function parseDuration(iso) {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(String(iso || ""));
  if (!m) return 0;
  const [, w, d, h, min, s] = m.map((v) => (v == null ? 0 : Number(v)));
  return w * 604800 + d * 86400 + h * 3600 + min * 60 + s;
}

/** What the creator pasted: a channel URL, @handle, channel id, or a link to one of their videos. */
export function parseChannelInput(input) {
  const raw = String(input || "").trim().replace(/^@?\s*/, (m) => m.trim());
  if (!raw) return null;
  if (/^UC[\w-]{22}$/.test(raw)) return { id: raw };
  if (/^@[\w.\-]{2,}$/.test(raw)) return { handle: raw };
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = u.hostname.replace(/^(www|m|music)\./, "");
    const parts = u.pathname.split("/").filter(Boolean);
    if (host === "youtu.be" && parts[0]) return { videoId: parts[0] };
    if (host === "youtube.com") {
      if (parts[0] === "channel" && parts[1]) return { id: parts[1] };
      if (parts[0]?.startsWith("@")) return { handle: parts[0] };
      if ((parts[0] === "c" || parts[0] === "user") && parts[1]) return { username: parts[1] };
      if (parts[0] === "shorts" && parts[1]) return { videoId: parts[1] };
      if (u.searchParams.get("v")) return { videoId: u.searchParams.get("v") };
    }
  } catch {
    /* not a URL — treat it as a name below */
  }
  return { query: raw };
}

/** Anything the creator pasted → a channel id. Searching by name costs 100 quota units; the rest cost 1. */
export async function resolveChannelId(input) {
  const target = parseChannelInput(input);
  if (!target) throw fail("Paste a channel link, @handle or name.", "empty");
  if (target.id) return target.id;

  if (target.videoId) {
    const data = await call("videos", { part: "snippet", id: target.videoId });
    const id = data.items?.[0]?.snippet?.channelId;
    if (id) return id;
    throw fail("That video isn't on YouTube any more.", "not_found");
  }
  if (target.handle) {
    const data = await call("channels", { part: "id", forHandle: target.handle });
    if (data.items?.[0]?.id) return data.items[0].id;
  }
  if (target.username) {
    const data = await call("channels", { part: "id", forUsername: target.username });
    if (data.items?.[0]?.id) return data.items[0].id;
  }
  const q = target.query || target.handle || target.username;
  const found = await call("search", { part: "snippet", type: "channel", maxResults: 1, q });
  const id = found.items?.[0]?.snippet?.channelId || found.items?.[0]?.id?.channelId;
  if (id) return id;
  throw fail(`No YouTube channel matches "${q}".`, "not_found");
}

async function uploads(playlistId, wanted) {
  const ids = [];
  let pageToken;
  while (ids.length < wanted) {
    const page = await call("playlistItems", { part: "contentDetails", playlistId, maxResults: 50, pageToken });
    for (const item of page.items || []) {
      const id = item.contentDetails?.videoId;
      if (id) ids.push(id);
    }
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }
  return ids.slice(0, wanted);
}

async function videoDetails(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const page = await call("videos", { part: "snippet,contentDetails,statistics", id: ids.slice(i, i + 50).join(",") });
    for (const v of page.items || []) {
      const durationSec = parseDuration(v.contentDetails?.duration);
      out.push({
        id: v.id,
        title: v.snippet?.title || "Untitled",
        publishedAt: v.snippet?.publishedAt || null,
        thumb: v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url || null,
        categoryId: v.snippet?.categoryId ? Number(v.snippet.categoryId) : null,
        tags: (v.snippet?.tags || []).slice(0, 25),
        durationSec,
        short: durationSec > 0 && durationSec <= 180,
        views: Number(v.statistics?.viewCount ?? 0),
        likes: Number(v.statistics?.likeCount ?? 0),
        comments: Number(v.statistics?.commentCount ?? 0),
      });
    }
  }
  return out.sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
}

/**
 * One channel, everything the tab shows: lifetime totals, what the channel is, how often and how long it
 * publishes, and its recent videos. `videoCount` recent uploads are read (100 = ~5 quota units).
 */
export async function fetchChannel(channelId, { videoCount = 200, now = new Date() } = {}) {
  const data = await call("channels", { part: "snippet,statistics,contentDetails,topicDetails,brandingSettings", id: channelId });
  const ch = data.items?.[0];
  if (!ch) throw fail("That channel is gone or private.", "not_found");

  const stats = ch.statistics || {};
  const playlistId = ch.contentDetails?.relatedPlaylists?.uploads;
  const videos = playlistId ? await videoDetails(await uploads(playlistId, videoCount)) : [];

  // Upload rhythm and length come from the last 8 weeks so a channel that changed pace reads true.
  const since = now.getTime() - 56 * 86400000;
  const window = videos.filter((v) => Date.parse(v.publishedAt || 0) >= since);
  const measured = window.length >= 4 ? window : videos.slice(0, 30);
  const oldest = measured.length ? Date.parse(measured[measured.length - 1].publishedAt || 0) : 0;
  const spanDays = oldest ? Math.max(1, (now.getTime() - oldest) / 86400000) : 0;
  const uploadsPerWeek = spanDays ? (measured.length / spanDays) * 7 : null;
  const lengths = measured.map((v) => v.durationSec).filter((s) => s > 0);
  const avgDurationSec = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : null;

  const topics = [...new Set((ch.topicDetails?.topicCategories || []).map(topicName).filter(Boolean))];
  const counts = new Map();
  for (const v of measured) if (v.categoryId) counts.set(v.categoryId, (counts.get(v.categoryId) || 0) + 1);
  const topCategory = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const category = topics[0] || CATEGORIES[topCategory] || null;

  return {
    id: ch.id,
    title: ch.snippet?.title || "Channel",
    handle: ch.snippet?.customUrl ? (ch.snippet.customUrl.startsWith("@") ? ch.snippet.customUrl : `@${ch.snippet.customUrl}`) : null,
    avatar: ch.snippet?.thumbnails?.medium?.url || ch.snippet?.thumbnails?.default?.url || null,
    banner: ch.brandingSettings?.image?.bannerExternalUrl || null,
    description: ch.snippet?.description || "",
    country: ch.snippet?.country || null,
    startedAt: ch.snippet?.publishedAt || null,
    url: `https://www.youtube.com/channel/${ch.id}`,
    stats: {
      views: Number(stats.viewCount ?? 0),
      subs: Number(stats.subscriberCount ?? 0),
      subsHidden: Boolean(stats.hiddenSubscriberCount),
      videos: Number(stats.videoCount ?? 0),
    },
    category,
    topics,
    uploadsPerWeek,
    avgDurationSec,
    shortsShare: measured.length ? measured.filter((v) => v.short).length / measured.length : null,
    videos,
    fetchedAt: new Date(now).toISOString(),
  };
}
