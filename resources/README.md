# Assets

The **Assets** tab (`#/assets`) holds the creator's brand kit and resources in one place: logos, fonts, colors, title animations, transitions, brand guidelines, SOPs, examples and anything else. Owned by the **ASSETS** session: `resources/` and `data/resources/`.

Upload with **Upload files** or the section tiles (Logos, Brand guidelines, SOPs, Fonts, Examples, Anything else): click a tile to pick files, or drop files onto it to file them in that section. Files dropped anywhere else on the page are sorted too. In **All**, each file is sorted by type (fonts → Fonts, images → Logos, videos → Examples, PDFs/docs → SOPs, names containing "brand"/"guideline" → Brand guidelines). Inside a section, dropped files go into that section. **Add asset** covers everything else: links (Drive, Notion, Figma, a reference Reel), pasted SOP or guideline text, and color palettes.

The fonts and HyperFrames blocks already in `assets/` show up read-only as **Built in**.

| File | What it is |
|---|---|
| `index.js` | Library store and the `/api/resources` router |
| `public/assets.js` | The page. `mountAssets(el)` renders into `#app` and returns a cleanup function |
| `public/assets.css` | Styles. Theme tokens only; swatches use the creator's own hex values inline |
| `dev.js` | Dev server on port 5194. Patches the nav link and route in, and proxies the rest to :5173 |
| `data/resources/library.json` | Every asset's metadata |
| `data/resources/files/<id>/` | Uploaded files |

## Hooks for ENGINE (one-time)

**`server.js`**: mount the API.

```js
import { router as resourcesRouter } from "./resources/index.js";
app.use("/api/resources", resourcesRouter);
```

**`public/index.html`**: add the nav link after Sounds.

```html
<a href="#/assets" data-nav="assets"><svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="7" height="7" rx="1.5" /><rect x="13.5" y="4" width="7" height="7" rx="1.5" /><rect x="3.5" y="14" width="7" height="7" rx="1.5" /><circle cx="17" cy="17.5" r="3.5" /></svg>Assets</a>
```

**`public/app.js`**, in `route()` just before `const projectMatch = …`:

```js
if (pathPart.startsWith("/assets")) {
  $$("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === "assets"));
  const { mountAssets } = await import("/api/resources/ui/assets.js");
  await mountAssets(app);
  window.scrollTo(0, 0);
  return;
}
```

**`public/shell.js`** (Design session): add `["Assets", "#/assets", "Brand kit and resources"]` to `PAGES` so ⌘K finds it.

## HTTP API: `/api/resources`

| Method & path | Returns |
|---|---|
| `GET /` | `{ types, items, builtins }`. Items are pinned first, then newest. |
| `GET /brand` | The brand kit for other features: `{ colors[{ name, hex, palette }], fonts[{ family, url }], logos[{ title, url, mime }], guidelines[{ title, body, url }], titleAnimations[], transitions[] }` |
| `POST /items` | Multipart or JSON: `type, title, notes, body, tags, url, colors, fontFamily, pinned` plus optional `file`. Needs at least a file, link, colors or text. |
| `POST /upload` | Multipart `files[]` plus optional `type`. Creates one asset per file. |
| `PATCH /items/:id` | Same fields. A new `file` replaces the old one, and `removeFile=true` drops it. |
| `DELETE /items/:id` | Removes the asset and its file. |
| `GET /items/:id/file` | The file itself. Add `?download` to save it under its original name. |

`colors` accepts a JSON array of `{ name, hex }` or free text like `Navy #0b1f3a, Coral #ff6f61`.

## For other sessions

Read `GET /api/resources/brand` instead of asking the creator for brand colors, fonts or logos again. The director (`editor/director/`), titles and Dope edits can use it for caption colors, title fonts and end-card logos. It's read-only: new assets come in through the Assets tab.
