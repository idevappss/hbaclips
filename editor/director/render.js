// Renders: the director layers go into the composition folder lib/pipeline.js just built for an edited clip, with
// every slide, recording and cutout they use copied in next to it (renders can't reach the editor's API).
import fs from "node:fs/promises";
import path from "node:path";
import { layerResolver } from "../index.js";
import { emphasisClips, injectLayers, overlayClips } from "./layers.js";

/** Add the saved document's overlays and big captions to <compositionDir>/index.html. No-op without any. */
export async function applyEditorLayers(project, doc, compositionDir) {
  if (!doc || (!overlayClips(doc).length && !emphasisClips(doc).length)) return;
  const copies = [];
  const stage = (from, rel) => {
    copies.push([from, path.join(compositionDir, "assets", rel)]);
    return `assets/${rel.split("/").map(encodeURIComponent).join("/")}`;
  };
  const resolve = await layerResolver(project, doc, { preview: false, stage });
  const file = path.join(compositionDir, "index.html");
  const html = injectLayers(await fs.readFile(file, "utf8"), doc, resolve);
  for (const [from, to] of copies) {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to).catch((err) => console.error("Editor layers: couldn't copy", from, err.message));
  }
  await fs.writeFile(file, html);
}
