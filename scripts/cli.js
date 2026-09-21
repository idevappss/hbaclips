#!/usr/bin/env node
// Headless run of the whole pipeline: node scripts/cli.js <video> [--style podcast|bold|minimal] [--aspect 9:16|4:5|1:1|16:9] [--language en] [--clips 1]
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { processProject, queueRender } from "../lib/pipeline.js";
import { newProjectId, projectDir, saveProject } from "../lib/store.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    style: { type: "string", default: "podcast" },
    aspect: { type: "string", default: "9:16" },
    language: { type: "string", default: "en" },
    clips: { type: "string" },
    notes: { type: "string", default: "" },
  },
});

const input = positionals[0];
if (!input) {
  console.error("Usage: node scripts/cli.js <video> [--style bold|podcast|minimal] [--language en] [--clips N]");
  process.exit(1);
}

const id = newProjectId();
const dir = projectDir(id);
await fs.mkdir(dir, { recursive: true });
const file = `source${path.extname(input) || ".mp4"}`;
await fs.copyFile(input, path.join(dir, file));

const project = {
  id,
  name: path.basename(input),
  createdAt: new Date().toISOString(),
  status: "queued",
  source: { file },
  options: { language: values.language, notes: values.notes },
};
await saveProject(project);

const log = setInterval(() => console.log(`  ${project.status}: ${project.message || ""}`), 3000);
await processProject(project);
clearInterval(log);

if (project.status !== "ready") {
  console.error("Failed:", project.error);
  process.exit(1);
}

console.log(`\n${project.analysis.mode === "demo" ? "[demo mode] " : ""}${project.analysis.summary}\n\nTitles:`);
for (const t of project.analysis.titles) console.log(`  ${t.score}  ${t.title}  (${t.angle})`);
console.log("\nClips:");
for (const c of project.clips) console.log(`  #${c.rank} ${c.start.toFixed(1)}–${c.end.toFixed(1)}s  score ${c.score}  "${c.title}"`);

const toRender = project.clips.slice(0, values.clips ? Number(values.clips) : project.clips.length);
for (const c of toRender) queueRender(project, c.id, { design: { style: values.style, aspect: values.aspect } });

const tick = setInterval(() => {
  const line = toRender.map((c) => `${c.id}:${c.render.status}${c.render.status === "rendering" ? ` ${c.render.progress}%` : ""}`).join("  ");
  console.log(`  ${line}`);
}, 4000);
while (toRender.some((c) => ["queued", "rendering"].includes(c.render.status))) {
  await new Promise((r) => setTimeout(r, 1000));
}
clearInterval(tick);

for (const c of toRender) {
  console.log(c.render.status === "done" ? `✓ ${path.join(dir, c.render.file)}` : `✗ ${c.id}: ${c.render.error}`);
}
