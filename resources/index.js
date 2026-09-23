// Assets library: logos, fonts, brand colors, title animations, transitions, SOPs, brand guidelines and examples,
// kept in one place so every clip and edit can pull from them. Owned by the ASSETS session.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { ROOT } from "../lib/tools.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(ROOT, "data", "resources");
const FILE = path.join(DATA_DIR, "library.json");
const FILES_DIR = path.join(DATA_DIR, "files");
const BUILTIN_DIR = path.join(ROOT, "assets");

/** Sections of the library, in tab order. */
export const TYPES = [
  { id: "logo", label: "Logos" },
  { id: "font", label: "Fonts" },
  { id: "color", label: "Colors" },
  { id: "title-animation", label: "Title animations" },
  { id: "transition", label: "Transitions" },
  { id: "guideline", label: "Brand guidelines" },
  { id: "sop", label: "SOPs" },
  { id: "example", label: "Examples" },
  { id: "other", label: "Other" },
];
const TYPE_IDS = new Set(TYPES.map((t) => t.id));

const now = () => new Date().toISOString();
const clean = (s, max = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const newId = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// ---------------------------------------------------------------------------
// data/resources/library.json → { items: Item[] }
//   Item { id, type, title, notes, body, tags[], pinned, url, colors[{ name, hex }], font{ family },
//          file{ name, stored, mime, size }, createdAt, updatedAt }
// Uploaded files live in data/resources/files/<id>/.

let db;
let writes = Promise.resolve();

async function load() {
  if (!db) {
    let data = {};
    try {
      data = JSON.parse(await fs.readFile(FILE, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // a hand-edit broke the JSON — never overwrite it
    }
    db = { items: Array.isArray(data.items) ? data.items : [] };
  }
  return db;
}

function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  writes = writes
    .then(async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${FILE}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(tmp, snapshot);
      await fs.rename(tmp, FILE);
    })
    .catch((err) => console.error("Saving the assets library failed:", err));
  return writes;
}

/** Best section for a dropped file when the creator didn't pick one. */
export function guessType(name, mime = "") {
  const ext = path.extname(name).toLowerCase();
  if ([".ttf", ".otf", ".woff", ".woff2"].includes(ext) || mime.startsWith("font/")) return "font";
  if ([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ai", ".eps"].includes(ext) || mime.startsWith("image/")) return "logo";
  if ([".ase", ".aco"].includes(ext)) return "color";
  if (/brand|guideline|style ?guide/i.test(name)) return "guideline";
  if (/\bsop\b|process|checklist|workflow/i.test(name)) return "sop";
  if (mime.startsWith("video/") || [".mp4", ".mov", ".webm"].includes(ext)) return "example";
  if ([".pdf", ".doc", ".docx", ".md", ".txt", ".pages", ".key", ".pptx"].includes(ext)) return "sop";
  return "other";
}

const titleFromName = (name) => clean(path.basename(name, path.extname(name)).replace(/[_-]+/g, " "), 120) || "Untitled";

function parseColors(input) {
  let list = input;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      // "Navy #0b1f3a, Coral #ff6f61" → pairs
      list = [...list.matchAll(/([^,#\n]*?)\s*(#[0-9a-f]{3,8})\b/gi)].map((m) => ({ name: m[1], hex: m[2] }));
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((c) => ({ name: clean(c?.name, 60), hex: String(c?.hex || "").trim().toLowerCase() }))
    .filter((c) => HEX.test(c.hex))
    .slice(0, 48);
}

const parseTags = (input) =>
  [...new Set((Array.isArray(input) ? input : String(input ?? "").split(","))
    .map((t) => clean(t, 40).toLowerCase())
    .filter(Boolean))].slice(0, 20);

/** Apply creator-editable fields from a request body onto an item. */
function applyFields(item, body) {
  if (body.type !== undefined) {
    if (!TYPE_IDS.has(body.type)) throw new Error("Pick a section for this asset.");
    item.type = body.type;
  }
  if (body.title !== undefined) item.title = clean(body.title, 120) || item.title || "Untitled";
  if (body.notes !== undefined) item.notes = String(body.notes ?? "").slice(0, 2000);
  if (body.body !== undefined) item.body = String(body.body ?? "").slice(0, 100_000);
  if (body.tags !== undefined) item.tags = parseTags(body.tags);
  if (body.url !== undefined) {
    const url = clean(body.url, 2000);
    if (url && !/^https?:\/\//i.test(url)) throw new Error("Links need to start with http:// or https://");
    item.url = url || null;
  }
  if (body.colors !== undefined) item.colors = parseColors(body.colors);
  if (body.fontFamily !== undefined) item.font = { family: clean(body.fontFamily, 80) };
  if (body.pinned !== undefined) item.pinned = body.pinned === true || body.pinned === "true";
  return item;
}

async function storeFile(item, upload) {
  const dir = path.join(FILES_DIR, item.id);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const safe = path.basename(upload.originalname).replace(/[^\w.\- ()]+/g, "_") || "file";
  await fs.rename(upload.path, path.join(dir, safe));
  item.file = { name: upload.originalname, stored: safe, mime: upload.mimetype, size: upload.size };
  if (item.type === "font" && !item.font?.family) item.font = { family: titleFromName(upload.originalname) };
}

function publicItem(item, base) {
  return { ...item, fileUrl: item.file ? `${base}/items/${item.id}/file` : null };
}

// ---------------------------------------------------------------------------
// Built in: the fonts and effect blocks already bundled with HBA Content Backend in assets/, shown read-only.

async function builtins() {
  const out = [];
  const read = (dir) => fs.readdir(path.join(BUILTIN_DIR, dir)).catch(() => []);
  for (const name of await read("fonts")) {
    const [family, , weight] = name.replace(/\.\w+$/, "").split("-");
    out.push({
      id: `builtin-font-${name}`,
      builtin: true,
      type: "font",
      title: `${family[0].toUpperCase()}${family.slice(1)} ${weight || ""}`.trim(),
      notes: "Bundled with HBA Content Backend for captions and titles.",
      tags: ["built-in"],
      font: { family: `${family[0].toUpperCase()}${family.slice(1)}`, weight: Number(weight) || 400 },
      file: { name, stored: name, mime: "font/woff2" },
      fileUrl: `/studio-assets/fonts/${name}`,
    });
  }
  for (const name of await read("registry")) {
    const label = name.replace(/\.\w+$/, "").replace(/-/g, " ");
    out.push({
      id: `builtin-fx-${name}`,
      builtin: true,
      type: /overlay|leak|flash/.test(name) ? "transition" : "title-animation",
      title: label[0].toUpperCase() + label.slice(1),
      notes: "HyperFrames block bundled with HBA Content Backend (assets/registry).",
      tags: ["built-in", "hyperframes"],
      file: { name, stored: name, mime: name.endsWith(".html") ? "text/html" : "text/javascript" },
      fileUrl: `/studio-assets/registry/${name}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------

export function createResources() {
  const upload = multer({ dest: path.join(DATA_DIR, "tmp"), limits: { fileSize: 1024 * 1024 * 1024 } });

  const find = async (id) => {
    await load();
    const item = db.items.find((i) => i.id === id);
    if (!item) throw Object.assign(new Error("That asset is gone."), { status: 404 });
    return item;
  };

  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      for (const f of [req.file, ...(req.files || [])]) if (f?.path) fs.rm(f.path, { force: true }).catch(() => {});
      res.status(err.status || 400).json({ error: err.message });
    }
  };

  const router = express.Router();
  router.use(express.json({ limit: "2mb" }));
  router.use("/ui", express.static(path.join(HERE, "public"), { setHeaders: (res) => res.set("Cache-Control", "no-cache") }));

  /** Everything: { types, items, builtins }. Pinned first, then newest. */
  router.get("/", handle(async (req) => {
    await load();
    const items = [...db.items]
      .sort((a, b) => (b.pinned === true) - (a.pinned === true) || b.updatedAt.localeCompare(a.updatedAt))
      .map((i) => publicItem(i, req.baseUrl));
    return { types: TYPES, items, builtins: await builtins() };
  }));

  /**
   * The brand kit other features read: colors, fonts, logos, guideline text.
   * Director, titles and edits can call GET /api/resources/brand instead of asking the creator again.
   */
  router.get("/brand", handle(async (req) => {
    await load();
    const of = (type) => db.items.filter((i) => i.type === type).map((i) => publicItem(i, req.baseUrl));
    return {
      colors: of("color").flatMap((i) => i.colors.map((c) => ({ ...c, palette: i.title }))),
      fonts: of("font").map((i) => ({ id: i.id, family: i.font?.family || i.title, url: i.fileUrl })),
      logos: of("logo").filter((i) => i.fileUrl).map((i) => ({ id: i.id, title: i.title, url: i.fileUrl, mime: i.file.mime })),
      guidelines: of("guideline").map((i) => ({ id: i.id, title: i.title, body: i.body || i.notes || "", url: i.fileUrl || i.url })),
      titleAnimations: of("title-animation").map((i) => ({ id: i.id, title: i.title, notes: i.notes, url: i.fileUrl || i.url })),
      transitions: of("transition").map((i) => ({ id: i.id, title: i.title, notes: i.notes, url: i.fileUrl || i.url })),
    };
  }));

  /** Create one asset. Multipart (optional `file`) or JSON. */
  router.post("/items", upload.single("file"), handle(async (req, res) => {
    await load();
    const body = req.body || {};
    const item = { id: newId(), type: "other", title: "", notes: "", body: "", tags: [], pinned: false, url: null, colors: [], file: null, createdAt: now(), updatedAt: now() };
    applyFields(item, { ...body, type: body.type || (req.file ? guessType(req.file.originalname, req.file.mimetype) : "other") });
    if (!item.title) item.title = req.file ? titleFromName(req.file.originalname) : "Untitled";
    if (req.file) await storeFile(item, req.file);
    if (!req.file && !item.url && !item.body && !item.notes && !item.colors.length) throw new Error("Add a file, a link, colors or some text.");
    db.items.push(item);
    await persist();
    res.status(201);
    return publicItem(item, req.baseUrl);
  }));

  /** Drop many files at once: one asset each, section guessed per file unless `type` is given. */
  router.post("/upload", upload.array("files", 100), handle(async (req, res) => {
    await load();
    if (!req.files?.length) throw new Error("No files came through.");
    const type = TYPE_IDS.has(req.body?.type) ? req.body.type : null;
    const created = [];
    for (const f of req.files) {
      const item = { id: newId(), type: type || guessType(f.originalname, f.mimetype), title: titleFromName(f.originalname), notes: "", body: "", tags: [], pinned: false, url: null, colors: [], file: null, createdAt: now(), updatedAt: now() };
      await storeFile(item, f);
      db.items.push(item);
      created.push(publicItem(item, req.baseUrl));
    }
    await persist();
    res.status(201);
    return created;
  }));

  router.patch("/items/:id", upload.single("file"), handle(async (req) => {
    const item = await find(req.params.id);
    applyFields(item, req.body || {});
    if (req.file) await storeFile(item, req.file);
    if (req.body?.removeFile === "true" && !req.file && item.file) {
      await fs.rm(path.join(FILES_DIR, item.id), { recursive: true, force: true });
      item.file = null;
    }
    item.updatedAt = now();
    await persist();
    return publicItem(item, req.baseUrl);
  }));

  router.delete("/items/:id", handle(async (req) => {
    const item = await find(req.params.id);
    db.items = db.items.filter((i) => i !== item);
    await persist();
    await fs.rm(path.join(FILES_DIR, item.id), { recursive: true, force: true });
    return { ok: true };
  }));

  router.get("/items/:id/file", async (req, res) => {
    try {
      const item = await find(req.params.id);
      if (!item.file) return res.status(404).type("text").send("This asset has no file.");
      if (req.query.download !== undefined) res.attachment(item.file.name);
      res.sendFile(path.join(FILES_DIR, item.id, item.file.stored));
    } catch (err) {
      res.status(err.status || 500).type("text").send(err.message);
    }
  });

  return { router };
}

export const { router } = createResources();
