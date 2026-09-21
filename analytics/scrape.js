// Reading a channel without an API key, from what YouTube serves the public anyway:
//   • the RSS feed  — the last 15 uploads with exact views and likes. Unchanged for a decade, cheapest, safest.
//   • the channel page — lifetime views, subscribers, video count, joined date.
//   • the videos tab — durations, so length bands and "avg. video length" still work.
// Every field is pulled independently and falls back to null: when YouTube reshuffles its payload (it does),
// the affected number goes blank and everything else keeps working. Nothing here throws on a missing field.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const RSS = "https://www.youtube.com/feeds/videos.xml";

function fail(message, code, retryable = false) {
  const err = new Error(message);
  err.code = code;
  err.retryable = retryable;
  return err;
}

async function get(url, { as = "text" } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow" });
  } catch (err) {
    throw fail(`YouTube didn't answer: ${err.message}`, "network", true);
  }
  if (res.status === 404) throw fail("No YouTube channel at that address.", "not_found");
  if (res.status === 429) throw fail("YouTube is rate-limiting this machine. It clears on its own; an API key avoids it entirely.", "rate_limited", true);
  if (!res.ok) throw fail(`YouTube answered ${res.status}.`, `http_${res.status}`, res.status >= 500);
  return as === "text" ? res.text() : res;
}

/** "30.4M subscribers" / "4.61K subscribers" / "1,234 subscribers" → a number. */
export function parseCount(text) {
  const m = /([\d.,]+)\s*([KMB])?/i.exec(String(text || ""));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1;
  return Math.round(n * scale);
}

/** "19:03" → 1143, "1:02:11" → 3731. */
const parseClock = (text) => {
  const parts = String(text || "").trim().split(":").map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((total, n) => total * 60 + n, 0);
};

const first = (html, re, group = 1) => {
  const m = re.exec(html);
  return m ? m[group] : null;
};

// ---------------------------------------------------------------------------
// The channel page

/** Anything the creator pasted → a channel id, read off the channel page itself. */
export async function resolveChannelIdKeyless(input) {
  const raw = String(input || "").trim();
  if (!raw) throw fail("Paste a channel link, @handle or name.", "empty");
  if (/^UC[\w-]{22}$/.test(raw)) return raw;

  let url;
  if (/^https?:\/\//i.test(raw)) url = raw;
  else if (raw.startsWith("@")) url = `https://www.youtube.com/${raw}`;
  else if (/youtube\.com|youtu\.be/i.test(raw)) url = `https://${raw}`;
  else url = `https://www.youtube.com/@${raw.replace(/\s+/g, "")}`;

  const html = await get(url);
  // Order matters: the page also names featured and linked channels, and the first "channelId" on it is
  // often one of those. Only the canonical tags describe the channel actually being looked at.
  const id =
    first(html, /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) ||
    first(html, /<meta property="og:url" content="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) ||
    first(html, /<meta itemprop="identifier" content="(UC[\w-]{22})">/);
  if (!id) throw fail("Couldn't find a channel there. A channel link or @handle works best.", "not_found");
  return id;
}

/**
 * Lifetime totals and who the channel is, read off the About tab. Every number is taken from the one block
 * that also carries this channel's own id, so a featured or linked channel's numbers can never be picked up
 * by mistake. Anything YouTube stops publishing comes back null.
 */
async function channelPage(channelId) {
  const html = await get(`https://www.youtube.com/channel/${channelId}/about`);

  // The About block sits around this channel's id and holds subscribers, views, videos, country and join date.
  let about = "";
  for (const match of html.matchAll(new RegExp(`"channelId":"${channelId}"`, "g"))) {
    const window = html.slice(Math.max(0, match.index - 1800), match.index + 1800);
    if (/"subscriberCountText"|"viewCountText"/.test(window)) {
      about = window;
      break;
    }
  }

  const joined = first(about, /"joinedDateText":\{"content":"Joined ([^"]+)"/);
  const joinedMs = joined ? Date.parse(joined) : NaN;

  return {
    title: (first(html, /<meta property="og:title" content="([^"]+)"/) || "").replace(/\\u0026/g, "&") || null,
    avatar: first(html, /<meta property="og:image" content="([^"]+)"/),
    description: (first(html, /<meta property="og:description" content="([^"]*)"/) || "").slice(0, 500),
    handle: first(about, /"canonicalChannelUrl":"https?:\/\/www\.youtube\.com\/(@[\w.\-]+)"/) || first(html, /"canonicalBaseUrl":"\/(@[\w.\-]+)"/),
    subs: parseCount(first(about, /"subscriberCountText":"([^"]+)"/)),
    views: parseCount(first(about, /"viewCountText":"([^"]+)"/)),
    videos: parseCount(first(about, /"videoCountText":"([^"]+)"/)),
    startedAt: Number.isFinite(joinedMs) ? new Date(joinedMs).toISOString() : null,
    country: first(about, /"country":"([^"]+)"/),
  };
}

