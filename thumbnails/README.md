# Thumbnails

The **Thumbnails** tab (`#/thumbnails`) gives every video a YouTube-ready **1280×720** thumbnail, made on its
own while the video is still transcribing. Owned by the **THUMBNAILS** session: `thumbnails/` and `data/thumbnails/`.
It only ever *reads* `projects/`.

How one gets made:

1. **Stills** — ten frames spread across the video (from `work.mp4` when the pipeline has made one), each scored on
   face size and confidence (Apple Vision, the same tracker the crop uses), sharpness, contrast and exposure.
2. **The pick and the words** — Claude looks at the best eight stills and picks the one that sells the video, then
   writes a 2–6 word headline, the single word to hit with the accent colour, and an optional line underneath. It
   writes in the creator's title taste when the `titles/` session is installed. A video that's still transcribing
   gets judged on the pictures alone.
3. **The picture** — headless Chrome paints the layout (Anton over the still, accent word boxed, gradient scrim,
   optional brand logo and corner badge) and screenshots it at exactly 1280×720. The accent colour is the creator's
   own, read from the Assets brand kit (`GET /api/resources/brand`) when there is one.

The tab has two views. **Videos** is one card per project with its current thumbnail and its switches.
**All thumbnails** is every thumbnail there has ever been, newest first — the current one for each video and the
ones they replaced. Click a replaced one to see it big, save it, delete it, or **Use this one again**, which puts
it back as that video's thumbnail and sends the one it displaced to the history (the last 80 are kept, with their
stills).

Everything is editable afterwards: click a thumbnail to change the words, the layout, the accent, the corner badge,
or to pick a different still from the strip — each change repaints in a couple of seconds. **New words** starts over
on the same video. ♥ / ✕ on the words feeds the title taste library.

## Turning it off

| Where | What it does |
|---|---|
| **Make them automatically** (tab header) | Off means nothing is made on its own, for any video. Existing thumbnails stay, and **Make one** still works per video. |
| **Auto** switch on a video's card | Off means *this* video never gets one — the rest still do. |

Both are stored in `data/thumbnails/db.json` (`settings.auto` and `projects.<id>.auto`), so they survive restarts.
A video that already has a thumbnail is never redone on its own.

| File | What it is |
|---|---|
| `index.js` | The library, the watcher that makes them automatically, and the `/api/thumbnails` router |
| `frames.js` | Candidate stills: extraction and scoring (faces, sharpness, contrast, exposure) |
| `headline.js` | Claude picks the still and writes the words; falls back to the best-scoring frame without a key |
| `compose.js` | The 1280×720 page: layouts, scrims, brand accent and logo |
| `shot.js` | Headless Chrome screenshot (one warm browser, closed after a minute idle) |
| `public/thumbnails.js` | The tab. `mountThumbnails(el)` renders into `#app` and returns a cleanup function |
| `public/thumbnails.css` | Styles. Theme tokens only |
| `dev.js` | Dev server on port 5196. Patches the nav link and route in, and proxies the rest to :5173 |
| `data/thumbnails/db.json` | Settings, per-video switches, the current thumbnails and the replaced ones. Re-read whenever another process writes it, so the app and `dev.js` can both be up |
| `data/thumbnails/files/<id>/` | The candidate stills and the finished `thumb.jpg` |

## Wiring (already applied, 2026-09-22)

These four edits are in the repo. They're written out here so ENGINE knows what's there and doesn't lose them.

**`server.js`**: mount the API and start the watcher.

```js
import thumbnails from "./thumbnails/index.js";
app.use("/api/thumbnails", thumbnails.router);
thumbnails.start();  // makes them automatically; thumbnails.stop() on shutdown
```

**`public/index.html`**: add the nav link after Titles.

```html
<a href="#/thumbnails" data-nav="thumbnails"><svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m4 17 4.5-4.5L12 16l3-3 5 5" /></svg>Thumbnails</a>
```

**`public/app.js`**, in `route()` just before `const projectMatch = …`:

```js
if (pathPart.startsWith("/thumbnails")) {
  $$("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === "thumbnails"));
  const { mountThumbnails } = await import("/api/thumbnails/ui/thumbnails.js");
  await mountThumbnails(app);
  window.scrollTo(0, 0);
  return;
}
```

**`public/shell.js`** (Design session): `["Thumbnails", "#/thumbnails", "Video thumbnails"]` in `PAGES`, so ⌘K finds it.

Nothing else is needed: the watcher finds new videos by itself, so the import pipeline stays untouched.

## HTTP API: `/api/thumbnails`

| Method & path | Returns |
|---|---|
| `GET /` | `{ settings, layouts, claude, videos, history }`. One entry per project, newest first, each with its thumbnail or `null`, plus every replaced thumbnail. |
| `PATCH /settings` | `{ auto, sub, logo, layout, accent }` — `auto: false` stops every automatic thumbnail. |
| `POST /videos/:id/auto` | `{ auto }` for one video. |
| `POST /videos/:id/generate` | Makes one now, whatever the switches say. Replaces that video's thumbnail. |
| `PATCH /items/:id` | `{ headline, word, sub, badge, layout, accent, logo, frame }` then repaints. |
| `POST /items/:id/again` | Fresh still and fresh words for the same video. |
| `POST /items/:id/restore` | Puts a replaced thumbnail back as the video's current one. |
| `POST /items/:id/rate` | `{ liked }` — ♥ / ✕, which also teaches `titles/`. |
| `DELETE /items/:id` | Forgets the thumbnail and its stills. Works on a replaced one too. |
| `GET /items/:id/file` | The 1280×720 JPEG. `?download` saves it under the video's name. |
| `GET /items/:id/frames/:file` | One candidate still. |
| `GET /for?projectId=` | `{ thumbnail }` — for other sessions. |

## For other sessions

Read `GET /api/thumbnails/for?projectId=<id>` for a video's thumbnail instead of pulling your own poster frame.
The record carries `url`, `headline`, `word`, `sub`, `frame.at` (the second it was taken from, useful as a Reel
cover) and the candidate stills. It's read-only from outside; thumbnails are made here.

Requirements: Google Chrome (set `THUMBNAIL_CHROME`/`CHROME_PATH` if it lives somewhere unusual) and, for the
words, `ANTHROPIC_API_KEY`. Without a key the best-scoring still still gets a line pulled from the transcript,
and the tab says so.
