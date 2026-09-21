// The footage a creator brings to an edit besides the talking video: slide decks (PDF, PowerPoint, images),
// phone screen recordings and B-roll. Each upload is turned into something the director can read (slide text,
// frames) and the composer can play (slide PNGs, an edit-friendly MP4), under data/editor/<project>/assets/<id>/.
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { probe } from "../../lib/media.js";
import { FFMPEG, ROOT, run } from "../../lib/tools.js";
import { DATA_DIR } from "../media.js";

const SWIFT_SRC = path.join(ROOT, "editor", "tools", "pdfslides.swift");
const PDF_BIN = path.join(ROOT, "data", "bin", "pdfslides");
const r3 = (n) => Math.round(n * 1000) / 1000;

export const assetsDir = (projectId) => path.join(DATA_DIR, projectId, "assets");
const manifestFile = (projectId) => path.join(assetsDir(projectId), "assets.json");

export const ACCEPT = {
  slides: [".pdf", ".pptx", ".key", ".png", ".jpg", ".jpeg", ".webp"],
  video: [".mp4", ".mov", ".m4v", ".webm", ".mkv"],
};
export const acceptsFile = (name) => [...ACCEPT.slides, ...ACCEPT.video].includes(path.extname(name).toLowerCase());

// ---------- manifest ----------
const locks = new Map();
function withManifest(projectId, fn) {
  const prev = locks.get(projectId) || Promise.resolve();
  const next = prev.then(async () => {
    const list = await listAssets(projectId);
    const out = await fn(list);
    const file = manifestFile(projectId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(list, null, 1));
    await fs.rename(tmp, file);
    return out;
  });
  locks.set(projectId, next.catch(() => {}));
  return next;
}

export async function listAssets(projectId) {
  try {
    return JSON.parse(await fs.readFile(manifestFile(projectId), "utf8"));
  } catch {
    return [];
  }
}

export async function getAsset(projectId, assetId) {
  return (await listAssets(projectId)).find((a) => a.id === assetId) || null;
}

const patch = (projectId, id, fields) =>
  withManifest(projectId, (list) => {
    const a = list.find((x) => x.id === id);
    if (a) Object.assign(a, fields, { updatedAt: new Date().toISOString() });
    return a;
  });

/** The creator re-labels a video: a phone screen recording (side by side) or B-roll (full frame cutaway). */
export const withRole = (projectId, assetId, role) => patch(projectId, assetId, { role: role === "broll" ? "broll" : "screen" });

export async function removeAsset(projectId, assetId) {
  await withManifest(projectId, (list) => {
    const i = list.findIndex((a) => a.id === assetId);
    if (i >= 0) list.splice(i, 1);
  });
  await fs.rm(path.join(assetsDir(projectId), assetId), { recursive: true, force: true });
}

/** Public URL for a file inside an asset folder (served by the editor router). */
export const assetUrl = (projectId, assetId, file) => `/api/editor/projects/${projectId}/assets/${assetId}/files/${encodeURIComponent(file)}`;

// ---------- ingest ----------
/**
 * Adopt an uploaded file (moved out of multer's temp dir) and start processing it in the background.
 * `role` is the creator's hint ("slides" | "screen" | "broll"); videos default to "screen" when portrait.
 */
export async function addAsset(projectId, { tmpPath, originalName, role }) {
  const ext = path.extname(originalName).toLowerCase();
  if (!acceptsFile(originalName)) throw new Error(`${originalName}: use a PDF, PowerPoint, image or video file.`);
  const id = `as_${crypto.randomBytes(5).toString("hex")}`;
  const dir = path.join(assetsDir(projectId), id);
  await fs.mkdir(dir, { recursive: true });
  const original = `original${ext}`;
  await fs.rename(tmpPath, path.join(dir, original)).catch(async () => {
    await fs.copyFile(tmpPath, path.join(dir, original));
    await fs.rm(tmpPath, { force: true });
  });
  const kind = ACCEPT.video.includes(ext) ? "video" : ext === ".pdf" || ext === ".pptx" || ext === ".key" ? "deck" : "image";
  const asset = {
    id,
    kind,
    role: kind === "video" ? (["screen", "broll"].includes(role) ? role : null) : "slides",
    name: path.basename(originalName, ext).slice(0, 120) || "Upload",
    ext,
    original,
    status: "processing",
    error: null,
    createdAt: new Date().toISOString(),
  };
  await withManifest(projectId, (list) => list.push(asset));
  processAsset(projectId, asset).catch(async (err) => {
    console.error("Editor asset:", err);
    await patch(projectId, id, { status: "error", error: friendly(err) });
  });
  return asset;
}

const friendly = (err) => String(err?.message || err).split("\n")[0].slice(0, 240);

async function processAsset(projectId, asset) {
  const dir = path.join(assetsDir(projectId), asset.id);
  const src = path.join(dir, asset.original);
  if (asset.kind === "video") return patch(projectId, asset.id, { ...(await ingestVideo(src, dir, asset)), status: "ready" });
  if (asset.kind === "image") return patch(projectId, asset.id, { ...(await ingestImage(src, dir)), status: "ready" });
  if (asset.ext === ".pdf") return patch(projectId, asset.id, { ...(await ingestPdf(src, dir)), status: "ready" });
  if (asset.ext === ".pptx") return patch(projectId, asset.id, { ...(await ingestPptx(src, dir)), status: "ready" });
  throw new Error("Keynote files can't be read directly. In Keynote choose File › Export To › PDF, then upload the PDF.");
}

