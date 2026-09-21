# Timeline editor

"Preview & edit" for a generated clip: a full-screen, timeline-based editor. It is owned by the **Video Editor** session (it took over from the Timeline session): `editor/` and `data/editor/`.

- **Opens at** `#/edit/<projectId>/<clipId>`. `public/app.js` routes there and imports `/api/editor/ui/editor.js`.
- **API** mounted by `server.js` at `/api/editor`.
- **Dev server:** `node editor/dev.js` → http://localhost:5193. It serves `public/` from disk, mounts this router, and proxies everything else to HBA Clips on 5173.

## Model

The editor state is separate from rendering. The editor edits a **document**. The server turns that document into composition inputs (`document.js` `compositionInputs`), and `lib/compose.js` builds the HTML from them, the same way it does for renders.

```
Document { version, projectId, clipId, rev, aspect, fps, design, tracks[] }
Track    { id, kind: text|caption|video|audio, role?: voice|music, name, hidden, locked, muted, clips[] }
Clip     { id, type, start, duration, link?, transform? }
  video/audio  + sourceStart, sourceEnd, speed, volume      (music also has sound, name, loop)
  text         + content, highlight, style { preset }
  caption      + words [{ text, s, e }]   (s and e are relative to the clip's start)
```

- **First open:** `seedDocument` builds the document from `planClip`. The kept pieces become linked video and voice clips. The re-timed words are grouped into caption clips with `groupCaptions`. The hook title becomes a text clip and the bed becomes a music clip. So a clip opens looking exactly like its current preview and render.
- **Saving:** documents autosave to `data/editor/<projectId>/<clipId>.json` (`PUT …/document`, with a revision check). `DELETE …/document` goes back to the AI edit.
- **Media:** waveform peaks (`…/peaks`, 50 per second) and filmstrip frames (`…/thumbs/<sec>`) are cut with ffmpeg and cached under `data/editor/`.

## Front end (`public/`, plain ES modules, no build)

| File | Role |
|---|---|
| `editor.js` | Mounts the workspace. Holds the actions, keyboard shortcuts, resizable panels, context menu and export modal. |
| `store.js` | Document plus undo/redo history (drags count as one step), selection, playhead, debounced autosave. |
| `model.js` | Pure timeline operations: move, trim, split, delete, ripple delete, duplicate, place, snap. Linked clips move together. |
| `timeline.js` | Ruler, track headers, keyed clip nodes (filmstrip, waveform, blocks), playhead, drag, trim and scrub. |
| `canvas.js` | HyperFrames player on the saved document, transport, clip switcher, AI score. |
| `inspector.js` | Settings for the selection: the clip, a title, a caption, video or audio. |
| `assets.js` | Tool rail and panels: media library, sounds, add text. |
| `header.js` | Breadcrumbs, autosave status, undo/redo, share, export. |

## AI director (`director/`)

The creator uploads slides (PDF, PowerPoint, PNG/JPG) and phone screen recordings or B-roll. The director places them on the timeline where they talk about them, and turns a few key lines into big glowing captions behind the speaker. Everything it does becomes ordinary timeline clips that can be moved, trimmed, re-laid-out or deleted, and one undo removes the whole pass.

| File | Role |
|---|---|
| `director/assets.js` | Uploads under `data/editor/<project>/assets/<id>/`. PDFs become trimmed slide PNGs plus text (`tools/pdfslides.swift`, PDFKit). PowerPoint slides are rebuilt from their text and pictures. Videos become seekable H.264 with sample frames. |
| `director/plan.js` | Claude (`claude-opus-5`) reads the timeline's caption words, looks at the slides and recording frames, and follows `shared/EDITOR_STYLE.md` when present. It returns cues, which are validated (no overlaps, breathing room, scarce emphasis) and then applied as the `overlay` and `emphasis` tracks. Without a key it falls back to keyword matching. |
| `director/matte.js` | Person cutouts for big captions: only the seconds under each caption go through `hyperframes remove-background` into a transparent WebM under `data/editor/<project>/mattes/`. |
| `director/layers.js` | Adds the layers to the composition's own GSAP timeline. The speaker's picture is scaled and clipped into a box while slides, phones and B-roll animate in and out. Big captions sit in a layer over the video with the cutout on top, and the cutout copies the footage's zoom tweens. |
| `director/render.js` | `applyEditorLayers(project, doc, dir)`: copies slides, recordings and cutouts into a render folder and injects the layers. `lib/pipeline.js` calls it for editor-edited clips. |

Tracks: `overlay` clips have `{ source: slide|screen|broll, asset, page?, sourceStart?, layout: split|full|card|pip, side, focus? }`, and `emphasis` clips have `{ text }`. The clip id `full` opens the whole recording for long-form edits.

The renderer draws `<video>` frames above DOM placed among them, so text never goes inside the video wrappers. `hyperframes snapshot` ignores WebM alpha, so check cutouts with a real `render`.

## Not honored by the composer yet (later phases)

These live in the document but don't reach the preview or render yet:

- Only the first title plays, and it always opens at 0.1s.
- Captions are regrouped by `maxWords` rather than by caption clip.
- The voice track can be muted but has no volume level.
- Export renders through the existing pipeline. It picks up title, look and format, but not timeline trims, splits or moves.

Phase 6 replaces the export path with a composer that reads the document directly.
