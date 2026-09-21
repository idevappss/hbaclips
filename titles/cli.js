#!/usr/bin/env node
// Manage the title taste library and title clips from the terminal.
//   node titles/cli.js like "Title" [--kind hook|opener|post|youtube|idea] [--note "why"]
//   node titles/cli.js avoid "Title" [--kind ...] [--note "why"]
//   node titles/cli.js remove "Title"
//   node titles/cli.js import <file> [--kind hook]     one title per line; bullets, numbers and quotes are stripped
//   node titles/cli.js list
//   node titles/cli.js guidance                        the prompt block Claude sees
//   node titles/cli.js clips                           every clip with its ids and current titles
//   node titles/cli.js clip <projectId> <clipId> [--generate] [--kind hook] [--count 10]
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { ROOT, avoid, clipTranscript, generateTitles, like, loadLibrary, remove, titleGuidance } from "./index.js";

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    kind: { type: "string" },
    note: { type: "string" },
    count: { type: "string", default: "10" },
    generate: { type: "boolean", default: false },
  },
});

const [command, ...args] = positionals;
const show = (x) => `${x.title}${x.kind ? `  [${x.kind}]` : ""}${x.note ? `  — ${x.note}` : ""}${x.editedFrom ? `  (was: ${x.editedFrom})` : ""}`;

try {
  switch (command) {
    case "like":
    case "avoid": {
      const item = await (command === "like" ? like : avoid)({ title: args.join(" "), kind: values.kind, note: values.note, source: "cli" });
      console.log(`${command === "like" ? "♥ Liked" : "✕ Avoiding"}: ${show(item)}`);
      break;
    }
    case "remove": {
      const n = await remove(args.join(" "));
      console.log(n ? "Removed." : "No title matched.");
      break;
    }
    case "import": {
      if (!args[0]) throw new Error("Usage: import <file>");
      const lines = (await fs.readFile(args[0], "utf8"))
        .split("\n")
        .map((l) => l.trim().replace(/^(?:[-*•]|\d+[.)])\s*/, "").replace(/^["“](.*)["”]$/, "$1").trim())
        .filter((l) => l && !l.startsWith("#"));
      for (const title of lines) await like({ title, kind: values.kind, source: "import" });
      console.log(`Imported ${lines.length} liked titles.`);
      break;
    }
    case "list": {
      const lib = await loadLibrary();
      console.log(`Liked (${lib.liked.length})`);
      for (const x of lib.liked) console.log(`  ♥ ${show(x)}`);
      console.log(`\nAvoid (${lib.avoid.length})`);
      for (const x of lib.avoid) console.log(`  ✕ ${show(x)}`);
      break;
    }
    case "guidance":
      console.log((await titleGuidance()) || "(empty: no favorites or style guide yet)");
      break;
    case "clips": {
      const dir = path.join(ROOT, "projects");
      for (const id of (await fs.readdir(dir).catch(() => [])).sort()) {
        const project = JSON.parse(await fs.readFile(path.join(dir, id, "project.json"), "utf8").catch(() => "null"));
        if (!project?.clips?.length) continue;
        console.log(`${id}  ${project.name}`);
        for (const c of project.clips) console.log(`  ${c.id}  "${c.title}"  ·  post: "${c.postTitle}"`);
      }
      break;
    }
    case "clip": {
      const [projectId, clipId] = args;
      const { clip, text } = await clipTranscript(projectId, clipId);
      console.log(`Hook:  ${clip.title}\nPost:  ${clip.postTitle}\n\nTranscript:\n${text}`);
      if (values.generate) {
        const titles = await generateTitles({ transcript: text, kind: values.kind || "hook", count: Number(values.count) || 10 });
        console.log(`\nNew ${values.kind || "hook"} titles:`);
        titles.forEach((t, i) => console.log(`  ${i + 1}. ${t.title}  (${t.angle}: ${t.why})`));
      }
      break;
    }
    default:
      console.error("Commands: like, avoid, remove, import, list, guidance, clips, clip. See the top of titles/cli.js.");
      process.exit(1);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