/** Durations, by video id, off the videos tab. Best effort: an empty map just means no length data. */
async function durations(channelId) {
  const out = new Map();
  let html;
  try {
    html = await get(`https://www.youtube.com/channel/${channelId}/videos`);
  } catch {
    return out;
  }
  // Each entry carries its id and, a little later, a "12:34" badge. Pair them in document order.
  const ids = [...html.matchAll(/"videoId":"([\w-]{11})"/g)];
  const badges = [...html.matchAll(/"text":"(\d{1,2}:\d{2}(?::\d{2})?)"/g)];
  for (const badge of badges) {
    let owner = null;
    for (const id of ids) {
      if (id.index > badge.index) break;
      owner = id[1];
    }
    if (owner && !out.has(owner)) out.set(owner, parseClock(badge[1]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The RSS feed — the reliable part

/** The last 15 uploads with exact views and likes. This feed has outlived every scraper. */
async function feed(channelId) {
  const xml = await get(`${RSS}?channel_id=${channelId}`);
  const entries = xml.split("<entry>").slice(1);
  return entries.map((entry) => {
    const pick = (re) => first(entry, re);
    const views = Number(pick(/<media:statistics views="(\d+)"/));
    return {
      id: pick(/<yt:videoId>([\w-]+)<\/yt:videoId>/),
      title: (pick(/<media:title>([\s\S]*?)<\/media:title>/) || pick(/<title>([\s\S]*?)<\/title>/) || "Untitled")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
      publishedAt: pick(/<published>([^<]+)<\/published>/),
      thumb: pick(/<media:thumbnail url="([^"]+)"/),
      views: Number.isFinite(views) ? views : 0,
      likes: Number(pick(/<media:starRating count="(\d+)"/)) || 0,
      comments: 0, // the feed doesn't carry comment counts, and guessing one would be worse than none
      categoryId: null,
      tags: [],
    };
  }).filter((v) => v.id);
}

// ---------------------------------------------------------------------------

/**
 * One channel without an API key, in exactly the shape fetchChannel() returns, so nothing downstream
 * has to care which way the numbers arrived. `partial` lists what this route can't see.
 */
export async function fetchChannelKeyless(channelId, { now = new Date() } = {}) {
  const [page, videos, lengths] = await Promise.all([
    channelPage(channelId),
    feed(channelId),
    durations(channelId),
  ]);

  for (const video of videos) {
    const seconds = lengths.get(video.id) ?? null;
    video.durationSec = seconds ?? 0;
    video.short = seconds != null && seconds > 0 && seconds <= 180;
  }

  const dated = videos.filter((v) => v.publishedAt).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const oldest = dated.length ? Date.parse(dated[dated.length - 1].publishedAt) : 0;
  const spanDays = oldest ? Math.max(1, (now.getTime() - oldest) / 86400000) : 0;
  const measured = lengths.size ? dated.filter((v) => v.durationSec > 0) : [];

  return {
    id: channelId,
    title: page.title || "Channel",
    handle: page.handle || null,
    avatar: page.avatar || null,
    banner: null,
    description: page.description || "",
    country: page.country || null,
    startedAt: page.startedAt || null,
    url: `https://www.youtube.com/channel/${channelId}`,
    stats: { views: page.views ?? 0, subs: page.subs ?? 0, subsHidden: page.subs == null, videos: page.videos ?? dated.length },
    category: null, // only the API reports topics
    topics: [],
    uploadsPerWeek: spanDays ? (dated.length / spanDays) * 7 : null,
    avgDurationSec: measured.length ? measured.reduce((a, v) => a + v.durationSec, 0) / measured.length : null,
    shortsShare: measured.length ? measured.filter((v) => v.short).length / measured.length : null,
    videos: dated,
    source: "keyless",
    partial: [
      "the last 15 uploads only",
      ...(lengths.size ? [] : ["no video lengths"]),
      "no comment counts",
      "no tags or category",
    ],
    fetchedAt: new Date(now).toISOString(),
  };
}
