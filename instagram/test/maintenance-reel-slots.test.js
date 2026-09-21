import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMaintenance } from "../maintenance.js";
import { checkCaption, checkReel } from "../reel.js";
import { nextSlots } from "../slots.js";
import { createStore } from "../store.js";

const silent = { info() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "ig-misc-"));

test("upkeep refreshes tokens near expiry or with an estimated expiry, and skips the rest", async () => {
  const store = createStore(path.join(await tmp(), "instagram.json"));
  await store.update((s) => {
    s.connections.push(
      { id: "a", username: "near", accessToken: "old-a", tokenIssuedAt: "2026-07-20T00:00:00Z", tokenExpiresAt: "2026-09-15T00:00:00Z" },
      { id: "b", username: "fresh", accessToken: "old-b", tokenIssuedAt: "2026-09-01T00:00:00Z", tokenExpiresAt: "2026-10-31T00:00:00Z" },
      { id: "c", username: "pasted", accessToken: "old-c", tokenIssuedAt: "2026-09-09T00:00:00Z", tokenExpiresAt: "2026-11-08T00:00:00Z", tokenExpiryEstimated: true },
      { id: "d", username: "brandnew", accessToken: "old-d", tokenIssuedAt: "2026-09-11T11:00:00Z", tokenExpiresAt: "2026-11-10T00:00:00Z", tokenExpiryEstimated: true },
    );
  });
  const refreshed = [];
  const ig = { refreshToken: async (c) => (refreshed.push(c.id), { accessToken: `new-${c.id}`, expiresIn: 5184000 }) };
  const upkeep = createMaintenance({ store, ig, log: silent, now: () => new Date("2026-09-11T12:00:00Z") });
  await upkeep.tick();

  assert.deepEqual(refreshed, ["a", "c"]);
  const { connections } = await store.read();
  assert.equal(connections[0].accessToken, "new-a");
  assert.equal(connections[0].tokenExpiresAt, "2026-11-10T12:00:00.000Z");
  assert.equal(connections[2].tokenExpiryEstimated, false);
  assert.equal(connections[1].accessToken, "old-b");
});

test("upkeep records refresh failures and pulls insights for recent Reels", async () => {
  const store = createStore(path.join(await tmp(), "instagram.json"));
  await store.update((s) => {
    s.connections.push({ id: "a", username: "clips", accessToken: "tok", tokenIssuedAt: "2026-07-01T00:00:00Z", tokenExpiresAt: "2026-09-12T00:00:00Z" });
    s.jobs.push(
      { key: "p1:x", status: "published", mediaId: "m1", igUserId: "a", publishedAt: "2026-09-10T12:00:00Z" },
      { key: "p2:x", status: "published", mediaId: "m2", igUserId: "a", publishedAt: "2026-07-01T12:00:00Z" },
      { key: "p3:x", status: "failed", igUserId: "a" },
    );
  });
  const ig = {
    refreshToken: async () => Promise.reject(new Error("Session has expired")),
    mediaInsights: async (_c, id) => ({ views: id === "m1" ? 900 : 1 }),
  };
  await createMaintenance({ store, ig, log: silent, now: () => new Date("2026-09-11T12:00:00Z") }).tick();

  const { connections, jobs } = await store.read();
  assert.equal(connections[0].tokenError, "Session has expired");
  assert.deepEqual(jobs[0].insights, { views: 900 });
  assert.equal(jobs[1].insights, undefined, "older than 30 days");
});

test("checkCaption enforces length, hashtag and mention limits", () => {
  assert.deepEqual(checkCaption("Fine #one #two @someone email me at a@b.com"), []);
  assert.match(checkCaption("x".repeat(2201))[0], /2201 characters/);
  assert.deepEqual(checkCaption(Array.from({ length: 30 }, (_, i) => `#t${i}`).join(" ")), []);
  assert.match(checkCaption(Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" "))[0], /31 hashtags/);
  assert.match(checkCaption(Array.from({ length: 21 }, (_, i) => `@u${i}`).join(" "))[0], /21 @mentions/);
  assert.deepEqual(checkCaption(undefined), []);
});

test("checkReel validates the file and flags shapes Instagram may crop", async () => {
  const dir = await tmp();
  const mp4 = path.join(dir, "clip.mp4");
  await fs.writeFile(mp4, "x");
  const probeAs = (info) => async () => ({ duration: 20, width: 1080, height: 1920, fps: 30, hasAudio: true, ...info });

  const good = await checkReel({ caption: "hi", videoPath: mp4, probeVideo: probeAs({}) });
  assert.deepEqual([good.ok, good.errors, good.warnings], [true, [], []]);
  assert.equal(good.media.durationSec, 20);

  const wide = await checkReel({ caption: "", videoPath: mp4, probeVideo: probeAs({ width: 1920, height: 1080, fps: 15 }) });
  assert.equal(wide.ok, true);
  assert.equal(wide.warnings.length, 2);

  assert.deepEqual((await checkReel({ videoPath: mp4, probeVideo: probeAs({ duration: 2 }) })).errors, ["Reels must be at least 3 seconds long."]);
  assert.deepEqual((await checkReel({ videoPath: path.join(dir, "nope.mp4") })).errors, ["The video file is missing."]);
  assert.deepEqual((await checkReel({ videoPath: mp4, probeVideo: async () => Promise.reject(new Error("bad")) })).errors, ["Couldn't read the video file."]);

  const webm = path.join(dir, "clip.webm");
  await fs.writeFile(webm, "x");
  assert.deepEqual((await checkReel({ videoPath: webm })).errors, ["Instagram Reels need an MP4 or MOV file."]);
});

test("nextSlots books each suggestion before finding the next", () => {
  const times = nextSlots({ slots: ["09:00", "18:00"], timeZone: "UTC", from: new Date("2026-09-11T10:00:00Z"), count: 3, taken: [Date.parse("2026-09-11T18:00:00Z")] });
  assert.deepEqual(times.map((d) => d.toISOString()), ["2026-09-12T09:00:00.000Z", "2026-09-12T18:00:00.000Z", "2026-09-13T09:00:00.000Z"]);
  assert.deepEqual(nextSlots({ slots: [], timeZone: "UTC", count: 2 }), []);
});
