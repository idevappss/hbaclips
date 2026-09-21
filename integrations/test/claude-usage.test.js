import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { createClaudeLedger, messageFromEventStream, priceResponse, trackClaudeResponses } from "../claude-usage.js";
import { createIntegrations } from "../index.js";

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), "integrations-"));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("prices an Opus 5 response", () => {
  // 1,000 × $5 + 500 × $25, per million tokens
  close(priceResponse({ model: "claude-opus-5", usage: { input_tokens: 1000, output_tokens: 500 } }).usd, 0.0175);
});

test("prices cache writes by TTL and cache reads per model", () => {
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 2000,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 },
    cache_read_input_tokens: 10000,
  };
  // 1,000 × $6.25 + 1,000 × $10 + 10,000 × $0.50
  close(priceResponse({ model: "claude-opus-5", usage }).usd, 0.02125);
  // Fable 5.1 cache reads are 0.025x input: 10,000 × $0.25
  close(priceResponse({ model: "claude-fable-5-1", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 10000 } }).usd, 0.0025);
});

test("prices each pass of a response that fell back to another model", () => {
  const usage = {
    input_tokens: 2000,
    output_tokens: 100,
    iterations: [
      { type: "message", model: "claude-fable-5-1", input_tokens: 1000, output_tokens: 0 },
      { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1000, output_tokens: 100 },
    ],
  };
  // 1,000 × $10 + 1,000 × $5 + 100 × $25
  const priced = priceResponse({ model: "claude-opus-4-8", usage });
  close(priced.usd, 0.0175);
  assert.equal(priced.inputTokens, 2000);
});

test("reads the final usage from a streamed response", () => {
  const events = [
    { type: "message_start", message: { id: "msg_1", model: "claude-opus-5", usage: { input_tokens: 1200, output_tokens: 1 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 300 } },
  ];
  const stream = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}`).join("\n\n") + "\n\n";
  assert.deepEqual(messageFromEventStream(stream), { id: "msg_1", model: "claude-opus-5", usage: { input_tokens: 1200, output_tokens: 300 } });
});

test("tracks Messages API responses without changing them, and notices when credits run out", async () => {
  const replies = [
    json({ id: "msg_1", model: "claude-opus-5", usage: { input_tokens: 1000, output_tokens: 500 } }),
    json({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }, 400),
  ];
  const target = { fetch: async (url) => (String(url).includes("/v1/models") ? json({ data: [] }) : replies.shift()) };
  const ledger = createClaudeLedger({ file: path.join(await tempDir(), "claude.json") });
  await ledger.setBalance(10);

  let recorded;
  const stop = trackClaudeResponses(async (event) => {
    await ledger.record(event);
    recorded();
  }, target);
  const nextRecord = () => new Promise((resolve) => (recorded = resolve));

  let wait = nextRecord();
  const response = await target.fetch("https://api.anthropic.com/v1/messages?beta=true", { method: "POST" });
  assert.equal((await response.json()).id, "msg_1"); // the caller still gets the whole body
  await wait;
  let summary = await ledger.summary();
  close(summary.remainingUsd, 10 - 0.0175);
  assert.equal(summary.calls, 1);
  assert.equal(summary.recent[0].model, "claude-opus-5");

  await target.fetch("https://api.anthropic.com/v1/models?limit=1"); // not a Messages call: ignored
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await ledger.summary()).calls, 1);

  wait = nextRecord();
  const refused = await target.fetch("https://api.anthropic.com/v1/messages", { method: "POST" });
  assert.equal(refused.status, 400);
  await wait;
  summary = await ledger.summary();
  assert.equal(summary.outOfCredits, true);
  assert.equal(summary.calls, 1);
  stop();
});

test("status, balance and page endpoints", async () => {
  const integrations = createIntegrations({
    dataDir: await tempDir(),
    env: { ANTHROPIC_API_KEY: "sk-ant-api03-test-abcd" },
    fetch: async () => json({ data: [] }),
  });
  const server = express().use("/api/integrations", integrations.router).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://localhost:${server.address().port}/api/integrations`;
  const post = (amountUsd) =>
    fetch(`${base}/claude/balance`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amountUsd }) });

  try {
    assert.equal((await post("20")).status, 200);
    assert.equal((await post("lots")).status, 400);
    assert.equal((await post("")).status, 400);

    await integrations.ledger.record({ ok: true, model: "claude-opus-5", usage: { input_tokens: 1000, output_tokens: 500 } });
    const { claude } = await (await fetch(`${base}/status`)).json();
    assert.deepEqual(claude.key, { state: "valid", hint: "…abcd" });
    close(claude.credits.remainingUsd, 20 - 0.0175);
    assert.ok(!JSON.stringify(claude).includes("sk-ant-api03-test"), "the full key never leaves the server");

    assert.match(await (await fetch(`${base}/`)).text(), /<h1>Integrations<\/h1>/);
    assert.equal((await fetch(`${base}/ui/credits.js`)).status, 200);
  } finally {
    server.close();
    integrations.stop();
  }
});
