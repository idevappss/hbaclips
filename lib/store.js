// Projects live on disk as projects/<id>/project.json next to their media.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { PROJECTS_DIR } from "./tools.js";

const cache = new Map();
const writeChains = new Map();
const deleted = new Set();

const ID_RE = /^[a-z0-9]+-[a-f0-9]{6}$/;

export const projectDir = (id) => path.join(PROJECTS_DIR, id);

export function newProjectId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

/** Persist a project. Writes are serialized per project so renames never land out of order. */
export function saveProject(project) {
  // A render stopped by a delete may still report in; don't resurrect the folder.
  if (deleted.has(project.id)) return Promise.resolve(project);
  project.updatedAt = new Date().toISOString();
  cache.set(project.id, project);
  const file = path.join(projectDir(project.id), "project.json");
  const snapshot = JSON.stringify(project, null, 2);
  const prev = writeChains.get(project.id) || Promise.resolve();
  const next = prev.then(async () => {
    const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, snapshot);
    await fs.rename(tmp, file);
  });
  writeChains.set(project.id, next.catch(() => {}));
  const saved = next.then(() => project);
  // Many progress updates are fire-and-forget; a failed write must be logged, never crash the server.
  saved.catch((err) => console.error(`Saving project ${project.id} failed:`, err.message));
  return saved;
}

export async function loadProject(id) {
  if (!ID_RE.test(id)) return null;
  if (cache.has(id)) return cache.get(id);
  try {
    const project = JSON.parse(await fs.readFile(path.join(projectDir(id), "project.json"), "utf8"));
    cache.set(id, project);
    return project;
  } catch {
    return null;
  }
}

/** Remove a project and everything in its folder (source video, transcript, compositions, renders). */
export async function deleteProject(id) {
  if (!ID_RE.test(id)) throw new Error("Project not found");
  deleted.add(id);
  await writeChains.get(id);
  cache.delete(id);
  writeChains.delete(id);
  await fs.rm(projectDir(id), { recursive: true, force: true });
}

export async function listProjects() {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  const ids = (await fs.readdir(PROJECTS_DIR)).filter((id) => ID_RE.test(id));
  const projects = (await Promise.all(ids.map(loadProject))).filter(Boolean);
  return projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
