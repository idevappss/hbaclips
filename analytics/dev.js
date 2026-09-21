// Dev server for the Analytics tab (port 5195). Serves Clip Studio's page from disk with the Analytics nav
// link and route patched in (the same hooks ENGINE adds for real, see analytics/README.md), mounts this
// router, and proxies everything else to the running Clip Studio server on 5173, which it never restarts.
//   node analytics/dev.js   → http://localhost:5195/#/analytics
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import dotenv from "dotenv";
import express from "express";
import { ROOT } from "../lib/tools.js";
import analytics from "./index.js";

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
const PORT = Number(process.env.ANALYTICS_PORT) || 5195;
const UPSTREAM = process.env.CLIP_STUDIO_URL || "http://localhost:5173";

export const NAV_LINK = `<a href="#/analytics" data-nav="analytics"><svg viewBox="0 0 24 24"><path d="M4 19.5V14m5 5.5V8m5 11.5v-7m5 7V5" /></svg>Analytics</a>`;
export const ROUTE = `if (pathPart.startsWith("/analytics")) {
    $$("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === "analytics"));
    const { mountAnalytics } = await import("/api/analytics/ui/analytics.js");
    await mountAnalytics(app);
    window.scrollTo(0, 0);
    return;
  }
  `;

const app = express();
app.use("/api/analytics", analytics.router);
const noCache = (res) => res.set("Cache-Control", "no-store");

app.get(["/", "/index.html"], async (_req, res) => {
  let html = await fs.readFile(path.join(ROOT, "public", "index.html"), "utf8");
  if (!html.includes('href="#/analytics"')) {
    html = html.replace(/(<a href="#\/scheduler" data-nav="scheduler"[^\n]*<\/a>)/, (m) => `${m}\n        ${NAV_LINK}`);
  }
  noCache(res).type("html").send(html);
});
app.get("/app.js", async (_req, res) => {
  let js = await fs.readFile(path.join(ROOT, "public", "app.js"), "utf8");
  if (!js.includes("/api/analytics/ui/analytics.js")) js = js.replace(/(\n  const projectMatch = pathPart\.match)/, (m) => `\n  ${ROUTE.trimEnd()}${m}`);
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
    res.status(502).type("text").send(`Clip Studio isn't reachable at ${UPSTREAM}: ${err.message}`);
  }
});

analytics.start();
app.listen(PORT, () => console.log(`\n  Analytics (dev) → http://localhost:${PORT}/#/analytics  (proxying ${UPSTREAM})\n`));
