// Dev server for the Music Channel (port 5191). Serves HBA Content Backend's page with the drop-in added and proxies
// everything else to the running HBA Content Backend server, so the Study prompt works before ENGINE mounts it.
//   node music/dev.js   → http://localhost:5191/#/study
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import dotenv from "dotenv";
import express from "express";
import { ROOT } from "../lib/tools.js";
import { createMusicChannel } from "./index.js";

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
const PORT = Number(process.env.MUSIC_PORT) || 5191;
const UPSTREAM = process.env.CLIP_STUDIO_URL || "http://localhost:5173";

// Study data lives in the HBA Content Backend process, which persists every change right away; read it from disk here.
const { router } = createMusicChannel({
  loadStudy: async () => JSON.parse(await fs.readFile(path.join(ROOT, "data", "study.json"), "utf8")),
});

const app = express();
app.use("/api/music", router);

app.get(["/", "/index.html"], async (_req, res) => {
  const html = (await fs.readFile(path.join(ROOT, "public", "index.html"), "utf8"))
    .replace(/(<a href="#\/study"[^>]*>Study<\/a>)/, `$1\n        <a href="/api/music/channel">Music</a>`)
    .replace(/(\s*)(<script type="module" src="\/app.js"><\/script>)/, `$1<script type="module" src="/api/music/ui/music.js"></script>$1$2`);
  res.type("html").set("Cache-Control", "no-store").send(html);
});

app.use(async (req, res) => {
  try {
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    const hasBody = !["GET", "HEAD"].includes(req.method);
    const upstream = await fetch(UPSTREAM + req.originalUrl, {
      method: req.method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? "half" : undefined,
      redirect: "manual",
    });
    res.status(upstream.status);
    const decoded = upstream.headers.has("content-encoding"); // fetch already decompressed the body
    upstream.headers.forEach((value, key) => {
      if (["transfer-encoding", "connection"].includes(key) || (decoded && ["content-encoding", "content-length"].includes(key))) return;
      res.setHeader(key, value);
    });
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
    else res.end();
  } catch (err) {
    res.status(502).type("text").send(`HBA Content Backend isn't reachable at ${UPSTREAM}: ${err.message}`);
  }
});

app.listen(PORT, () => console.log(`\n  Music Channel (dev) → http://localhost:${PORT}/#/study  (proxying ${UPSTREAM})\n`));
