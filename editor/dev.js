// Dev server for the timeline editor (port 5193). Serves HBA Clips's page from disk with the editor router
// mounted and proxies everything else to the running HBA Clips server (5173), which it never restarts.
//   node editor/dev.js   → http://localhost:5193/#/projects
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import dotenv from "dotenv";
import express from "express";
import { PROJECTS_DIR, ROOT } from "../lib/tools.js";
import { createEditor } from "./index.js";

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
const PORT = Number(process.env.EDITOR_PORT) || 5193;
const UPSTREAM = process.env.CLIP_STUDIO_URL || "http://localhost:5173";

// HBA Clips writes projects to disk as they change; read them fresh here instead of through its cache.
const { router } = createEditor({
  loadProject: async (id) => JSON.parse(await fs.readFile(path.join(PROJECTS_DIR, id, "project.json"), "utf8").catch(() => "null")),
});

const app = express();
app.use("/api/editor", router);
app.use("/files", express.static(PROJECTS_DIR));
// The page and its scripts straight from disk, so edits to public/ show up without restarting HBA Clips.
app.use(express.static(path.join(ROOT, "public"), { setHeaders: (res) => res.set("Cache-Control", "no-cache") }));

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
    const decoded = upstream.headers.has("content-encoding");
    upstream.headers.forEach((value, key) => {
      if (["transfer-encoding", "connection"].includes(key) || (decoded && ["content-encoding", "content-length"].includes(key))) return;
      res.setHeader(key, value);
    });
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
    else res.end();
  } catch (err) {
    res.status(502).type("text").send(`HBA Clips isn't reachable at ${UPSTREAM}: ${err.message}`);
  }
});

app.listen(PORT, () => console.log(`\n  Timeline editor (dev) → http://localhost:${PORT}/#/projects  (proxying ${UPSTREAM})\n`));
