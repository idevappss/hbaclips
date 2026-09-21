# Analytics — how every connected account is doing

Owned by the **ANALYTICS** session. Nothing outside `analytics/` and `data/analytics/` is edited from here.

The tab lives at `#/analytics`. It works with **no API key at all**, and uses one automatically if it's there.
Instagram numbers come from the Instagram module's own insights, read over HTTP.

## Two ways of reading a channel

| | Keyless (default) | With `YOUTUBE_API_KEY` |
|---|---|---|
| Source | The channel's RSS feed + its About page | YouTube Data API v3 |
| Lifetime views, subscribers, video count, join date, country | Yes, exact | Yes |
| Recent uploads with views and likes | Last **15** | Last **200** |
| Video lengths | Scraped from the videos tab, best effort | Yes |
| Comment counts, tags, topic/category | No | Yes |
| Rate limits | YouTube may throttle a busy machine | 10,000 quota units a day |
| Breaks when YouTube reshuffles its page | Possible — fields degrade to blank, never crash | No |

Every headline card works either way, because the gains and the chart come from this module's own daily
readings, not from either source. `scrape.js` pulls each field independently and falls back to `null`, so a
YouTube layout change blanks one number instead of taking the tab down. Channel identity is always taken from
the canonical `<link>`/`og:url` tags — the first `"channelId"` in the page is often a *featured* channel, which
is exactly the trap that makes naive scrapers report the wrong numbers.

## The one thing to understand

YouTube's public API only ever reports **lifetime totals**: total views today, total views tomorrow. It will
never tell you "views gained last week." So this module takes a reading of every tracked channel roughly every
six hours and keeps a row per day. Every gain, percentage and chart point is the difference between two of
those readings — a real measurement, not an estimate.

That has one consequence worth saying out loud in the UI, and it does: **the first day shows totals only.**
Gains appear on day two, the 7-day comparison on day eight, and the 30-day percentages after a month.

Per-video views are recorded the same way for anything published in the last 60 days, which is what makes
"+19,367 today" on a single clip possible. Nothing else in this project can answer that.

## Wiring (one-time, in `server.js`)

```js
import analytics from "./analytics/index.js";

app.use("/api/analytics", analytics.router);
analytics.start(); // reads stale channels now, then every 30 min; analytics.stop() on shutdown
```

Then two lines in `public/`, the same shape as the Assets tab:

`public/index.html` — in the main nav, after the Scheduler link:

```html
<a href="#/analytics" data-nav="analytics"><svg viewBox="0 0 24 24"><path d="M4 19.5V14m5 5.5V8m5 11.5v-7m5 7V5" /></svg>Analytics</a>
```

`public/app.js` — in the router, before `const projectMatch = …`:

```js
if (pathPart.startsWith("/analytics")) {
  $$("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === "analytics"));
  const { mountAnalytics } = await import("/api/analytics/ui/analytics.js");
  await mountAnalytics(app);
  window.scrollTo(0, 0);
  return;
}
```

Until ENGINE adds those, `node analytics/dev.js` serves the whole app on **5195** with both patched in on the
fly and everything else proxied to 5173, which it never restarts.

## Environment

```
YOUTUBE_API_KEY=     # optional — Google Cloud → enable "YouTube Data API v3" → Credentials → API key
```

Optional. Without it the tab reads the public pages instead and says so under the stats. With it, a key gets
10,000 quota units a day. One channel reading costs about 11 (channel + 200 recent uploads), so
four readings a day for five channels is roughly 220 — about 2% of the allowance. Adding a channel by name
costs 100 (a search); adding it by link or @handle costs 1, so the input accepts both and prefers the link.

Without a key the tab keeps working, explains what the narrower source can't see, and offers the steps.

## What's tracked

**The cards** (the vidIQ set): total views, views gained in 7 days, subscribers, estimated monthly earnings,
category, country, videos published, average video length, upload frequency.

**Measured, not guessed:** everything with a percentage or a "gained" is a difference between two readings.
Estimated monthly earnings is the one deliberate estimate — last 30 days of views × an RPM you can set per
channel (default $2 per 1,000). Subscriber counts come back rounded to three digits from YouTube itself, so
small subscriber moves are coarse; the UI says so rather than pretending otherwise.

**Derived** (`insights.js`), all measured against *this channel's own median*, never a global average, so one
viral video can't move the bar:

| Panel | Answers |
|---|---|
| Moving today | Which videos are pulling views *right now*, with a 14-day sparkline each |
| This channel's own bar | Typical video, typical pace, first-day views, likes and comments per 1,000 views, pace, 30-day projection, next subscriber milestone |
| Best length | Which duration band beats the typical video (20–40s, 40–60s, 1–3 min, …) |
| Best day / time to post | Which upload slots beat it |
| Title shapes | Questions, numbers, dollar amounts, SHOUTED words, short vs long |
| Tags that carry | Tags on at least three videos, ranked |

A group that covers more than 85% of the channel is dropped — that's the channel, not a pattern.

## HTTP API: `/api/analytics`

| Method & path | Purpose |
|---|---|
| `GET /` | `{ hasKey, settings, channels: [summary] }` — every tracked channel with its cards |
| `GET /status` | `{ hasKey, settings, channels, lastRefreshAt, refreshing }` |
| `POST /channels` | `{ input, kind: "mine" \| "competitor" }`. `input` is a link, @handle, channel id or video link |
| `GET /channels/:id` | One channel in full: cards, videos, insights |
| `PATCH /channels/:id` | `{ kind, label, rpm, compare }` |
| `DELETE /channels/:id` | Stops tracking and deletes that channel's recorded history |
| `GET /channels/:id/series` | `?metric=views\|subs&grain=daily\|monthly&range=7d\|30d\|3m\|6m\|1y` → chart points |
| `POST /refresh` | `{ id? }` — read now instead of waiting for the loop |
| `PATCH /settings` | `{ rpm }` — the default RPM for earnings estimates |

Errors come back as `{ error, code }`. `code: "no_key"` and `"bad_key"` return **428**, so a caller can tell
"set this up" apart from "that went wrong". `"quota"` means the key's daily allowance is spent.

## Files

```
data/analytics/channels.json                  tracked channels + their latest reading
data/analytics/history/<id>.json              one row per day: views, subs, videos
data/analytics/history/<id>.videos.json       per-video views per day, last 60 days of uploads
```

All three are plain JSON, written atomically. A hand-edit that breaks one is never silently overwritten.

## What this deliberately doesn't do

- **No watch time, retention, traffic sources, impressions or CTR.** Those are only in the YouTube *Analytics*
  API, which needs the channel owner to sign in with OAuth. Worth doing next; it's a separate piece of work.
- **No "ranked #6.2M" or "similar channels".** Those are vidIQ's own datasets, not YouTube's. Competitors here
  are the ones you add.
