// Who is talking, so a two-person podcast crops to the speaker instead of the empty space between them.
// Three steps, all local: Apple Vision reads every face's lips a few times a second (lib/vision/track.swift
// --mouths); faces are kept as the same person from frame to frame (a light IoU tracker in the spirit of
// ByteTrack); and the talker is the face whose mouth moves while there's voice in the audio, held with hysteresis
// so the camera doesn't flicker between people on every "yeah".
import { spawn } from "node:child_process";
import { FFMPEG, run } from "./tools.js";
import { trackerBinary } from "./subject.js";

const STEP = 0.2; // 5 looks a second: enough to see lips move, fast (~18 frames/s on Apple silicon)
const r3 = (n) => Math.round(n * 1000) / 1000;

const iou = (a, b) => {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
};
const cx = (b) => b[0] + b[2] / 2;
const cy = (b) => b[1] + b[3] / 2;

/**
 * Keep each face as the same person across samples: match boxes to live tracks by overlap (or a close centre,
 * for fast head turns), start a track for anyone new, and drop a track after a second unseen.
 * @returns tracks [{ id, points: [{ t, box, mouth }] }]
 */
export function trackFaces(samples, { minArea = 0.0015, maxMissing = 1 } = {}) {
  const tracks = [];
  let nextId = 1;
  for (const sample of samples) {
    const faces = (sample.faces || []).filter((b) => b[2] * b[3] >= minArea && b[4] >= 0.5);
    const live = tracks.filter((tr) => sample.t - tr.points.at(-1).t <= maxMissing + 1e-6);
    const pairs = [];
    faces.forEach((box, f) =>
      live.forEach((tr) => {
        const last = tr.points.at(-1).box;
        const near = Math.hypot(cx(box) - cx(last), cy(box) - cy(last)) < Math.max(box[2], last[2]) * 1.2;
        const score = iou(box, last) + (near ? 0.3 : 0);
        if (score > 0.15) pairs.push({ f, tr, score });
      }),
    );
    // Best matches first, each face and track used once.
    const usedFaces = new Set();
    const usedTracks = new Set();
    for (const { f, tr } of pairs.sort((a, b) => b.score - a.score)) {
      if (usedFaces.has(f) || usedTracks.has(tr)) continue;
      usedFaces.add(f);
      usedTracks.add(tr);
      tr.points.push({ t: sample.t, box: faces[f], mouth: faces[f][5] ?? 0 });
    }
    faces.forEach((box, f) => {
      if (!usedFaces.has(f)) tracks.push({ id: nextId++, points: [{ t: sample.t, box, mouth: box[5] ?? 0 }] });
    });
  }
  return tracks;
}

/** Voice loudness in dB every STEP seconds over [start, end), from the original sound. */
function voiceLevels(file, start, end) {
  return new Promise((resolve, reject) => {
    const rate = 8000;
    const win = Math.round(rate * STEP);
    const child = spawn(FFMPEG, ["-v", "error", "-ss", String(start), "-t", String(end - start), "-i", file, "-vn", "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"]);
    const levels = [];
    let sum = 0;
    let count = 0;
    let carry = Buffer.alloc(0);
    child.stdout.on("data", (chunk) => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const whole = buf.length - (buf.length % 2);
      for (let i = 0; i < whole; i += 2) {
        const v = buf.readInt16LE(i) / 32768;
        sum += v * v;
        if (++count === win) {
          levels.push(10 * Math.log10(sum / win + 1e-10));
          sum = 0;
          count = 0;
        }
      }
      carry = buf.subarray(whole);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(levels) : reject(new Error(`ffmpeg couldn't read the sound (${code})`))));
  });
}

/**
 * The speaker path for a stretch of a video: [{ t, x, speaker }] every STEP (t relative to `start`, x the talker's
 * face centre, 0–1 across the frame), or null when there aren't two or more people on screen for most of it —
 * then the regular subject framing applies.
 */
