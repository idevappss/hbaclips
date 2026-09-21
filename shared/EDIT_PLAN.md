# Edit plan contract: `edit-plan/1`

| Area | Owner | Files |
|---|---|---|
| Planning dope edits: sources, analysis, beats, director, shot/transition/effect/grade/text/SFX choices, style lab | EDITS (Dope Clips session) | `edits/`, `data/edits/` |
| Rendering plans: HyperFrames composition, live preview, render queue, Dope edits UI, scheduler library | ENGINE | `lib/editplan.js`, `server.js`, `public/` |

The plan is produced by `edits/contract.js` (`toEditPlan`). A real example is in `shared/edit-plan.example.json`.

**Stability:** within `edit-plan/1`, changes are **additive only**. Existing fields keep their names and meanings; anything else bumps `contract` to `edit-plan/2`. The plan is the internal `timeline.buildPlan()` output with every field intact, plus resolved additions, so an adapter built on the internal shape keeps working.

## Getting a plan

```js
import { createEditsIntegration } from "./edits/index.js";
import { addTrack } from "./lib/sounds.js";

const edits = createEditsIntegration({ sounds: { addTrack }, render: false }); // render:false = jobs stop at the plan
app.use("/edits", edits.router);
await edits.start();

const edit = await edits.planEdit({ projectIds: [project.id], trackId, options: { length: 30, aspect: "9:16", energy: "hype", vibe, title } });
const plan = await edits.waitForPlan(edit.id); // edit-plan/1 JSON; rejects on error/stop/timeout (default 15 min)
```

| HTTP (relative to the mount) | Body | Returns |
|---|---|---|
| `POST /api/plans` | `{ projectIds, trackId?, options }` | the edit (queued); poll `GET /api/edits/:id` until `status` is `planned` (or `error`) |
| `GET /api/edits/:id/plan` | | the plan |
| `POST /api/edits/:id/replan` | `{ options?, musicStart?, keepShots? }` | re-queued. `keepShots: true` keeps the shots and changes only the finish (look, text, title, captions, SFX, music start) |
| `POST /api/edits/:id/cancel` | | |

Edit `status` moves through `queued → analyzing → directing → planned` (or `error`). `planVersion` increments with every new plan. `options`: `length` (5–180 s), `aspect` (`9:16` `4:5` `1:1` `16:9`), `energy` (`auto` `hype` `medium` `chill`), `audioMode` (`auto` `music` `mix` `source`), `vibe`, `title`, `look`, `lookIntensity`, `textStyle`, `accent`, `captions`, `sfx` (`full` `subtle` `off`), `ideaIds`.

## Units and conventions

- **Time**: seconds on the output timeline, starting at 0 and quantized to frames at `fps` (30). "Local" times are seconds from a shot's own `timeline.start`.
- **Pixels**: canvas pixels (`width × height`).
- **Colors**: `#RRGGBB` in resolved fields; `accent` (internal) is `RRGGBB` without `#`.
- **Paths**: every `file` is absolute and readable by ffmpeg. Sources may live in `projects/<id>/`, `data/edits/edits/<id>/sources/`, or anywhere a host passed to `planEdit({ files })`. Music lives in `data/sounds/` or the edit folder. SFX are in `edits/sfx/`, served at `<mount>/sfx/<name>.mp3`.

## Top level

