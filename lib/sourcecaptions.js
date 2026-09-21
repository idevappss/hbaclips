// Some footage already has captions burned into it (a clip re-uploaded from TikTok, a video someone else edited).
// Adding ours on top gives the viewer two sets of words at once, so before a clip renders, Claude looks at a few
// frames and says whether the picture already carries captions. The answer is cached per stretch of the source.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { FFMPEG, run } from "./tools.js";
import { projectDir } from "./store.js";
import { workingFile } from "./work.js";

const MODEL = "claude-opus-5";

const Schema = z.object({
  burned_in_captions: z.boolean().describe("true only when the footage itself carries subtitle/caption text of what the speaker is saying"),
  note: z.string().describe("one short sentence on what you saw (where the text sits, or that there is none)"),
});

const cacheFile = (projectId, start, end) => path.join(projectDir(projectId), "captions-scan", `${Math.round(start)}-${Math.round(end)}.json`);
const hasKey = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

async function frameJpeg(file, t, dir) {
  const out = path.join(dir, `f${Math.round(t * 100)}.jpg`);
  await run(FFMPEG, ["-v", "error", "-y", "-ss", Math.max(0, t).toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=420:-2", "-q:v", "5", out]);
  return fs.readFile(out, { encoding: "base64" });
}

/**
 * Whether this stretch of the source already shows captions: { has, note }. Cached per project and range; falls back
 * to "no" when there's no Claude key or the look fails, so a clip still gets our captions rather than none.
 */
export async function burnedInCaptions(project, start, end, { signal } = {}) {
  const cache = cacheFile(project.id, start, end);
  try {
    return JSON.parse(await fs.readFile(cache, "utf8"));
  } catch {
    // not looked at yet
  }
  if (!hasKey()) return { has: false, note: "not checked" };
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "captions-"));
  try {
    const file = workingFile(project);
    const content = [];
    // Four frames spread through the clip: captions come and go with the talking, so one frame isn't enough.
    for (let k = 0; k < 4; k++) {
      const t = start + 0.6 + ((end - start - 1.2) * k) / 3;
      content.push({ type: "text", text: `${t.toFixed(1)}s` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: await frameJpeg(file, t, tmp) } });
    }
    content.push({
      type: "text",
      text: "These frames are from one video. Does the footage itself already have captions or subtitles burned in — the speaker's words on screen, usually a line or two that changes as they talk? Say true only for that. A logo, a handle, a headline or title card, a lower third, a name tag, a price on a slide or any other on-screen graphic is not captions.",
    });
    const response = await new Anthropic().beta.messages.parse({
      model: MODEL,
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low", format: betaZodOutputFormat(Schema) },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content }],
    });
    const out = response.parsed_output ? { has: response.parsed_output.burned_in_captions, note: response.parsed_output.note } : { has: false, note: "couldn't tell" };
    await fs.mkdir(path.dirname(cache), { recursive: true });
    await fs.writeFile(cache, JSON.stringify(out));
    return out;
  } catch (err) {
    if (signal?.aborted) throw err;
    console.error(`[${project.id}] caption check`, err.message);
    return { has: false, note: "couldn't tell" };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
