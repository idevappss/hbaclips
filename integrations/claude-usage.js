// Claude spend tracking for the "credits left" readout.
// Anthropic has no API that returns an account's remaining prepaid balance (the Usage & Cost Admin API needs an
// organization Admin key and reports spend, not balance). So the creator saves the balance shown in the Console,
// and every Claude response this server receives is priced and subtracted from it.
import fs from "node:fs/promises";
import path from "node:path";

export const BILLING_URL = "https://platform.claude.com/settings/billing";
export const PRICES_CHECKED = "2026-09-11";

// USD per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing. First match wins.
// Cache writes cost 1.25x input (5-minute TTL) or 2x input (1-hour TTL).
const PRICES = [
  [/^claude-(fable|mythos)-5-1/, { input: 10, cacheRead: 0.25, output: 50 }],
  [/^claude-(fable|mythos)-5/, { input: 10, cacheRead: 1, output: 50 }],
  [/^claude-opus-4-(0|1|2025)/, { input: 15, cacheRead: 1.5, output: 75 }],
  [/^claude-opus-/, { input: 5, cacheRead: 0.5, output: 25 }],
  [/^claude-sonnet-5/, { input: 2, cacheRead: 0.2, output: 10 }],
  [/^claude-sonnet-/, { input: 3, cacheRead: 0.3, output: 15 }],
  [/^claude-haiku-4/, { input: 1, cacheRead: 0.1, output: 5 }],
  [/haiku/, { input: 0.8, cacheRead: 0.08, output: 4 }],
];
const DEFAULT_PRICE = { input: 5, cacheRead: 0.5, output: 25 };
const WEB_SEARCH_USD = 10 / 1000;

export function priceFor(model) {
  return PRICES.find(([pattern]) => pattern.test(String(model || "")))?.[1] ?? DEFAULT_PRICE;
}

const n = (value) => (Number.isFinite(value) ? value : 0);

/** Tokens and USD for one usage block: a whole response's usage, or one entry of usage.iterations. */
function priceBlock(usage, model) {
  const price = priceFor(model);
  const write1h = n(usage.cache_creation?.ephemeral_1h_input_tokens);
  const write5m = Math.max(n(usage.cache_creation?.ephemeral_5m_input_tokens), n(usage.cache_creation_input_tokens) - write1h);
  const input = n(usage.input_tokens);
  const cacheRead = n(usage.cache_read_input_tokens);
  const output = n(usage.output_tokens);
  const usd =
    (input * price.input + write5m * price.input * 1.25 + write1h * price.input * 2 + cacheRead * price.cacheRead + output * price.output) / 1e6;
  return { inputTokens: input + write5m + write1h + cacheRead, outputTokens: output, usd };
}

/**
 * Estimated USD cost of one Messages API response ({ model, usage }).
 * A response that ran more than one sampling pass (server tools, compaction, a refusal fallback to another model)
 * lists each pass in usage.iterations with its own model, so those are priced pass by pass.
 */
export function priceResponse({ model, usage }) {
  const passes = (Array.isArray(usage?.iterations) ? usage.iterations : []).filter((pass) => Number.isFinite(pass?.input_tokens));
  const blocks = (passes.length ? passes : [usage]).map((block) => priceBlock(block, block.model || model));
  let usd = blocks.reduce((sum, block) => sum + block.usd, 0);
  if (usage.service_tier === "batch") usd *= 0.5;
  if (usage.speed === "fast") usd *= 2;
  if (usage.inference_geo === "us") usd *= 1.1;
  usd += n(usage.server_tool_use?.web_search_requests) * WEB_SEARCH_USD;
  return {
    inputTokens: blocks.reduce((sum, block) => sum + block.inputTokens, 0),
    outputTokens: blocks.reduce((sum, block) => sum + block.outputTokens, 0),
    usd,
  };
}

/** The final { id, model, usage } of a streamed (server-sent events) Messages API response. */
export function messageFromEventStream(text) {
  let message = null;
  for (const chunk of text.split(/\r?\n\r?\n/)) {
    const data = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.type === "message_start") {
      message = { id: event.message.id, model: event.message.model, usage: { ...event.message.usage } };
    } else if (event.type === "message_delta" && message && event.usage) {
      for (const [field, value] of Object.entries(event.usage)) if (value != null) message.usage[field] = value;
    }
  }
  return message;
}

// ---------------------------------------------------------------------------
// Watching the app's Claude calls

const MESSAGES_URL = /^https:\/\/api\.anthropic\.com\/v1\/messages\/?(\?.*)?$/;
const LISTENERS = Symbol.for("i-clip-you.claude-usage-listeners");

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input?.url ?? "";
}