/** A video becomes an H.264 MP4 with a keyframe every frame-second (seekable in renders), plus a few frames to look at. */
async function ingestVideo(src, dir, asset) {
  const out = path.join(dir, "media.mp4");
  await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", src,
    "-vf", "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))',fps=30,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-g", "30", "-keyint_min", "30",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out]);
  const info = await probe(out);
  const frames = [];
  const count = Math.min(6, Math.max(2, Math.round(info.duration / 8)));
  for (let i = 0; i < count; i++) {
    const at = r3(((i + 0.5) / count) * info.duration);
    const file = `frame-${i + 1}.jpg`;
    await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(at), "-i", out, "-frames:v", "1", "-vf", "scale=-2:480", "-q:v", "5", path.join(dir, file)]);
    frames.push({ at, file });
  }
  const portrait = info.height > info.width;
  return {
    file: "media.mp4",
    duration: r3(info.duration),
    width: info.width,
    height: info.height,
    hasAudio: info.hasAudio,
    role: asset.role || (portrait ? "screen" : "broll"),
    frames,
    poster: frames[0]?.file || null,
  };
}

async function ingestImage(src, dir) {
  const file = "slide-001.png";
  await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", src, "-vf", "scale='min(1920,iw)':-2", path.join(dir, file)]);
  const info = await probe(path.join(dir, file)).catch(() => ({ width: 1920, height: 1080 }));
  return { slides: [{ page: 1, file, width: info.width, height: info.height, text: "" }], poster: file };
}

let pdfBinary = null;
function pdfTool() {
  pdfBinary ??= (async () => {
    const [srcStat, bin] = await Promise.all([fs.stat(SWIFT_SRC), fs.stat(PDF_BIN).catch(() => null)]);
    if (!bin || bin.mtimeMs < srcStat.mtimeMs) {
      await fs.mkdir(path.dirname(PDF_BIN), { recursive: true });
      await run("swiftc", ["-O", SWIFT_SRC, "-o", PDF_BIN]);
    }
    return PDF_BIN;
  })().catch((err) => {
    pdfBinary = null;
    throw new Error(`Couldn't build the PDF reader: ${friendly(err)}`);
  });
  return pdfBinary;
}

async function ingestPdf(src, dir) {
  const bin = await pdfTool();
  const slides = JSON.parse(await run(bin, [src, dir, "1920"]));
  if (!slides.length) throw new Error("That PDF has no pages.");
  return { slides, poster: slides[0].file };
}

/**
 * PowerPoint without Office: macOS can't draw .pptx slides, so each slide is rebuilt from its own text and
 * pictures (the composer designs the card). For a pixel-exact deck, export it to PDF and upload that.
 */
async function ingestPptx(src, dir) {
  const list = await run("unzip", ["-Z1", src]);
  const names = list.split("\n").map((s) => s.trim()).filter(Boolean);
  const slideNames = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/g).pop()) - Number(b.match(/\d+/g).pop()));
  if (!slideNames.length) throw new Error("That PowerPoint has no slides.");
  const slides = [];
  for (const [i, name] of slideNames.entries()) {
    const xml = await run("unzip", ["-p", src, name]);
    const paragraphs = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
      .map((p) => [...p[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => decodeXml(t[1])).join(""))
      .map((s) => s.trim())
      .filter(Boolean);
    const rels = await run("unzip", ["-p", src, name.replace("slides/", "slides/_rels/") + ".rels"]).catch(() => "");
    const media = [...rels.matchAll(/Target="\.\.\/media\/([^"]+\.(?:png|jpe?g|gif))"/gi)].map((m) => m[1]);
    let image = null;
    if (media.length) {
      image = `slide-${String(i + 1).padStart(3, "0")}-image${path.extname(media[0]).toLowerCase()}`;
      await fs.writeFile(path.join(dir, image), await runBuffer("unzip", ["-p", src, `ppt/media/${media[0]}`]));
    }
    slides.push({ page: i + 1, file: null, image, title: paragraphs[0] || "", bullets: paragraphs.slice(1, 7), text: paragraphs.join(" · ").slice(0, 1200), rebuilt: true });
  }
  return { slides, poster: slides.find((s) => s.image)?.image || null, notice: "Rebuilt from the PowerPoint's text and pictures. Upload a PDF export to use your exact slide design." };
}

const decodeXml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

async function runBuffer(cmd, args) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    const out = [];
    child.stdout.on("data", (c) => out.push(c));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

/** What the director reads about every ready asset. */
export async function assetBriefs(projectId) {
  return (await listAssets(projectId))
    .filter((a) => a.status === "ready")
    .map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      role: a.role,
      duration: a.duration,
      orientation: a.width && a.height ? (a.height > a.width ? "portrait" : "landscape") : undefined,
      slides: a.slides?.map((s) => ({ page: s.page, text: s.text })),
      frames: a.frames?.map((f) => ({ at: f.at, path: path.join(assetsDir(projectId), a.id, f.file) })),
      slideImages: a.slides?.filter((s) => s.file).map((s) => ({ page: s.page, path: path.join(assetsDir(projectId), a.id, s.file) })),
    }));
}

export const assetFilePath = (projectId, assetId, file) => {
  const p = path.join(assetsDir(projectId), assetId, path.basename(file));
  return existsSync(p) ? p : null;
};
