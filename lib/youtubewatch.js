// Watches the creator's YouTube channels: when a new long video goes up, it's imported, clipped, and its best
// clips rendered through review, so they're waiting on the Review screen. No login or API key — every channel has
// a public feed of its latest 15 uploads. Shorts are skipped (they're already short), and anything published
// before the channel was connected is left alone unless the creator asks for the latest one.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT } from "./tools.js";

const FILE = path.join(ROOT, "data", "youtube-watch.json");
const EVERY_MIN = 15;
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "Accept-Language": "en-US,en;q=0.9" };

let db = null;
let writes = Promise.resolve();

async function load() {
  if (!db) {
    try {
      db = JSON.parse(await fs.readFile(FILE, "utf8"));
    } catch {
      db = { channels: [] };
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
    .catch((err) => console.error("Saving YouTube channels failed:", err.message));
  return writes;
}

const decode = (s) => String(s).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** A channel from a handle ("@drodelltalks"), a channel link, or a channel id. */
export async function resolveChannel(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("Paste your YouTube channel link or @handle.");
  const direct = raw.match(/(UC[\w-]{22})/);
  let url;
  if (direct) url = `https://www.youtube.com/channel/${direct[1]}`;
  else if (/^@[\w.-]+$/.test(raw)) url = `https://www.youtube.com/${raw}`;
  else if (/^https?:\/\/(www\.|m\.)?youtube\.com\//i.test(raw)) url = raw.replace(/\/(videos|shorts|streams|featured|about)\/?$/, "");
  else if (/^[\w.-]{3,}$/.test(raw)) url = `https://www.youtube.com/@${raw}`;
  else throw new Error("That doesn't look like a YouTube channel. Use a link like youtube.com/@yourname.");
  const res = await fetch(url, { headers: UA, redirect: "follow" });
  if (!res.ok) throw new Error(`YouTube couldn't find that channel (${res.status}).`);
  const html = await res.text();
  const id = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] || html.match(/"externalId":"(UC[\w-]{22})"/)?.[1] || direct?.[1];
  if (!id) throw new Error("Couldn't read that channel's ID from YouTube.");
  const title = decode(html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] || "YouTube channel");
  const handle = html.match(/"canonicalBaseUrl":"\/(@[\w.-]+)"/)?.[1] || (raw.startsWith("@") ? raw : null);
  const avatar = decode(html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] || "");
  return { id, title, handle, avatar, url: `https://www.youtube.com/channel/${id}` };
}

/** The channel's latest uploads, newest first: [{ videoId, title, published, url }]. */
export async function channelFeed(channelId) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { headers: UA });
  if (!res.ok) throw new Error(`YouTube's feed didn't answer (${res.status}).`);
  const xml = await res.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    videoId: e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1],
    title: decode(e.match(/<title>([^<]*)<\/title>/)?.[1] || ""),
    published: e.match(/<published>([^<]+)<\/published>/)?.[1] || null,
    url: `https://www.youtube.com/watch?v=${e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]}`,
  })).filter((v) => v.videoId);
}

/** YouTube answers 200 at /shorts/<id> only for a Short; a regular video redirects. */
export async function isShort(videoId) {
  const res = await fetch(`https://www.youtube.com/shorts/${videoId}`, { method: "HEAD", headers: UA, redirect: "manual" });
  return res.status === 200;
}

const publicChannel = ({ seen, ...c }) => ({ ...c, seenCount: seen.length });

export async function listChannels() {
  return (await load()).channels.map(publicChannel);
}

/**
 * Connect a channel. Everything already on it is marked as seen, so connecting never floods the queue — unless
 * `clipLatest` asks for the newest long video to be clipped right away.
 */
export async function addChannel(input, { clipLatest = false, autoRender = 3, notes = "" } = {}) {
  await load();
  const channel = await resolveChannel(input);
  if (db.channels.some((c) => c.id === channel.id)) throw new Error(`${channel.title} is already connected.`);
  const feed = await channelFeed(channel.id);
  let seen = feed.map((v) => v.videoId);
  if (clipLatest) {
    for (const v of feed) {
      if (await isShort(v.videoId).catch(() => false)) continue;
      seen = seen.filter((id) => id !== v.videoId);
      break;
    }
  }
  const record = { ...channel, addedAt: new Date().toISOString(), autoRender: Math.max(0, Math.min(10, Math.round(Number(autoRender) || 0))), notes: String(notes || "").slice(0, 500), lastCheckedAt: null, lastError: null, imported: [], seen };
  db.channels.push(record);
  await persist();
  return publicChannel(record);
}

export async function updateChannel(id, { autoRender, notes, paused } = {}) {
  await load();
  const c = db.channels.find((x) => x.id === id);
  if (!c) throw new Error("Channel not found");
  if (autoRender !== undefined) c.autoRender = Math.max(0, Math.min(10, Math.round(Number(autoRender) || 0)));
  if (typeof notes === "string") c.notes = notes.slice(0, 500);
  if (typeof paused === "boolean") c.paused = paused;
  await persist();
  return publicChannel(c);
}

export async function removeChannel(id) {
  await load();
  db.channels = db.channels.filter((c) => c.id !== id);
  await persist();
}

let checking = null;

/**
 * Look at every connected channel once. New long videos are handed to `onNewVideo` (which imports them) oldest
 * first; one that can't be imported yet (a premiere or a live stream) is tried again on later checks, up to 12 times.
 */
export function checkChannels(onNewVideo) {
  checking ??= (async () => {
    await load();
    const found = [];
    for (const c of db.channels) {
      if (c.paused) continue;
      try {
        const feed = await channelFeed(c.id);
        c.retries ??= {};
        for (const v of [...feed].reverse()) {
          if (c.seen.includes(v.videoId)) continue;
          if (await isShort(v.videoId).catch(() => false)) {
            c.seen.push(v.videoId);
            continue;
          }
          try {
            const project = await onNewVideo({ ...v, channel: c });
            c.seen.push(v.videoId);
            c.imported = [{ videoId: v.videoId, title: v.title, projectId: project?.id || null, at: new Date().toISOString() }, ...(c.imported || [])].slice(0, 50);
            delete c.retries[v.videoId];
            found.push(v);
          } catch (err) {
            c.retries[v.videoId] = (c.retries[v.videoId] || 0) + 1;
            if (c.retries[v.videoId] >= 12) {
              c.seen.push(v.videoId);
              delete c.retries[v.videoId];
            }
            console.error(`[youtube] couldn't import ${v.url}:`, err.message);
          }
        }
        c.seen = c.seen.slice(-200);
        c.lastCheckedAt = new Date().toISOString();
        c.lastError = null;
      } catch (err) {
        c.lastCheckedAt = new Date().toISOString();
        c.lastError = err.message;
      }
    }
    await persist();
    return found;
  })().finally(() => (checking = null));
  return checking;
}

/** Check now and then every 15 minutes while the app runs. */
export function startChannelWatch(onNewVideo) {
  const tick = () => checkChannels(onNewVideo).catch((err) => console.error("[youtube] check failed:", err.message));
  setTimeout(tick, 20_000);
  return setInterval(tick, EVERY_MIN * 60_000);
}
