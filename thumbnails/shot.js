// Screenshots the thumbnail page in headless Chrome — the same browser HyperFrames renders with.
// One browser is kept warm between thumbnails and closed when nothing has needed it for a minute.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { WIDTH, HEIGHT } from "./compose.js";

const require = createRequire(import.meta.url);

const CANDIDATES = [
  process.env.THUMBNAIL_CHROME,
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].filter(Boolean);

async function chromePath() {
  for (const p of CANDIDATES) if (await fs.stat(p).then(() => true).catch(() => false)) return p;
  try {
    const { executablePath } = require("puppeteer-core");
    const p = executablePath?.();
    if (p) return p;
  } catch {
    // puppeteer-core can't guess on this Mac either
  }
  throw new Error("Google Chrome wasn't found. Install it, or set THUMBNAIL_CHROME to a Chrome binary.");
}

let browser = null;
let idleTimer = null;

async function getBrowser() {
  clearTimeout(idleTimer);
  if (browser?.connected) return browser;
  const puppeteer = require("puppeteer-core");
  browser = await puppeteer.launch({
    executablePath: await chromePath(),
    headless: true,
    args: ["--allow-file-access-from-files", "--hide-scrollbars", "--mute-audio", "--no-sandbox", "--disable-lcd-text"],
  });
  return browser;
}

function idle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => closeBrowser(), 60_000);
  idleTimer.unref?.();
}

export async function closeBrowser() {
  clearTimeout(idleTimer);
  const b = browser;
  browser = null;
  await b?.close().catch(() => {});
}

/**
 * Render `html` to `outFile` (.jpg or .png) at 1280×720.
 * Returns { file, width, height, size }.
 */
export async function shoot(html, outFile, { scale = 1, quality = 92 } = {}) {
  const page = await (await getBrowser()).newPage();
  const temp = `${outFile}.page.html`;
  try {
    await fs.writeFile(temp, html);
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: scale });
    await page.goto(pathToFileURL(temp).href, { waitUntil: "load", timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForSelector("html[data-ready='1']", { timeout: 5000 }).catch(() => {});
    const jpeg = /\.jpe?g$/i.test(outFile);
    await page.screenshot({ path: outFile, type: jpeg ? "jpeg" : "png", ...(jpeg ? { quality } : {}), captureBeyondViewport: false });
    const { size } = await fs.stat(outFile);
    return { file: outFile, width: WIDTH * scale, height: HEIGHT * scale, size };
  } finally {
    await page.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    idle();
  }
}

/** Where a still or a finished thumbnail lives on disk, as a URL Chrome will load. */
export const fileUrl = (p) => pathToFileURL(path.resolve(p)).href;
