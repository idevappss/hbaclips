import test from "node:test";
import assert from "node:assert/strict";
import { isValidTimeZone, nextSlot, normalizeSlots, zonedTime } from "../slots.js";

const iso = (d) => d.toISOString();

test("zonedTime converts wall-clock time in a timezone to UTC, across DST", () => {
  assert.equal(iso(zonedTime(2026, 9, 11, 9, 0, "America/New_York")), "2026-09-11T13:00:00.000Z"); // EDT
  assert.equal(iso(zonedTime(2026, 11, 2, 9, 0, "America/New_York")), "2026-11-02T14:00:00.000Z"); // EST
  assert.equal(iso(zonedTime(2026, 3, 8, 9, 0, "America/New_York")), "2026-03-08T13:00:00.000Z"); // DST starts that morning
  assert.equal(iso(zonedTime(2026, 9, 11, 0, 30, "Asia/Tokyo")), "2026-09-10T15:30:00.000Z");
  assert.equal(iso(zonedTime(2026, 12, 31, 23, 0, "UTC")), "2026-12-31T23:00:00.000Z");
});

test("normalizeSlots pads, dedupes and sorts, and rejects nonsense", () => {
  assert.deepEqual(normalizeSlots(["18:30", "9:00", "09:00"]), ["09:00", "18:30"]);
  assert.throws(() => normalizeSlots(["24:00"]), /valid time/);
  assert.throws(() => normalizeSlots(["noon"]), /valid time/);
  assert.throws(() => normalizeSlots("09:00"), /list/);
});

test("isValidTimeZone", () => {
  assert.equal(isValidTimeZone("America/Los_Angeles"), true);
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
});

const base = { slots: ["09:00", "13:00", "19:00"], timeZone: "America/New_York" };

test("nextSlot picks the next slot later today", () => {
  const from = new Date("2026-09-11T15:00:00Z"); // 11:00 in New York
  assert.equal(iso(nextSlot({ ...base, from })), "2026-09-11T17:00:00.000Z"); // 13:00 local
});

test("nextSlot rolls to tomorrow after the last slot", () => {
  const from = new Date("2026-09-12T00:00:00Z"); // 20:00 on the 11th in New York
  assert.equal(iso(nextSlot({ ...base, from })), "2026-09-12T13:00:00.000Z");
});

test("nextSlot skips slots too close to already-booked posts", () => {
  const from = new Date("2026-09-11T15:00:00Z");
  const taken = [new Date("2026-09-11T17:10:00Z").getTime()];
  assert.equal(iso(nextSlot({ ...base, from, taken })), "2026-09-11T23:00:00.000Z"); // 19:00 local
});

test("nextSlot honours the daily limit in the account's own day", () => {
  const from = new Date("2026-09-11T12:00:00Z"); // 08:00 local
  const taken = [new Date("2026-09-11T20:00:00Z").getTime(), new Date("2026-09-11T21:00:00Z").getTime()];
  assert.equal(iso(nextSlot({ ...base, from, taken, dailyLimit: 2 })), "2026-09-12T13:00:00.000Z");
});

test("nextSlot returns null when there are no slots", () => {
  assert.equal(nextSlot({ slots: [], timeZone: "UTC" }), null);
});
