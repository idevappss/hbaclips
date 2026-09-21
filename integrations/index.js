// Integrations & API keys: one page for the services this app connects to, starting with Claude (is the key
// working, and roughly how many credits are left). Instagram keeps its own connect page in instagram/.
// Wiring and endpoints: integrations/README.md
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { BILLING_URL, PRICES_CHECKED, createClaudeLedger, trackClaudeResponses } from "./claude-usage.js";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const KEY_RECHECK_MS = 10 * 60 * 1000;
const KEY_RETRY_MS = 30 * 1000;

export function createIntegrations({ dataDir, env = process.env, fetch = (...args) => globalThis.fetch(...args), now = () => new Date() }) {
  if (!dataDir) throw new Error("createIntegrations needs a dataDir.");
  const ledger = createClaudeLedger({ file: path.join(dataDir, "claude.json"), now });
  const stop = trackClaudeResponses((event) => ledger.record(event));
  let lastKeyCheck = null; // { key, at, result }

  /** Does Anthropic accept the key in .env? Listing models is free, so checking costs no credits. */
  async function claudeKey() {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) return { state: env.ANTHROPIC_AUTH_TOKEN ? "token" : "missing" };
    if (lastKeyCheck?.key === key) {
      const settled = ["valid", "rejected"].includes(lastKeyCheck.result.state);
      if (now() - lastKeyCheck.at < (settled ? KEY_RECHECK_MS : KEY_RETRY_MS)) return lastKeyCheck.result;
    }
    let state;
    try {
      const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(8000),
      });
      state = res.ok ? "valid" : res.status === 401 || res.status === 403 ? "rejected" : "unknown";
    } catch {
      state = "unreachable";
    }
    lastKeyCheck = { key, at: now(), result: { state, hint: `…${key.slice(-4)}` } };
    return lastKeyCheck.result;
  }

  const router = express.Router();
  router.get("/", (_req, res) => res.sendFile(path.join(PUBLIC, "index.html")));
  router.use("/ui", express.static(PUBLIC));
  router.get("/status", async (_req, res) => {
    res.json({ claude: { key: await claudeKey(), credits: await ledger.summary(), billingUrl: BILLING_URL, pricesChecked: PRICES_CHECKED } });
  });
  router.post("/claude/balance", express.json(), async (req, res) => {
    try {
      await ledger.setBalance(req.body?.amountUsd);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    res.json(await ledger.summary());
  });

  return { router, ledger, stop };
}
