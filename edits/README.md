# Dope Edits

Music-synced montage edits with transitions, effects, color grades, text and sound design. Drop one long video or a pile of clips, add a song, describe the vibe, and get back a finished vertical edit. Owned by the **Dope Clips** session.

```
clips ─► analyze (moments, motion, exposure, color, loudness, contact sheets, speech)
song  ─► beats (tempo, beat grid, bars, energy, drop)           ┐
style ideas + ratings ─► recipes + STYLE.md                     ├─► director (Claude, or heuristic) ─► timeline ─► render (ffmpeg)
Clip Studio title taste (titles/) ──────────────────────────────┘
```

- **Analyze** (`analyze.js`) scans every source, splits it into moments, scores them, and builds labeled contact sheets so Claude can see the footage. Long sources are scanned on keyframes. Speech is transcribed with Whisper only when dialogue can make it into the edit, and a Clip Studio project's existing `words.json` is reused.
- **Beats** (`beats.js`) is pure JS: spectral-flux onsets, tempo by autocorrelation, dynamic-programming beat tracking, downbeats, loudness per bar, and the drop. It also suggests where to start the song so the drop lands early in the edit.
- **Director** (`director.js`) writes a shot-by-shot plan with source moments, beats per shot, speed moves, effects, transitions, word slams, focus for cropping, look and title. With `ANTHROPIC_API_KEY` it uses `claude-opus-5` with the contact sheets. Without one, a beat-aware heuristic uses the blended style recipe.
- **Timeline** (`timeline.js`) snaps the plan to the beat grid, frame-quantizes it, computes transition overlaps and source windows, and places captions, text and SFX cues (whooshes on whips, an impact on flashes, a riser into the drop).
- **Render** (`render.js`) runs one ffmpeg pass per shot (time remap, crop or blurred fit, smooth zoom and shake via `perspective`, grade, effects), then one pass that joins the shots with `xfade`, burns in animated ASS text, and mixes music (ducked under dialogue), dialogue and SFX to −14 LUFS. It uses VideoToolbox when available. Shot renders are cached, so a look or text change re-renders in seconds.

## Vocabulary (`looks.js`)

| | |
|---|---|
| Looks | natural, teal-orange, moody-film, warm-vintage, cold-crisp, bleach, noir, neon-night, golden-hour, dream-haze, gritty, none |
| Transitions | cut, flash, dip-black, whip-left/right/up/down, zoom, glitch, blur, dissolve, slide, squeeze, circle, radial, slices |
| Effects | punch, beat-zoom, push, pull, shake, rumble, rgb, flash, strobe, echo, invert, letterbox, mono, blur-in |
| Speeds | normal, slow, fast, ramp, ramp-fast, reverse, stutter, freeze |
| Text | slam (Impact), clean (Avenir Next Condensed Heavy), minimal (Futura), neon, boxed (DIN Condensed) |

Adding a look or transition is one entry. The director's prompt and the UI read the same catalog.

## Style ideas ("model my ideas")

`ideas.js` holds the creator's references in `edits/ideas.json` (media under `data/edits/ideas/`):

- **Notes**: what makes an edit dope, in their words.
- **Reference edits** (video): measured for cuts per second, average shot length, BPM, beats per shot, motion, brightness and saturation, plus a contact sheet.
- **Images**: looks, grades, text styles.

Each idea is modeled into a **recipe**: energy, beats per shot, weighted transitions, effects and speeds, look, text style, accent, structure and rules. Claude does the modeling when a key is set; otherwise keywords and measurements. Ratings on finished edits (🔥 / 👍 / 😐 plus a note) are stored with what the edit used. `STYLE.md` is re-distilled from all of it after every change. The director gets STYLE.md, the chosen recipes (or all of them) and recent ratings on every edit.

## Run it

```bash
node edits/server.js        # → http://localhost:5190
```

