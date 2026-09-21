#!/usr/bin/env node
// Re-time an existing project's transcript with WhisperX (projects added before alignment existed).
// Keeps the original as words.whisper.json. Restart the app afterwards so it reads the new timings.
// Usage: node scripts/align-project.js <projectId>
import fs from "node:fs/promises";
import path from "node:path";
import { projectDir } from "../lib/store.js";
import { alignWords, alignerAvailable } from "../lib/align.js";
import { workingFile } from "../lib/work.js";

const id = process.argv[2];
if (!id || !alignerAvailable()) {
  console.error(id ? "WhisperX isn't installed (~/.cache/clipstudio/whisperx)." : "usage: node scripts/align-project.js <projectId>");
  process.exit(1);
}
const dir = projectDir(id);
const project = JSON.parse(await fs.readFile(path.join(dir, "project.json"), "utf8"));
const backup = path.join(dir, "words.whisper.json");
const source = await fs.readFile(backup, "utf8").catch(() => fs.readFile(path.join(dir, "words.json"), "utf8"));
await fs.writeFile(backup, source);
const started = Date.now();
let last = -1;
const words = await alignWords(workingFile(project), JSON.parse(source), {
  language: project.options?.language,
  onProgress: (f) => {
    const pct = Math.floor(f * 10) * 10;
    if (pct !== last) console.log(`${pct}%`);
    last = pct;
  },
});
await fs.writeFile(path.join(dir, "words.json"), JSON.stringify(words));
console.log(`aligned ${words.aligned?.words ?? 0} of ${words.length} words in ${Math.round((Date.now() - started) / 1000)}s`);
