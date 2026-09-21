import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PublishError, createPublisher, findConnection } from "../publisher.js";
import { createStore } from "../store.js";

const silent = { info() {}, warn() {}, error() {} };
const conn = { id: "17841", username: "Clips.Daily", accessToken: "tok" };
const account = { id: "acct_1", platform: "instagram", name: "Clips", handle: "@clips.daily" };
const post = { id: "post_1", caption: "Watch this #fyp" };
const KEY = "post_1:acct_1";
const START = Date.parse("2026-09-11T12:00:00Z");

async function setup({ ig = {}, statuses = ["IN_PROGRESS", "FINISHED"], jobs = [], connections = [conn], check, now } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ig-publisher-"));
  const videoPath = path.join(dir, "clip.mp4");
  await fs.writeFile(videoPath, "fake video bytes");
  const store = createStore(path.join(dir, "instagram.json"));
  await store.update((s) => {
    s.connections.push(...connections);
    s.jobs.push(...jobs);
  });

  const calls = [];
  const queue = [...statuses];
  const count = (name) => calls.filter((c) => c[0] === name).length;
  const fake = {
    publishingLimit: async () => ({ quotaUsage: 1, quotaTotal: 100 }),
    createReelContainer: async (_c, args) => {
      calls.push(["create", args]);
      return { id: `c${count("create")}`, uri: "https://rupload.test/upload" };
    },
    uploadVideo: async (_c, args) => void calls.push(["upload", args]),
    containerStatus: async (_c, id) => {
      calls.push(["status", id]);
      return { statusCode: queue.length > 1 ? queue.shift() : queue[0] };
    },
    publishContainer: async (_c, id) => {
      calls.push(["publish", id]);
      return { id: "m1" };
    },
    getMedia: async (_c, id) => ({ id, permalink: `https://www.instagram.com/reel/${id}/`, timestamp: "2026-09-11T12:00:30+0000" }),
    recentMedia: async () => [],
    ...ig,
  };

  const publisher = createPublisher({
    store,
    ig: fake,
    mediaDir: path.join(dir, "uploads"),
    log: silent,
    now: now ?? (() => new Date(START)),
    pollMs: 0,
    sleep: async () => {},
    check: check ?? (async () => ({ ok: true, errors: [], warnings: [] })),
  });
  const publish = () => publisher.publish({ post, account, videoPath });
  const job = async () => (await store.read()).jobs.find((j) => j.key === KEY);
  return { publish, calls, count, job, videoPath };
}

const leftover = (patch) => ({ key: KEY, postId: "post_1", accountId: "acct_1", igUserId: "17841", username: "Clips.Daily", caption: "Watch this #fyp", attempts: 1, startedAt: "2026-09-11T11:50:00Z", ...patch });

test("publishes a Reel: container, upload, wait for processing, publish", async () => {
  const t = await setup();
  const result = await t.publish();

  assert.deepEqual(result, { mediaId: "m1", permalink: "https://www.instagram.com/reel/m1/", publishedAt: "2026-09-11T12:00:30.000Z", username: "Clips.Daily" });
  assert.deepEqual(t.calls.map((c) => c[0]), ["create", "upload", "status", "status", "publish"]);
  assert.deepEqual(t.calls[0][1], { caption: "Watch this #fyp", shareToFeed: true, thumbOffsetMs: undefined });

  const uploaded = t.calls[1][1].filePath;
  assert.notEqual(uploaded, t.videoPath, "uploads a private snapshot, not the render itself");
  await assert.rejects(fs.stat(uploaded), "snapshot is cleaned up after publishing");

  const job = await t.job();
  assert.equal(job.status, "published");
  assert.equal(job.containerId, "c1");
  assert.equal(job.attempts, 1);
});

test("calling again after success returns the earlier result without touching Instagram", async () => {
  const t = await setup();
  const first = await t.publish();
  const callsBefore = t.calls.length;
  assert.deepEqual(await t.publish(), first);
  assert.equal(t.calls.length, callsBefore);
});

test("concurrent calls for the same target share one run", async () => {
  const t = await setup();
  const [a, b] = await Promise.all([t.publish(), t.publish()]);
  assert.deepEqual(a, b);
  assert.equal(t.count("create"), 1);
  assert.equal(t.count("publish"), 1);
});

test("findConnection links by igUserId, else by handle", () => {
  const conns = [{ id: "1", username: "Alpha" }, { id: "2", username: "beta" }];
  assert.equal(findConnection(conns, { igUserId: 2, handle: "alpha" }).id, "2");
  assert.equal(findConnection(conns, { handle: "@ALPHA" }).id, "1");
  assert.equal(findConnection(conns, { handle: "" }), null);
  assert.equal(findConnection(conns, { handle: "gamma" }), null);
  assert.equal(findConnection(conns, null), null);
});

