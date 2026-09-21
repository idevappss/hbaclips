import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInstagramClient } from "../instagram.js";

function fakeFetch(responses) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body;
    requests.push({ url: new URL(url), method: init.method || "GET", headers: init.headers || {}, body });
    const next = responses.shift() ?? {};
    return new Response(JSON.stringify(next.json ?? {}), { status: next.status ?? 200 });
  };
  return { fetch, requests };
}

const account = { id: "17841400000", username: "clips", accessToken: "TOKEN" };

test("creates a resumable Reels container and uploads the file with rupload headers", async () => {
  const { fetch, requests } = fakeFetch([{ json: { id: "cont1", uri: "https://rupload.facebook.com/ig-api-upload/v25.0/cont1" } }, { json: { success: true } }]);
  const ig = createInstagramClient({ fetch });

  const container = await ig.createReelContainer(account, { caption: "Hi #fyp", shareToFeed: false, thumbOffsetMs: 1500.4 });
  assert.deepEqual(container, { id: "cont1", uri: "https://rupload.facebook.com/ig-api-upload/v25.0/cont1" });
  assert.equal(requests[0].url.href, "https://graph.instagram.com/v25.0/17841400000/media");
  assert.equal(requests[0].method, "POST");
  assert.deepEqual(requests[0].body, { media_type: "REELS", upload_type: "resumable", caption: "Hi #fyp", share_to_feed: "false", thumb_offset: "1500", access_token: "TOKEN" });

  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ig-test-")), "clip.mp4");
  await fs.writeFile(file, Buffer.alloc(1234));
  await ig.uploadVideo(account, { uri: container.uri, filePath: file });
  assert.equal(requests[1].url.href, container.uri);
  assert.deepEqual(requests[1].headers, { Authorization: "OAuth TOKEN", offset: "0", file_size: "1234" });
  assert.equal(requests[1].body.size, 1234);
});

test("maps API errors, flagging ones a retry can't fix", async () => {
  const { fetch } = fakeFetch([
    { status: 400, json: { error: { message: "Invalid OAuth access token", code: 190 } } },
    { status: 500, json: { error: { message: "An unexpected error has occurred", code: 2, is_transient: true } } },
  ]);
  const ig = createInstagramClient({ fetch });
  await assert.rejects(ig.containerStatus(account, "c1"), (err) => err.permanent === true && err.code === 190 && err.httpStatus === 400);
  await assert.rejects(ig.containerStatus(account, "c1"), (err) => err.permanent === false && /unexpected/.test(err.message));
});

test("reads profile, quota, status and insights into flat shapes", async () => {
  const { fetch, requests } = fakeFetch([
    { json: { id: "app-scoped", user_id: 17841400000, username: "clips", account_type: "BUSINESS", followers_count: 1200 } },
    { json: { data: [{ quota_usage: 4, config: { quota_total: 100, quota_duration: 86400 } }] } },
    { json: { status_code: "IN_PROGRESS", id: "c1" } },
    { json: { data: [{ name: "views", values: [{ value: 5400 }] }, { name: "reach", total_value: { value: 3100 } }] } },
  ]);
  const ig = createInstagramClient({ fetch, apiVersion: "v26.0" });

  const profile = await ig.getProfile("TOKEN");
  assert.equal(profile.id, "17841400000");
  assert.equal(profile.followersCount, 1200);
  assert.equal(requests[0].url.pathname, "/v26.0/me");

  assert.deepEqual(await ig.publishingLimit(account), { quotaUsage: 4, quotaTotal: 100 });
  assert.deepEqual(await ig.containerStatus(account, "c1"), { statusCode: "IN_PROGRESS", status: null });
  assert.deepEqual(await ig.mediaInsights(account, "m1"), { views: 5400, reach: 3100 });
  assert.match(requests[3].url.searchParams.get("metric"), /^views,reach,likes/);
});

test("builds the Instagram login URL with publishing scopes", () => {
  const ig = createInstagramClient({ appId: "123", appSecret: "s", redirectUri: "https://example.com/cb" });
  const url = new URL(ig.authorizeUrl("abc"));
  assert.equal(url.origin + url.pathname, "https://www.instagram.com/oauth/authorize");
  assert.equal(url.searchParams.get("scope"), "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights");
  assert.equal(url.searchParams.get("state"), "abc");
  assert.equal(ig.oauthConfigured, true);
});