| Field | Meaning |
|---|---|
| `contract` | `"edit-plan/1"` |
| `editId`, `name`, `planVersion`, `createdAt` | identity |
| `director` | `{ mode: "claude" \| "demo", concept, notice }`. `notice` is a user-facing reason Claude wasn't used; show it when present |
| `width`, `height`, `fps`, `length` | canvas (internal). `canvas` repeats them as `{ width, height, fps, duration, background }` |
| `look`, `lookIntensity`, `lut` | internal grade choice; resolved values are in `grade` |
| `textStyle`, `accent`, `title`, `concept` | internal |
| `music` | internal `{ file, start, gain, bpm }`: `start` = seconds into the song at timeline 0 |
| `markers` | `{ bpm, beats[], downbeats[], drop }` on the timeline. Beats past the song's end are extrapolated from its tempo; `drop` is `null` when it isn't inside the edit |
| `sources` | `{ A: { name, projectId, file, duration, width, height, fps, hasAudio } }` |
| `shots[]` | see below |
| `transitions[]` | `{ from, to, type, duration, start, sfx }` for every cut (type `cut` has duration 0) |
| `effectCues[]` | non-motion effects as timed cues (see Effects) |
| `texts[]` | internal `{ start, end, text, y (0–1), size }` plus `xPx`, `yPx`, `style` (resolved) |
| `textStyleResolved` | the resolved style used by every `texts[]` item |
| `captions[]` | internal `{ start, end, words: [{ s, e, text }] }`, 3 words per group, timeline times |
| `captionStyle` | resolved caption style: the active word takes `activeColor` |
| `sfx[]` | internal `{ name, at, offset?, duration, gain }` |
| `grade` | `{ look, label, intensity, params, cssFilter, overlays, ffmpeg }` |
| `audio` | `{ music, dialogue[], sfx[], master }`, resolved (see Audio) |

## Shots

Internal fields (unchanged):