test("an unconnected account fails with a fix-it message and no API calls", async () => {
  const t = await setup({ connections: [] });
  await assert.rejects(
    t.publish(),
    (err) => err instanceof PublishError && err.retryable === false && err.code === "not_connected" && /@clips\.daily isn't connected/.test(err.message),
  );
  assert.equal(t.calls.length, 0);
  assert.equal((await t.job()).status, "failed");
});

test("pre-flight errors stop the publish before anything is uploaded", async () => {
  const t = await setup({ check: async () => ({ ok: false, errors: ["The caption has 31 hashtags. Instagram allows 30."], warnings: [] }) });
  await assert.rejects(t.publish(), (err) => err.retryable === false && /31 hashtags/.test(err.message));
  assert.equal(t.calls.length, 0);
});

test("a transient error before publishing is retried in place", async () => {
  let failures = 1;
  const t = await setup({
    ig: {
      createReelContainer: async () => {
        if (failures-- > 0) throw Object.assign(new Error("Service temporarily unavailable."), { permanent: false });
        return { id: "c9", uri: "https://rupload.test/upload" };
      },
    },
  });
  assert.equal((await t.publish()).mediaId, "m1");
  assert.equal((await t.job()).attempts, 2);
});

test("a permanent error fails right away", async () => {
  const t = await setup({ ig: { createReelContainer: async () => Promise.reject(Object.assign(new Error("Invalid OAuth access token."), { permanent: true })) } });
  await assert.rejects(t.publish(), (err) => err.retryable === false && /Invalid OAuth/.test(err.message));
  assert.equal((await t.job()).attempts, 1);
});

test("a video Instagram can't process gets three fresh containers, then stops for good", async () => {
  const t = await setup({ statuses: ["ERROR"] });
  await assert.rejects(t.publish(), (err) => err.retryable === false && /couldn't process/.test(err.message));
  assert.equal(t.count("create"), 3);
  assert.equal(t.count("publish"), 0);
});

test("a lost media_publish response is reconciled on the next call, not re-posted", async () => {
  const t = await setup({
    jobs: [leftover({ status: "failed", step: "publishing", containerId: "c7" })],
    statuses: ["PUBLISHED"],
    ig: { recentMedia: async () => [{ id: "m77", caption: "Watch this #fyp", timestamp: "2026-09-11T11:51:00+0000" }] },
  });
  const result = await t.publish();
  assert.equal(result.mediaId, "m77");
  assert.equal(t.count("create"), 0);
  assert.equal(t.count("publish"), 0);
});

test("a container that finished processing before a restart is published, not re-uploaded", async () => {
  const t = await setup({ jobs: [leftover({ status: "publishing", step: "processing", containerId: "c7" })], statuses: ["FINISHED"] });
  assert.equal((await t.publish()).mediaId, "m1");
  assert.equal(t.count("create"), 0);
  assert.deepEqual(t.calls.find((c) => c[0] === "publish"), ["publish", "c7"]);
});

test("an upload cut off mid-way starts over with a new container", async () => {
  const t = await setup({ jobs: [leftover({ status: "publishing", step: "uploading", containerId: "c0" })], statuses: ["IN_PROGRESS", "FINISHED"] });
  assert.equal((await t.publish()).mediaId, "m1");
  assert.equal(t.count("create"), 1);
});

test("if media_publish errors, the retry re-publishes the same container", async () => {
  let fail = true;
  const t = await setup({
    statuses: ["FINISHED"],
    ig: {
      publishContainer: async (_c, id) => {
        if (fail) {
          fail = false;
          throw new Error("socket hang up");
        }
        return { id: `media-of-${id}` };
      },
    },
  });
  await assert.rejects(t.publish(), (err) => err.retryable === true && /didn't confirm/.test(err.message));
  const job = await t.job();
  assert.equal(job.containerId, "c1");
  assert.equal(job.step, "publishing");

  assert.equal((await t.publish()).mediaId, "media-of-c1");
  assert.equal(t.count("create"), 1);
});

test("slow processing gives up with a retryable error and keeps the container", async () => {
  let n = 0;
  const t = await setup({ statuses: ["IN_PROGRESS"], now: () => new Date(START + n++ * 60_000) });
  await assert.rejects(t.publish(), (err) => err.retryable === true && /still processing/.test(err.message));
  const job = await t.job();
  assert.equal(job.containerId, "c1");
  assert.equal(job.step, "processing");
});

test("a used-up daily quota is retryable and uploads nothing", async () => {
  const t = await setup({ ig: { publishingLimit: async () => ({ quotaUsage: 100, quotaTotal: 100 }) } });
  await assert.rejects(t.publish(), (err) => err.retryable === true && /limit of 100/.test(err.message));
  assert.equal(t.count("create"), 0);
});
