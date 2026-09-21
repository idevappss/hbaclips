// Dev server for the Assets tab (port 5194). Serves HBA Clips's page from disk with the Assets nav link and route
// patched in (the same hooks ENGINE adds for real, see resources/README.md), mounts this router, and proxies
// everything else to the running HBA Clips server on 5173, which it never restarts.
//   node resources/dev.js   → http://localhost:5194/#/assets
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import dotenv from "dotenv";
import express from "express";
import { ROOT } from "../lib/tools.js";
import { router } from "./index.js";

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
const PORT = Number(process.env.ASSETS_PORT) || 5194;
const UPSTREAM = process.env.CLIP_STUDIO_URL || "http://localhost:5173";

export const NAV_LINK = `<a href="#/assets" data-nav="assets"><svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="7" height="7" rx="1.5" /><rect x="13.5" y="4" width="7" height="7" rx="1.5" /><rect x="3.5" y="14" width="7" height="7" rx="1.5" /><circle cx="17" cy="17.5" r="3.5" /></svg>Assets</a>`;
export const ROUTE = `if (pathPart.startsWith("/assets")) {
    $$("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === "assets"));
    const { mountAssets } = await import("/api/resources/ui/assets.js");
    await mountAssets(app);
    window.scrollTo(0, 0);
    return;
  }
  `;

const app = express();
app.use("/api/resources", router);
const noCache = (res) => res.set("Cache-Control", "no-store");

app.get(["/", "/index.html"], async (_req, res) => {
  let html = await fs.readFile(path.join(ROOT, "public", "index.html"), "utf8");
  if (!html.includes('href="#/assets"')) html = html.replace(/(<a href="#\/sounds"[^\n]*Sounds<\/a>)/, (m) => `${m}\n        ${NAV_LINK}`);
  noCache(res).type("html").send(html);
});
app.get("/app.js", async (_req, res) => {
  let js = await fs.readFile(path.join(ROOT, "public", "app.js"), "utf8");
  if (!js.includes("/api/resources/ui/assets.js")) js = js.replace(/(\n  const projectMatch = pathPart\.match)/, (m) => `\n  ${ROUTE.trimEnd()}${m}`);
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
    res.status(502).type("text").send(`HBA Clips isn't reachable at ${UPSTREAM}: ${err.message}`);
  }
});

app.listen(PORT, () => console.log(`\n  Assets (dev) → http://localhost:${PORT}/#/assets  (proxying ${UPSTREAM})\n`));