async function observe(response, listeners) {
  const body = await response.text();
  let event;
  if (!response.ok) {
    let message = "";
    try {
      message = JSON.parse(body)?.error?.message ?? "";
    } catch {}
    event = { ok: false, status: response.status, message };
  } else {
    const streamed = (response.headers.get("content-type") ?? "").includes("text/event-stream");
    const message = streamed ? messageFromEventStream(body) : JSON.parse(body);
    if (!message?.usage) return;
    event = { ok: true, model: message.model, usage: message.usage };
  }
  await Promise.all([...listeners].map(async (listener) => listener(event)));
}

/**
 * Watches every Claude Messages API response this process receives by wrapping fetch (the Anthropic SDK uses the
 * global fetch). Responses reach their caller untouched; listeners get a copy: { ok: true, model, usage }, or
 * { ok: false, status, message } for an API error. Returns a function that removes the listener.
 */
export function trackClaudeResponses(listener, target = globalThis) {
  let listeners = target.fetch[LISTENERS];
  if (!listeners) {
    const original = target.fetch;
    listeners = new Set();
    const tracked = async (input, init) => {
      const response = await original(input, init);
      const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
      if (listeners.size && method === "POST" && MESSAGES_URL.test(requestUrl(input))) {
        observe(response.clone(), listeners).catch((err) => console.error("Claude usage tracking:", err.message));
      }
      return response;
    };
    tracked[LISTENERS] = listeners;
    target.fetch = tracked;
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Ledger: the saved balance and what Claude calls have cost since

const RECENT = 50;
const emptyState = () => ({
  balance: null, // { amountUsd, setAt }
  sinceBalance: { usd: 0, calls: 0 },
  lifetime: { usd: 0, calls: 0 },
  creditError: null, // { at, message } from Anthropic's "credit balance is too low" error
  recent: [],
});

export function createClaudeLedger({ file, now = () => new Date() }) {
  let state;
  let queue = Promise.resolve();

  async function load() {
    if (state) return state;
    try {
      state = { ...emptyState(), ...JSON.parse(await fs.readFile(file, "utf8")) };
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error(`Couldn't read ${file} (${err.message}). Starting a fresh ledger; the old file is kept as .corrupt.`);
        await fs.rename(file, `${file}.corrupt`).catch(() => {});
      }
      state = emptyState();
    }
    return state;
  }

  // Changes run one at a time, and each is saved before the next starts.
  function change(apply) {
    const run = queue.then(async () => {
      const s = await load();
      apply(s);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(`${file}.tmp`, JSON.stringify(s, null, 2));
      await fs.rename(`${file}.tmp`, file);
    });
    queue = run.catch(() => {});
    return run;
  }

  return {
    /** Adds one event from trackClaudeResponses. */
    record(event) {
      if (!event.ok) {
        if (!/credit balance/i.test(event.message)) return Promise.resolve();
        return change((s) => {
          s.creditError = { at: now().toISOString(), message: event.message };
        });
      }
      const { inputTokens, outputTokens, usd } = priceResponse(event);
      return change((s) => {
        s.sinceBalance.usd += usd;
        s.sinceBalance.calls += 1;
        s.lifetime.usd += usd;
        s.lifetime.calls += 1;
        s.creditError = null; // a call went through, so there are credits again
        s.recent = [{ at: now().toISOString(), model: event.model, inputTokens, outputTokens, usd }, ...s.recent].slice(0, RECENT);
      });
    },

    /** The balance the creator copied from the Console; spending is counted from here. */
    async setBalance(amountUsd) {
      const amount = Number(amountUsd);
      if (amountUsd === "" || amountUsd == null || !Number.isFinite(amount) || amount < 0 || amount > 1e6) {
        throw new Error("Enter your balance in dollars, like 18.50.");
      }
      await change((s) => {
        s.balance = { amountUsd: Math.round(amount * 100) / 100, setAt: now().toISOString() };
        s.sinceBalance = { usd: 0, calls: 0 };
        s.creditError = null;
      });
    },

    async summary() {
      await queue;
      const s = await load();
      const remainingUsd = s.balance ? Math.max(0, s.balance.amountUsd - s.sinceBalance.usd) : null;
      return {
        balance: s.balance,
        remainingUsd,
        low: remainingUsd != null && (remainingUsd < 2 || remainingUsd < s.balance.amountUsd * 0.2),
        spentUsd: s.sinceBalance.usd,
        calls: s.sinceBalance.calls,
        outOfCredits: Boolean(s.creditError),
        creditError: s.creditError,
        lifetime: s.lifetime,
        recent: s.recent,
      };
    },
  };
}
