// Edits live on disk as data/edits/<id>/edit.json next to their sources, music and renders.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT } from "../lib/tools.js";

export const DATA_DIR = path.join(ROOT, "data", "edits");
export const EDITS_DIR = path.join(DATA_DIR, "edits");

const ID_RE = /^[a-z0-9]+-[a-f0-9]{6}$/;
const cache = new Map();
const chains = new Map();
const deleted = new Set();

export const isId = (id) => ID_RE.test(String(id));
export const editDir = (id) => path.join(EDITS_DIR, id);
export const newId = () => `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;

/** Persist an edit. Writes are serialized per edit and atomic. */
export function saveEdit(edit) {
  if (deleted.has(edit.id)) return Promise.resolve(edit);
  edit.updatedAt = new Date().toISOString();
  cache.set(edit.id, edit);
  const file = path.join(editDir(edit.id), "edit.json");
  const snapshot = JSON.stringify(edit, null, 2);
  const next = (chains.get(edit.id) || Promise.resolve()).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, snapshot);
    await fs.rename(tmp, file);
  });
  chains.set(edit.id, next.catch(() => {}));
  return next.then(() => edit);
}

export async function loadEdit(id) {
  if (!isId(id)) return null;
  if (cache.has(id)) return cache.get(id);
  try {
    const edit = JSON.parse(await fs.readFile(path.join(editDir(id), "edit.json"), "utf8"));
    cache.set(id, edit);
    return edit;
  } catch {
    return null;
  }
}

export async function listEdits() {
  await fs.mkdir(EDITS_DIR, { recursive: true });
  const ids = (await fs.readdir(EDITS_DIR)).filter(isId);
  const edits = (await Promise.all(ids.map(loadEdit))).filter(Boolean);
  return edits.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteEdit(id) {
  if (!isId(id)) throw new Error("Edit not found");
  deleted.add(id);
  await chains.get(id);
  cache.delete(id);
  chains.delete(id);
  await fs.rm(editDir(id), { recursive: true, force: true });
}

/** Where a source's media lives: uploaded into the edit, or referenced from a HBA Content Backend project. */
export function sourcePath(edit, source) {
  return path.isAbsolute(source.file) ? source.file : path.join(editDir(edit.id), source.file);
}
