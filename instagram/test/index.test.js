import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import express from "express";
import { createInstagramIntegration } from "../index.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** Just enough of graph.instagram.com for the account routes. */
async function fakeInstagram(url) {
  const u = new URL(url);
  if (u.pathname.endsWith("/me")) {
    if (u.searchParams.get("access_token") !== "GOOD") return json({ error: { message: "Invalid OAuth access token", code: 190 } }, 400);
    return json({ user_id: 17841, username: "clips.daily", name: "Clips Daily", account_type: "Business", followers_count: 1200 });
  }
  return json({ error: { message: `unexpected ${u.pathname}` } }, 500);
}

async function serve() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ig-routes-"));
  const projectsDir = path.join(dataDir, "projects");
  const instagram = createInstagramIntegration({
    dataDir,
    projectsDir,
    env: {},
    fetch: fakeInstagram,
    log: { info() {}, warn() {}, error() {} },
    now: () => new Date("2026-09-11T12:00:00Z"),
  });
  const app = express();
  app.use("/api/integrations/instagram", instagram.router);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/integrations/instagram`;
  const call = async (pathname, { method = "GET", body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, redirect: "manual", headers: body ? { "Content-Type": "application/json" } : undefined, body: body && JSON.stringify(body) });
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, headers: res.headers };
  };
  return { instagram, call, dataDir, close: () => new Promise((r) => server.close(r)) };
}

test("connect an account with a pasted token, configure it, and disconnect", async (t) => {
  const s = await serve();
  t.after(s.close);

  assert.deepEqual((await s.call("/status")).data.accounts, []);
  assert.equal(await s.instagram.canPublish({ id: "acct_1", platform: "instagram", handle: "Clips.Daily" }), false);

  const rejected = await s.call("/accounts", { method: "POST", body: { accessToken: "BAD" } });
  assert.equal(rejected.status, 400);
  assert.match(rejected.data.error, /didn't accept that token: Invalid OAuth/);

  const created = await s.call("/accounts", { method: "POST", body: { accessToken: "GOOD", timeZone: "America/Chicago" } });
  assert.equal(created.status, 201);
  assert.equal(created.data.id, "17841");
  assert.equal(created.data.username, "clips.daily");
  assert.equal(created.data.connected, true);
  assert.equal(created.data.accessToken, undefined, "tokens never leave the server");
  assert.deepEqual(created.data.slots, ["09:00", "13:00", "19:00"]);
  assert.equal(created.data.timeZone, "America/Chicago");
  assert.equal(await s.instagram.canPublish({ id: "acct_1", platform: "instagram", handle: "@CLIPS.DAILY" }), true);
  assert.equal(await s.instagram.canPublish({ id: "acct_2", platform: "instagram", handle: "someone.else" }), false);

  const onDisk = JSON.parse(await fs.readFile(path.join(s.dataDir, "instagram.json"), "utf8"));
  assert.equal(onDisk.connections[0].accessToken, "GOOD");

  const patched = await s.call("/accounts/17841", { method: "PATCH", body: { slots: ["18:00", "9:30"], dailyLimit: 2 } });
  assert.deepEqual([patched.status, patched.data.slots, patched.data.dailyLimit], [200, ["09:30", "18:00"], 2]);
  assert.equal((await s.call("/accounts/17841", { method: "PATCH", body: { slots: ["25:00"] } })).status, 400);
  assert.equal((await s.call("/accounts/17841", { method: "PATCH", body: { timeZone: "Mars/Base" } })).status, 400);
  assert.equal((await s.call("/accounts/nope", { method: "PATCH", body: { dailyLimit: 1 } })).status, 404);

  // 12:00Z is 07:00 in Chicago, so the next slots are 09:30 and 18:00 local.
  const times = await s.call("/suggested-times?handle=@Clips.Daily&count=2");
  assert.deepEqual(times.data.times, ["2026-09-11T14:30:00.000Z", "2026-09-11T23:00:00.000Z"]);
  assert.deepEqual(
    await s.instagram.suggestTimes({ account: { igUserId: "17841" }, taken: ["2026-09-11T14:30:00.000Z"], count: 1 }),
    ["2026-09-11T23:00:00.000Z"],
  );

  assert.deepEqual((await s.call("/accounts/17841", { method: "DELETE" })).data, { ok: true });
  assert.deepEqual((await s.call("/accounts")).data, []);
});

test("connect page, OAuth guard, pre-flight check and publish records", async (t) => {
  const s = await serve();
  t.after(s.close);

  const page = await s.call("/connect");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.data, /Connect your Instagram pages/);
  assert.equal((await s.call("/ui/connect.js")).status, 200);
  const slash = await s.call("/connect/");
  assert.equal(slash.status, 301);
  assert.equal(slash.headers.get("location"), "/api/integrations/instagram/connect");

  const oauth = await s.call("/oauth/start");
  assert.equal(oauth.status, 400);
  assert.match(oauth.data.error, /IG_APP_ID/);
  const staleCallback = await s.call("/oauth/callback?code=x&state=forged");
  assert.equal(staleCallback.status, 302);
  assert.match(staleCallback.headers.get("location"), /\/connect\?error=/);

  assert.equal((await s.call("/check", { method: "POST", body: { caption: "hi", projectId: "..", file: "../../etc/passwd" } })).status, 400);
  const missing = await s.call("/check", { method: "POST", body: { caption: "hi", projectId: "abc-123456", file: "renders/clip-1-bold.mp4" } });
  assert.deepEqual([missing.status, missing.data.ok, missing.data.errors], [200, false, ["The video file is missing."]]);

  await s.instagram.store.update((state) => {
    state.jobs.push({ key: "post_1:acct_1", postId: "post_1", accountId: "acct_1", status: "published", mediaId: "m1", mediaPath: "/tmp/x.mp4", caption: "secret draft" });
  });
  const records = await s.call("/publications?postId=post_1");
  assert.equal(records.data.length, 1);
  assert.equal(records.data[0].mediaPath, undefined);
  assert.equal(records.data[0].status, "published");
  assert.deepEqual((await s.call("/publications?postId=other")).data, []);

  const insights = await s.call("/publications/post_1/acct_1/insights", { method: "POST" });
  assert.equal(insights.status, 400);
  assert.match(insights.data.error, /isn't connected/);
});
