# Titles

Teaches Claude the creator's taste in titles and applies it to every clip. Owned by the **TITLES** session.

| File | What it is |
|---|---|
| `favorites.json` | `liked`: titles they love. `avoid`: titles they rejected. Hand-edited clip titles land in `liked` with `editedFrom`. |
| `STYLE.md` | Style guide distilled from the favorites. Sent with every title request (HTML comments are stripped). |
| `index.js` | Library, the `titleGuidance()` prompt block, `generateTitles()`, and the `/api/titles` router. |
| `cli.js` | Manage favorites and title clips from the terminal (usage at the top of the file). |

"Training" here means few-shot examples plus a distilled style guide, refreshed as favorites and edits pile up. No model fine-tuning is involved.

## Hooks for ENGINE (one-time)

**`lib/analyze.js`**: every analysis gets the taste block in its system prompt.

```js
import { titleGuidance } from "../titles/index.js";
// in analyze(), in the client.beta.messages.parse call:
system: [SYSTEM, await titleGuidance()].filter(Boolean).join("\n\n"),
```

**`server.js`**: mount the API, and learn from hand edits.

```js
import { router as titlesRouter, recordEdit } from "./titles/index.js";
app.use("/api/titles", titlesRouter);

// PATCH /api/projects/:id/clips/:clipId, before clip.title is overwritten:
if (typeof title === "string" && title.trim() && title.trim() !== clip.title) {
  recordEdit({ before: clip.title, after: title, kind: "hook", source: `${project.id}/${clip.id}` }).catch((err) => console.error("Title edit not recorded:", err));
}
```

**`public/app.js`**: a ♥ and ✕ on each "Viral title ideas" row, and next to each clip's title input.

```js
api("/api/titles/liked", { method: "POST", body: { title, kind } }); // kind: "idea" for title ideas, "hook" for clip titles
api("/api/titles/avoid", { method: "POST", body: { title, kind } });
```

## HTTP API: `/api/titles`

| Method & path | Body | Returns |
|---|---|---|
| `GET /` | | `{ liked, avoid }` |
| `POST /liked` | `{ title, kind?, note? }` | the saved entry |
| `POST /avoid` | `{ title, kind?, note? }` | the saved entry |
| `POST /remove` | `{ title }` | `{ removed }` |
| `POST /generate` | `{ projectId, clipId, kind?, count? }` or `{ transcript, kind?, count? }` | `{ titles: [{ title, angle, why }] }` |

`kind` is `hook` (on-screen clip headline, max 8 words), `opener` (opening line for the first two seconds, max 15 words), `post` (post title), `youtube` (YouTube title) or `idea`. Generation needs `ANTHROPIC_API_KEY`.

UI mapping: clip title inputs → `hook`, Fire hooks → `opener`, YouTube titles → `youtube`, Viral titles → `idea`.
