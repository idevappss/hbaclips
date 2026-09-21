// The light working copy of a project's video (≤1440p, 30fps, cleaned dialogue audio) made by lib/pipeline.js.
// Readiness is the file itself — renamed into place when complete — so a long job holding an older project
// object can never save over it.
import { existsSync } from "node:fs";
import path from "node:path";
import { projectDir } from "./store.js";

export const WORK_FILE = "work.mp4";
/** Written next to the working copy once its sound uses the current cleanup chain (see AUDIO_CLEANUP_VERSION). */
export const workAudioMarker = (project, version) => path.join(projectDir(project.id), `work.audio-v${version}`);

export const hasWorkingCopy = (project) => existsSync(path.join(projectDir(project.id), WORK_FILE));

/** The working copy when it's ready (previews, analysis, proxies, tracking), else the original. */
export function workingFile(project) {
  return path.join(projectDir(project.id), hasWorkingCopy(project) ? WORK_FILE : project.source.file);
}

/** Cleaned-up dialogue audio on the source timeline, or null (the working copy always carries it when there's sound). */
export function cleanAudioFile(project) {
  return project.source?.hasAudio && hasWorkingCopy(project) ? path.join(projectDir(project.id), WORK_FILE) : null;
}
