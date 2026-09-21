// Pictures and PDFs uploaded alongside a video: slides, an offer sheet, screenshots, notes. They're kept in
// projects/<id>/materials/ and handed to Claude with the transcript when it picks clips and writes titles, so the
// names, numbers and terms on them come out right.
import fs from "node:fs/promises";
import path from "node:path";
import { projectDir } from "./store.js";
import { run } from "./tools.js";

export const MATERIAL_EXT = /\.(jpe?g|png|gif|webp|heic|heif|tiff?|bmp|pdf)$/i;
const CLAUDE_IMAGE = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // what goes into one Claude request, after images are shrunk
const MAX_FILES = 20;

export const isMaterial = (file) => file.mimetype === "application/pdf" || file.mimetype?.startsWith("image/") || MATERIAL_EXT.test(file.originalname || "");
export const materialsDir = (projectId) => path.join(projectDir(projectId), "materials");

/** project.materials entries for files multer just saved into the materials folder. */
export function materialRecords(files = []) {
  return files.map((f) => ({
    file: f.filename,
    name: String(f.originalname || f.filename).slice(0, 160),
    kind: /\.pdf$/i.test(f.filename) ? "pdf" : "image",
    size: f.size,
    addedAt: new Date().toISOString(),
  }));
}

/**
 * An image Claude can read, at most 1568px on its long side: the original when it already is one, else a JPEG made
 * with macOS `sips` (HEIC from an iPhone, TIFF, oversized photos). Cached next to the original.
 */
async function claudeImage(file) {
  const ext = path.extname(file).toLowerCase();
  const stat = await fs.stat(file);
  if (CLAUDE_IMAGE[ext] && stat.size <= 1.5 * 1024 * 1024) return { file, mediaType: CLAUDE_IMAGE[ext] };
  const out = `${file}.claude.jpg`;
  try {
    await fs.access(out);
  } catch {
    await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", "1568", file, "--out", out]);
  }
  return { file: out, mediaType: "image/jpeg" };
}

/** A picture ffmpeg can read for a slide: the original, or a JPEG copy of HEIC, TIFF and BMP made with `sips`. */
export async function slideImage(projectId, file) {
  const src = path.join(materialsDir(projectId), file);
  if (/\.(jpe?g|png|webp|gif)$/i.test(file)) return src;
  const out = `${src}.slide.jpg`;
  try {
    await fs.access(out);
  } catch {
    await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "90", "-Z", "2400", src, "--out", out]);
  }
  return out;
}

/** Claude content blocks for a project's materials (newest last), within the request budget. */
export async function materialBlocks(project) {
  const list = (project.materials || []).slice(-MAX_FILES);
  // Pictures are numbered the way lib/longedit.js asks Claude to place slides: in upload order, from 0.
  const pictures = (project.materials || []).filter((m) => m.kind === "image");
  const blocks = [];
  let total = 0;
  for (const m of list) {
    try {
      const src = path.join(materialsDir(project.id), m.file);
      const { file, mediaType } = m.kind === "pdf" ? { file: src, mediaType: "application/pdf" } : await claudeImage(src);
      const data = await fs.readFile(file);
      if (total + data.length > MAX_TOTAL_BYTES) continue;
      total += data.length;
      blocks.push({ type: "text", text: m.kind === "pdf" ? `PDF: ${m.name}` : `Picture ${pictures.indexOf(m)}: ${m.name}` });
      blocks.push(
        m.kind === "pdf"
          ? { type: "document", source: { type: "base64", media_type: mediaType, data: data.toString("base64") }, title: m.name }
          : { type: "image", source: { type: "base64", media_type: mediaType, data: data.toString("base64") } },
      );
    } catch (err) {
      console.error(`[${project.id}] material ${m.name} skipped:`, err.message);
    }
  }
  return blocks;
}
