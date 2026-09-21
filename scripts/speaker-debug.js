#!/usr/bin/env node
// Draws what the speaker tracker sees onto a stretch of a project's video: a thin box on every face and a thick
// one on whoever it thinks is talking. For checking tracking by eye (the job OpenCV's debug overlay does).
// Usage: node scripts/speaker-debug.js <projectId> <startSec> <endSec> [out.mp4]
import fs from "node:fs/promises";
import path from "node:path";
import { projectDir } from "../lib/store.js";
import { FFMPEG, run } from "../lib/tools.js";
import { trackerBinary } from "../lib/subject.js";
import { trackFaces, trackSpeakers } from "../lib/speaker.js";
import { workingFile } from "../lib/work.js";

const [id, from, to, outArg] = process.argv.slice(2);
if (!id || !from || !to) {
  console.error("usage: node scripts/speaker-debug.js <projectId> <startSec> <endSec> [out.mp4]");
  process.exit(1);
}
const project = JSON.parse(await fs.readFile(path.join(projectDir(id), "project.json"), "utf8"));
const start = Number(from);
const end = Number(to);
const video = workingFile(project);
const out = outArg || path.join(projectDir(id), `speaker-debug-${Math.round(start)}-${Math.round(end)}.mp4`);

const bin = await trackerBinary();
const raw = await run(bin, [video, String(start), String(end), "0.2", "--mouths"]);
const samples = raw.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
const tracks = trackFaces(samples);
const speakers = (await trackSpeakers(video, path.join(projectDir(id), project.source.file), start, end)) || [];

const W = project.source.width;
const H = project.source.height;
const boxes = [];
for (const tr of tracks) {
  for (const p of tr.points) {
    const t0 = p.t - start;
    const talking = speakers.find((s) => Math.abs(s.t - t0) < 0.1)?.speaker === tr.id;
    const [x, y, w, h] = p.box;
    boxes.push(
      `drawbox=x=${Math.round(x * W)}:y=${Math.round(y * H)}:w=${Math.round(w * W)}:h=${Math.round(h * H)}:color=${talking ? "lime" : "white@0.6"}:t=${talking ? 8 : 2}:enable='between(t,${t0.toFixed(2)},${(t0 + 0.2).toFixed(2)})'`,
    );
  }
}
const filter = [`scale=${W}:${H}`, ...boxes].join(",");
await run(FFMPEG, ["-y", "-loglevel", "error", "-ss", String(start), "-t", String(end - start), "-i", video, "-vf", filter, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", out]);
console.log(`${tracks.filter((t) => t.points.length >= 8).length} people tracked, ${speakers.filter((s) => s.cut).length} speaker changes → ${out}`);