| Field | Meaning |
|---|---|
| `index`, `source`, `moment`, `why` | which source (letter) and analyzed moment; the director's reason |
| `file` | absolute path of the source video |
| `in` | source second where this shot's material starts (includes pre-roll) |
| `slotStart`, `slotEnd` | the beat-aligned slot on the timeline; cuts happen exactly at `slotStart` |
| `pre`, `post` | overlap into the previous/next shot for transitions (half of each transition's duration) |
| `length` | rendered duration = `slotEnd − slotStart + pre + post`; the shot occupies `[slotStart − pre, slotEnd + post]` |
| `speed` | speed move name (`normal` `slow` `fast` `ramp` `ramp-fast` `reverse` `stutter` `freeze`) |
| `parts[]` | time remap: `{ src, out, speed, reverse?, freeze? }`. Consecutive; each plays `out` seconds starting `src` seconds after `in` at `speed`; `freeze` holds the frame at `src` |
| `effects[]` | effect names (max 3) |
| `beats[]` | beat times local to the shot (for beat-zoom and strobe) |
| `transition` | `{ type, duration }` into this shot (first shot: `cut`) |
| `nextTransition`, `edgeIn`, `edgeOut` | treatment on this shot's edges: `blur` (whips) or `rgb` (glitch) |
| `focusX`, `frame` | crop focus 0–100 and `fill` or `fit` |
| `useAudio` | play this shot's own sound (dialogue) |
| `text` | word slam over this shot (also listed in `texts[]`) |

Resolved additions:

| Field | Meaning |
|---|---|
| `projectId` | HBA Clips project of the source, or `null` |
| `timeline` | `{ start: slotStart − pre, duration: length }` |
| `sourceWindow` | `{ in, out }` source seconds the shot reads |
| `speedSegments[]` | `parts` on the timeline: `{ timelineStart, duration, sourceStart, rate, reverse, freeze }` |
| `reframe` | `fill`: scale to cover, crop at `focusX`/`focusY` (0 = left/top, 1 = right/bottom; `focusY` is 0.42). `fit`: whole frame centered over a copy that covers the canvas, blurred ~40 px, brightness −0.1, saturation 1.25 |
| `motion` | `null`, or samples `[t, scale, x, y]`: local time, scale about the canvas center, translation in px applied after scaling. Interpolate linearly; collinear samples are dropped |
| `transitionIn` | `{ type, duration, start, sfx }` or `null` |
| `audio` | `{ gain, fadeInSec, fadeOutSec }` when `useAudio`, else `null` |

## Transitions

A transition of duration `d` is centered on the cut: it starts at `slotStart − d/2`, and both shots are on screen for `d`. SFX cues are already in `sfx[]`.

| Type | ffmpeg reference (`xfade`) | Looks like | d | SFX | Edges |
|---|---|---|---|---|---|
| `cut` | none | hard cut on the beat | 0 | | |
| `flash` | `fadewhite` | A blows out to white, white resolves into B | 0.2 | impact | |
| `dip-black` | `fadeblack` | quick breath through black | 0.33 | | |
| `whip-left` / `whip-right` / `whip-up` / `whip-down` | `smoothleft` / `smoothright` / `smoothup` / `smoothdown` | B pushes A out in that direction with a soft seam; both edges motion-blurred along the axis (σ 34 px) | 0.2 | whoosh-short | blur |
| `zoom` | `zoomin` | A scales up toward the center while crossfading into B | 0.27 | whoosh | |
| `glitch` | `pixelize` | pixel blocks grow and resolve into B; RGB split on both edges | 0.2 | glitch | rgb |
| `blur` | `hblur` | horizontal smear crossfade | 0.27 | whoosh-short | |
| `dissolve` | `fade` | plain crossfade | 0.47 | | |
| `slide` | `slideleft` | hard-edged push, B slides in from the right | 0.27 | whoosh-short | |
| `squeeze` | `squeezeh` | A squashes horizontally to a line, B expands from it | 0.24 | whoosh-short | |
| `circle` | `circleopen` | B revealed through a circle growing from the center | 0.33 | whoosh | |
| `radial` | `radial` | clock-hand wipe | 0.3 | whoosh-short | |
| `slices` | `hlslice` | horizontal slices wipe across | 0.3 | whoosh-short | |

Durations are rounded to an even number of frames; a transition is downgraded to `cut` when either shot is too short for it.

## Effects

Motion effects are baked into `shot.motion`; the rest are in `effectCues[]` as `{ shot, type, start, duration, params }` on the timeline. "Landing" = the shot's `slotStart` (local `pre`). `n` = frames since the shot's timeline start.

| Effect | Exact behavior |
|---|---|
| `punch` | zoom: crop fraction `z` rises linearly 0→0.075 over 3 frames from the landing, then decays `0.075·e^(−(n−3)/7)`. scale = `1/(1−2z)` (peak ≈ 1.18) |
| `beat-zoom` | a 0.045 punch on each beat inside the shot (max 16) |
| `push` / `pull` | `z` linear 0→0.085 across the shot (scale 1→1.2), or the reverse |
| `shake` | base `z` 0.03; from the landing `dx = 24·e^(−n/6)·sin(2.3n)`, `dy = 18·e^(−n/6)·cos(2.9n)` px (at 1080 wide) |
| `rumble` | base `z` 0.025; `dx = 7·sin(1.31n) + 4·sin(2.77n)`, `dy = 6·sin(1.73n+1) + 3·sin(3.1n)` |
| `rgb` → `rgb-split` | red channel shifted (−16, +5) px, blue (+16, −5) px for 0.17 s at the landing |
| `flash` | brightness +0.38 for 2 frames, then +0.16 for 2 frames |
| `strobe` | brightness +0.24 for 0.05 s on every beat in the shot |
| `echo` | frame blend of the current and 3 previous frames, weights 1 / 0.75 / 0.5 / 0.3 (ghost trails). An approximation is fine |
| `invert` | negative image for 2 frames at the landing |
| `letterbox` | black bars, 11% of the height, top and bottom |
| `mono` | this shot in black and white (on top of the global grade) |
| `blur-in` | gaussian σ 22 px until landing + 0.1 s, σ 8 px until + 0.2 s, then sharp |
| `motion-blur` (edge) | directional blur σ 34 px on a whip's overlapping frames |

Speed moves (`parts`, with L = shot length): `slow` 0.5×; `fast` 1.6×; `ramp` 1× for 34%, 0.33× for 42%, 1× for the rest; `ramp-fast` 0.45× for 50%, then 1.9×; `reverse` backwards at 1×; `stutter` repeats the first `min(beat/4, L/5)` twice, then plays on; `freeze` plays 62%, then holds that frame.

## Grade

`grade.params` are the look's values at `intensity` (lerped from neutral):

| Param | Neutral | ffmpeg meaning |
|---|---|---|
| `contrast`, `saturation`, `gamma`, `brightness` | 1, 1, 1, 0 | `eq` |
| `warmth` (−1…1) | 0 | + warms (R up, B down) through shadows, mids and highlights |
| `tint` (−1…1) | 0 | + magenta, − green |
| `shadows`, `highlights` | [0, 0, 0] | RGB offsets for split toning (`colorbalance`, −1…1) |
| `fade` (0…1) | 0 | lifts blacks to `0.11·fade` and pulls whites down by `0.05·fade` (matte) |
| `vignette` (0…1) | 0 | vignette angle `0.18 + 0.45·v` radians |
| `grain` (0…1) | 0 | temporal noise, strength `22·g` of 255 |
| `sharpen`, `soften` | 0 | unsharp amount; gaussian σ `1.6·s` px |
| `mono` | 0 | 1 = black and white |

`grade.cssFilter` is the closest single CSS filter. Split tone, fade, vignette and grain don't fit a filter, so they're repeated in `grade.overlays`. `grade.ffmpeg` is the exact chain render.js uses, for reference.

| Look | Character |
|---|---|
| `natural` | true color, extra punch and crispness |
| `teal-orange` | teal shadows, warm skin and highlights |
| `moody-film` | muted, matte blacks, grain |
| `warm-vintage` | faded warm film stock, soft, heavy grain |
| `cold-crisp` | cool cast, hard contrast, sharp |
| `bleach` | gritty, high contrast, desaturated |
| `noir` | deep black and white, grain, heavy vignette |
| `neon-night` | saturated magenta/cyan nightlife |
| `golden-hour` | sun-soaked warm glow |
| `dream-haze` | soft pastel, milky blacks |
| `gritty` | crunchy detail, muted, grain |
| `none` | as shot |

## Text and captions

`textStyleResolved` / `texts[].style`: `{ font, weight, sizePx, color, outlinePx, outlineColor, shadowPx, letterSpacingPx, uppercase, glow, box, animation, animationTiming, maxWidthPx, shrink }`. Text is centered on `(xPx, yPx)` and wrapped to `maxWidthPx`; `sizeScale` (internal `size`) multiplies `sizePx`. `box: true` means the outline color becomes an opaque box behind dark text. `glow: true` adds a blurred outline layer underneath.

| Style | Font | Animation |
|---|---|---|
| `slam` | Impact | slam |
| `clean` | Avenir Next Condensed Heavy | rise |
| `minimal` | Futura, spaced 14 | fade |
| `neon` | Futura Bold, accent outline, glow | flicker |
| `boxed` | DIN Condensed Bold on an accent box | slam |

Animation timings are spelled out in `animationTiming`. Captions: one line of up to 3 words at `captionStyle.yPx`; each word is `activeColor` while it's spoken, and the first word of a group pops from 0.88× to 1× over 80 ms.

## Audio

| Field | Meaning |
|---|---|
| `audio.music` | `{ trackId, name, file, sourceStart, bpm, volume: { points: [{ t, gain }], duckGain, fadeOutSec } }`. Interpolate gain linearly between points; ducking under dialogue is already in the points |
| `audio.dialogue[]` | `{ shot, file, sourceStart, timelineStart, duration, gain, fadeInSec, fadeOutSec }` |
| `audio.sfx[]` | `{ name, file, url, at, sourceStart, duration, gain, fadeOutSec }`: play `file` from `sourceStart` for `duration` starting at timeline `at` |
| `audio.master` | `{ loudnessLufs: -14, truePeakDb: -1.5 }` |

SFX files (Pixabay Content License, no attribution required; see `edits/sfx/CREDITS.md`): `whoosh`, `whoosh-short`, `whoosh-cinematic`, `impact-bass-1`, `impact-bass-2`, `glitch-1`, `glitch-2`, `riser`, `pop`.
