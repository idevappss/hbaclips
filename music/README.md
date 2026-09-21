# Music Channel

Every time you study a video, HBA Clips asks **"Save this sound?"**. Saved sounds go into the shared Sounds library, so you can reuse them on your next clip or Dope edit. Owned by the **MUSIC** session.

```
Study card ─► "Save this sound?" ─► yt-dlp (links) / study upload ─► ffmpeg → AAC ─► lib/sounds.js addTrack(source: "study")
                                                                                          │
                              Sounds tab · Dope edits track picker · Dope Clips (edits/) ◄┘
```

| File | What it is |
|---|---|
| `index.js` | Audio extraction, per-video decisions, and the `/api/music` router |
| `public/music.js` | Drop-in UI. Injects the prompt into Study cards and exposes `window.musicChannel.mount(el)` |
| `public/channel.html` | Standalone channel page at `/api/music/channel`, used until the Sounds page hosts the section |
| `dev.js` | Dev server on port 5191. Serves the app with the drop-in and proxies everything else to :5173 |
| `data/music/channel.json` | Decisions per studied video (saving / saved / skipped / error) and where each saved sound came from |

There is no second library. The audio files and track list stay in `data/sounds/` and `data/sounds.json`, which `lib/sounds.js` owns.

## Hooks for ENGINE (one-time)

**`server.js`**: mount the API.

```js
import { router as musicRouter } from "./music/index.js";
app.use("/api/music", musicRouter);
```

**`public/index.html`**: add this before `app.js`. It turns on the Study prompt by itself.

```html
<script type="module" src="/api/music/ui/music.js"></script>
```

**`public/app.js`**, when `#/sounds` renders: give the channel a container under the tracks list, and refresh the tracks when a study sound lands.

```js
// in the Sounds page markup
<section id="music-channel"></section>
// after rendering it
window.musicChannel?.mount($("#music-channel"));
// anywhere once
window.addEventListener("music:saved", () => { /* reload /api/sounds if the Sounds page is open */ });
```

Nothing else is needed. The drop-in finds `#refs [data-ref]` cards with a MutationObserver and re-injects when a card's `outerHTML` is replaced, so the Study code doesn't have to change.

## HTTP API: `/api/music`

| Method & path | Returns |
|---|---|
| `GET /` | `{ pending, saved, references }`. `pending` lists studied videos still to decide (with title, thumbnail, uploader). `saved` lists library tracks saved from studies, each with a `study` provenance object. `references` is the per-video state map. |
| `GET /references` | `{ [refId]: { status } }`. `status` is one of `ask`, `waiting` (link details loading), `unavailable`, `saving`, `saved` (+ `sound: { id, name }`), `skipped`, `error` (+ `error`). |
| `POST /references/:refId/save` | `{ name?, start?, end? }` → `202 { status: "saving" }`. Runs in the background. Name defaults to "Track — Artist" when the site knows the song, otherwise the video title. |
| `POST /references/:refId/skip` | `{ status: "skipped" }`. The card then shows a small "Save this sound" link instead of the prompt. |
| `DELETE /references/:refId` | Forgets a skip or failure so the prompt asks again. |
| `GET /sounds` | Every library track, with `study` provenance where it exists, plus `audioUrl`. |
| `GET /sounds/:id/audio` | The audio file, with range requests supported. |
| `GET /channel` | Standalone channel page. |

Renaming and deleting tracks go through the Sounds API (`PATCH`/`DELETE /api/sounds/:trackId`). A study sound deleted there counts as skipped, so its video isn't asked about again.

## Notes

- Links need `yt-dlp` (`brew install yt-dlp`). The extractor takes the best audio-only format, or falls back to the full video for sites that don't offer one.
- Videos with no audio track fail with "This video has no sound to save." and the card offers Dismiss.
- A save interrupted by a server restart comes back as an error with **Try again**.
- ENGINE mounted everything on :5173 on 2026-09-11. Test saves there. `dev.js` (:5191) is only for UI work: each process caches `data/sounds.json` in memory, and whichever writes last drops the other's tracks, so never save a sound through :5191 while :5173 is running.
