// Dev server for the Thumbnails tab (port 5196). Serves HBA Content Backend's page from disk with the Thumbnails nav
// link and route patched in (the same hooks ENGINE adds for real, see thumbnails/README.md), mounts this
// router, and proxies everything else to the running HBA Content Backend server on 5173, which it never restarts.
//   node thumbnails/dev.js   → http://localhost:5196/#/thumbnails
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import dotenv from "dotenv";
import express from "express";
import { ROOT } from "../lib/tools.js";
import thumbnails from "./index.js";

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
const PORT = Number(process.env.THUMBNAILS_PORT) || 5196;
const UPSTREAM = process.env.CLIP_STUDIO_URL || "http://localhost:5173";

export const NAV_LINK = `<a href="#/thumbnails" data-nav="thumbnails"><svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m4 17 4.5-4.5L12 16l3-3 5 5" /></svg>Thumbnails</a>`;
export const ROUTE = `if (pathPart.startsWith("/thumbnails")) {
    $$("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === "thumbnails"));
    const { mountThumbnails } = await import("/api/thumbnails/ui/thumbnails.js");
    await mountThumbnails(app);
    window.scrollTo(0, 0);
    return;
  }
  `;

const app = express();
app.use("/api/thumbnails", thumbnails.router);
const noCache = (res) => res.set("Cache-Control", "no-store");

app.get(["/", "/index.html"], async (_req, res) => {
  let html = await fs.readFile(path.join(ROOT, "public", "index.html"), "utf8");
  if (!html.includes('href="#/thumbnails"')) {
    html = html.replace(/(<a href="#\/titles" data-nav="titles"[^\n]*<\/a>)/, (m) => `${m}\n        ${NAV_LINK}`);
  }
  noCache(res).type("html").send(html);
});
app.get("/app.js", async (_req, res) => {
  let js = await fs.readFile(path.join(ROOT, "public", "app.js"), "utf8");
  if (!js.includes("/api/thumbnails/ui/thumbnails.js")) js = js.replace(/(\n  const projectMatch = pathPart\.match)/, (m) => `\n  ${ROUTE.trimEnd()}${m}`);
  noCache(res).type("js").send(js);
});
app.use(express.static(path.join(ROOT, "public"), { setHeaders: noCache }));

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
    res.status(502).type("text").send(`HBA Content Backend isn't reachable at ${UPSTREAM}: ${err.message}`);
  }
});

thumbnails.start();
app.listen(PORT, () => console.log(`\n  Thumbnails (dev) → http://localhost:${PORT}/#/thumbnails  (proxying ${UPSTREAM})\n`));