export async function trackSpeakers(videoFile, soundFile, start, end, { signal } = {}) {
  const bin = await trackerBinary();
  if (!bin || end - start < 2) return null;
  const out = await run(bin, [videoFile, String(r3(start)), String(r3(end)), String(STEP), "--mouths"], { signal });
  const samples = out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).filter((s) => !s.error);
  if (samples.length < 10) return null;

  // The people in the stretch: anyone seen for at least a second and a half. Podcasts are often already cut
  // between angles, so a person can be on screen for only part of it.
  const people = trackFaces(samples).filter((tr) => tr.points.length * STEP >= 1.5);
  // Only worth it when two or more people share the frame for a real stretch; a single talking head keeps the
  // regular subject framing.
  const together = samples.filter((smp) => people.filter((p) => p.points.some((pt) => pt.t === smp.t)).length >= 2).length;
  if (people.length < 2 || together * STEP < 2) return null;

  // Speech in the audio, gated relative to this stretch's own loudness.
  const levels = await voiceLevels(soundFile, start, end).catch(() => []);
  const sorted = [...levels].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.15)] ?? -60;
  const loud = sorted[Math.floor(sorted.length * 0.9)] ?? -20;
  const speaking = (t) => {
    const v = levels[Math.round((t - start) / STEP)];
    return v === undefined ? true : v > floor + (loud - floor) * 0.4;
  };

  // How much each person's mouth is moving around each moment: the change in lip opening, averaged over ~0.8s.
  const activity = new Map();
  for (const person of people) {
    const pts = person.points;
    const moves = pts.map((p, i) => (i ? Math.abs(p.mouth - pts[i - 1].mouth) / Math.max(STEP, p.t - pts[i - 1].t) : 0));
    const byT = new Map();
    pts.forEach((p, i) => {
      const win = moves.slice(Math.max(1, i - 2), i + 3);
      byT.set(r3(p.t), { x: cx(p.box), move: win.reduce((a, b) => a + b, 0) / Math.max(1, win.length) });
    });
    activity.set(person.id, byT);
  }

  // Walk the timeline choosing the talker, switching only when someone else clearly takes over and holds it.
  const HOLD = 1.4; // seconds a speaker is kept at least
  const TAKEOVER = 0.8; // seconds another person has to clearly be the talker before we cut to them
  let current = null;
  let since = -Infinity;
  let challenger = null;
  let challengeFrom = 0;
  const lastX = new Map();
  const lastSeen = new Map();
  const path = samples.map((s) => {
    const t = r3(s.t);
    const scores = people.map((p) => {
      const a = activity.get(p.id).get(t);
      if (a) {
        lastX.set(p.id, a.x);
        lastSeen.set(p.id, s.t);
      }
      // A face Vision misses for a frame or two is still there.
      return { id: p.id, move: a ? a.move : 0, seen: Boolean(a) || s.t - (lastSeen.get(p.id) ?? -Infinity) <= 0.6 };
    });
    const visible = scores.filter((x) => x.seen).sort((a, b) => b.move - a.move);
    const top = visible[0];
    const talking = speaking(s.t) && top && top.move > 0.012;
    const cur = scores.find((x) => x.id === current);
    if (top && (current === null || !cur?.seen)) {
      // Nobody chosen yet, or the source cut to another angle and our speaker left the frame: take the most
      // active face on screen now.
      current = top.id;
      since = s.t;
      challenger = null;
    } else if (talking && top.id !== current) {
      const clearly = top.move > (cur?.move ?? 0) * 1.6 + 0.004;
      if (clearly) {
        if (challenger !== top.id) {
          challenger = top.id;
          challengeFrom = s.t;
        } else if (s.t - challengeFrom >= TAKEOVER && s.t - since >= HOLD) {
          current = top.id;
          since = s.t;
          challenger = null;
        }
      } else challenger = null;
    } else if (talking) challenger = null;
    return { t: r3(s.t - start), x: r3(lastX.get(current) ?? 0.5), speaker: current };
  });

  // No shot shorter than a second: a blip to someone else and straight back reads as a glitch. Short runs are
  // handed to the speaker before them.
  const MIN_SHOT = 1.2;
  for (let changed = true; changed; ) {
    changed = false;
    let runStart = 0;
    for (let i = 1; i <= path.length; i++) {
      if (i < path.length && path[i].speaker === path[runStart].speaker) continue;
      const len = (path[i - 1].t - path[runStart].t) + STEP;
      if (runStart > 0 && len < MIN_SHOT) {
        const prev = path[runStart - 1];
        for (let k = runStart; k < i; k++) path[k] = { ...path[k], speaker: prev.speaker, x: prev.x };
        changed = true;
        break;
      }
      runStart = i;
    }
  }
  // Mark the moments the camera moves to a different person, so framing cuts instead of panning across the room.
  return path.map((p, i) => (i && p.speaker !== path[i - 1].speaker ? { ...p, cut: true } : p));
}