Needs what Clip Studio needs. Whisper (via HyperFrames) is only used for dialogue. Run either this standalone server or the version mounted in Clip Studio, not both at once: they'd share the job queue on disk.

## Planning for other renderers

Clip Studio renders dope edits with HyperFrames from a fully resolved plan: `createEditsIntegration({ render: false })`, then `planEdit()` / `waitForPlan()` or `POST /api/plans`. The contract is **`shared/EDIT_PLAN.md`** (`edit-plan/1`, built by `contract.js`). The standalone server keeps rendering with ffmpeg for testing.

## Hooks for ENGINE (one-time, `server.js`)

```js
import { createEditsIntegration } from "./edits/index.js";
import { addTrack } from "./lib/sounds.js";

const edits = createEditsIntegration({ sounds: { addTrack } }); // uploaded songs join the shared sound library
app.use("/edits", edits.router);                                  // UI at /edits/, API at /edits/api/…
await edits.start();                                              // clears jobs interrupted by a restart
```

**Scheduler library**: finished edits can be posted like clips.

```js
// GET /api/library: append
for (const item of await edits.libraryItems()) items.push(item);
// → { source: "edits", editId, version, title, caption, duration, file: "<editId>/v3.mp4", videoPath, renderedAt }

// Publishing: resolve the file for edit posts
const videoPath = post.source === "edits" ? edits.videoPath(post.file) : path.join(PROJECTS_DIR, post.projectId, post.file);
```

Rendered files are served at `/edits/media/<editId>/v<n>.mp4`.

## HTTP API (relative to the mount)

| Method & path | Body | Returns |
|---|---|---|
| `GET /api/config` | | vocabulary, looks, text styles, aspects, `claude` |
| `GET /api/edits` | | edit summaries |
| `POST /api/edits` | multipart: `videos[]`, `music?`, `options` JSON `{ length, aspect, energy, audioMode, vibe, title, look, textStyle, captions, sfx, ideaIds, projectIds, trackId }` | the edit (queued) |
| `GET /api/edits/:id` | | full edit, including `plan` and `versions` |
| `POST /api/edits/:id/reroll` | `{ options?, musicStart? }` | new direction, new version |
| `POST /api/edits/:id/rerender` | `{ options: { look, lookIntensity, textStyle, accent, title, captions, sfx }, musicStart? }` | same shots, new finish |
| `POST /api/edits/:id/cancel` | | |
| `POST /api/edits/:id/current` | `{ version }` | |
| `POST /api/edits/:id/feedback` | `{ version, rating: fire\|good\|meh, note }` | |
| `DELETE /api/edits/:id` | | |
| `GET /api/sounds` | | tracks from the shared sound library (`data/sounds.json`) |
| `GET /api/clip-studio/projects` | | Clip Studio videos usable as sources (no copy) |
| `GET/POST /api/ideas`, `PATCH/DELETE /api/ideas/:id`, `POST /api/ideas/:id/remodel` | multipart `files[]`, `title`, `notes`, `url` | style ideas |
| `GET /api/style`, `POST /api/style/refresh` | | STYLE.md |

`audioMode`: `music` (music bed only), `mix` (music ducked under a few strong spoken lines), `source` (clips' own sound), `auto` (music if there's a song, and `mix` for a single long talking video).

## Files

```
edits/
  index.js      jobs + router         analyze.js  source analysis     beats.js   music analysis
  director.js   Claude / heuristic    timeline.js beat-fit plan       render.js  ffmpeg renderer
  looks.js      vocabulary            text.js     ASS text/captions   ideas.js   style ideas, ratings, STYLE.md
  store.js      edit persistence      server.js   standalone server   public/    UI
  sfx/          Pixabay-licensed SFX (see sfx/CREDITS.md)
data/edits/
  edits/<id>/   edit.json, sources/, analysis/, music.json, segments/, thumbs/, v<n>.mp4
  ideas/<id>/   reference media + analysis
```
