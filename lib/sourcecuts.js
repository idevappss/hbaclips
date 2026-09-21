// Does the footage already have its own edit? Creators often upload videos that are already jump-cut or punched in
// every couple of seconds. Adding our own zooms and punch-ins on top of that makes the picture twitch, so a clip
// over busy footage plays the creator's edit as it is. Measured per clip range with ffmpeg scene detection on a
// small copy of the frames, and cached.
import fs from "node:fs/promises";
import path from "node:path";
import { projectDir } from "./store.js";
import { FFMPEG, run } from "./tools.js";
import { workingFile } from "./work.js";

const THRESHOLD = 0.3; // a real cut or a zoom jump, not someone moving
const BUSY_EVERY = 6; // one cut every 6 seconds or more often counts as already edited

const STILL_SEC = 1.2; // a picture that doesn't move for this long is a card or a freeze, not the speaker
const cacheFile = (project, start, end) => path.join(projectDir(project.id), "cuts", `v2-${Math.round(start * 10)}-${Math.round(end * 10)}.json`);

/**
 * What's already in the footage between start and end (source seconds), cached:
 * { cuts: [t], busy, stills: [{ start, end }] } — stills are text cards, black slides or frozen frames the speaker
 * talks over, which a clip shouldn't show.
 */
export async function sourceCuts(project, start, end, { signal, compute = true } = {}) {
  const file = cacheFile(project, start, end);
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    // not measured yet
  }
  if (!compute) return null;
  const lines = [];
  await run(
    FFMPEG,
    ["-hide_banner", "-nostats", "-ss", String(start), "-t", String(Math.max(0.5, end - start)), "-i", workingFile(project), "-an", "-vf", `scale=320:-2,freezedetect=n=-50dB:d=${STILL_SEC},select='gt(scene,${THRESHOLD})',metadata=print:key=lavfi.scene_score`, "-f", "null", "-"],
    { signal, onLine: (l) => lines.push(l) },
  );
  const cuts = lines.map((l) => l.match(/pts_time:([\d.]+)/)).filter(Boolean).map((m) => Math.round((start + Number(m[1])) * 100) / 100);
  const stills = [];
  let open = null;
  for (const line of lines) {
    const s = line.match(/freeze_start:\s*([\d.]+)/);
    const e = line.match(/freeze_end:\s*([\d.]+)/);
    if (s) open = start + Number(s[1]);
    else if (e && open !== null) {
      stills.push({ start: Math.round(open * 100) / 100, end: Math.round((start + Number(e[1])) * 100) / 100 });
      open = null;
    }
  }
  if (open !== null) stills.push({ start: Math.round(open * 100) / 100, end: Math.round(end * 100) / 100 });
  const result = { cuts, busy: cuts.length >= 2 && (end - start) / cuts.length <= BUSY_EVERY, stills };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(result));
  return result;
}
