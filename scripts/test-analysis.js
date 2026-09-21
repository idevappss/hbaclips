#!/usr/bin/env node
// Exercises lib/beats.js and lib/visual.js on generated media and benchmarks scanMoments on a long video.
// Usage: node scripts/test-analysis.js [--quick]   (--quick skips the 45-minute benchmark)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { cutGrid, detectBeats } from "../lib/beats.js";
import { FFMPEG, ROOT, run } from "../lib/tools.js";
import { pickShots, scanMoments } from "../lib/visual.js";

const { values: flags } = parseArgs({ options: { quick: { type: "boolean", default: false } } });
const MEDIA = process.env.ANALYSIS_TEST_DIR || "/private/tmp/claude-501/clip-studio-analysis-tests";
const LONG_VIDEO = path.join(ROOT, "projects/mtwe9ywb-e49f24/source.mp4");
const PROJECT_VIDEO = path.join(ROOT, "projects/mtwcwggc-eac804/source.mp4");
const media = (name) => path.join(MEDIA, name);

// ─── tiny test runner ──────────────────────────────────────────────────────────

const results = [];
async function test(name, fn) {
  const t0 = performance.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name} (${Math.round(performance.now() - t0)} ms)`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`✗ ${name}\n  ${String(err.stack || err).split("\n").slice(0, 6).join("\n  ")}`);
  }
}

// ─── synthetic media (generated once into MEDIA) ───────────────────────────────

// Decaying 50–170 Hz "kick" starting at the value X seconds after each hit.
const kick = (x) => `0.9*sin(2*PI*(50+120*exp(-(${x})*40))*(${x}))*exp(-(${x})*18)`;

// Generated in insertion order (bursts.mp4 and static10.mp4 use the stills).
const GENERATORS = {
  "stillA.png": ["-f", "lavfi", "-i", "testsrc2=s=1280x720", "-frames:v", "1"],
  "stillB.png": ["-f", "lavfi", "-i", "mandelbrot=s=1280x720", "-frames:v", "1"],
  // 128 BPM kicks from t=0: ground truth beats at k·60/128.
  "kick128.wav": ["-f", "lavfi", "-i", `aevalsrc='st(1,mod(t,60/128));${kick("ld(1)")}':s=44100:d=30`],
  // 100 BPM rock pattern + noise, first beat at 0.37 s: kick on 1&3, noise snare on 2&4, 8th-note hats.
  // (random(n) keeps its seed in variable n, so seeds use 5–7, clear of the st()/ld() slots.)
  "drums100.wav": ["-f", "lavfi", "-i", "aevalsrc='st(0,60/100);st(1,mod(t+8*ld(0)-0.37,2*ld(0)));st(2,mod(t+8*ld(0)-0.37,ld(0)/2));"
    + "0.8*sin(2*PI*(45+100*exp(-ld(1)*30))*ld(1))*exp(-ld(1)*14)+if(gte(ld(1),ld(0)),0.5*(random(5)*2-1)*exp(-(ld(1)-ld(0))*25),0)"
    + "+0.12*(random(6)*2-1)*exp(-ld(2)*60)+0.08*(random(7)*2-1)':s=44100:d=45"],
  // 3 s of silence, then 128 BPM kicks, AAC-encoded (exercises decoder delay + intro trimming).
  "silence3_kick128.m4a": ["-f", "lavfi", "-i", `aevalsrc='st(1,mod(t-3,60/128));if(gte(t,3),${kick("ld(1)")},0)':s=44100:d=25`, "-c:a", "aac", "-b:a", "160k"],
  // 42 s, 640×360: static scene A with a fast-motion burst at 8–11 s, hard cut at 20 s to scene B with a
  // burst + loud engine-like tone at 24–27 s, cut to black at 30 s, cut back to a static shot at 34 s. Grain on top.
  "bursts.mp4": [
    "-loop", "1", "-framerate", "30", "-t", "20", "-i", "stillA.png",
    "-loop", "1", "-framerate", "30", "-t", "10", "-i", "stillB.png",
    "-f", "lavfi", "-t", "4", "-i", "color=black:s=640x360:r=30",
    "-loop", "1", "-framerate", "30", "-t", "8", "-i", "stillA.png",
    "-f", "lavfi", "-t", "42", "-i", "aevalsrc='0.02*(random(0)*2-1)+if(between(t,24,27),0.6*sin(2*PI*(90+40*(t-24))*t)*(0.6+0.4*sin(2*PI*7*t)),0)':s=22050",
    "-filter_complex",
    "[0]crop=640:360:x='if(between(t,8,11),320+300*sin(t*23),320)':y='if(between(t,8,11),180+170*cos(t*19),180)',setsar=1[a];"
    + "[1]crop=640:360:x='if(between(t,4,7),320+300*sin(t*21),100)':y='if(between(t,4,7),180+170*cos(t*27),60)',setsar=1[b];"
    + "[2]setsar=1[c];[3]crop=640:360:0:0,setsar=1[d];[a][b][c][d]concat=n=4:v=1:a=0,noise=alls=6:allf=t,format=yuv420p[v]",
    "-map", "[v]", "-map", "4:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-g", "60", "-c:a", "aac", "-shortest",
  ],
  // 10 s perfectly static frame with a silent audio track.
  "static10.mp4": ["-loop", "1", "-framerate", "30", "-t", "10", "-i", "stillA.png", "-f", "lavfi", "-t", "10", "-i", "anullsrc=r=44100:cl=mono",
    "-vf", "scale=640:360,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest"],
  // Very short clips without audio.
  "short3.mp4": ["-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=3", "-c:v", "libx264", "-preset", "veryfast", "-an"],
  "short06.mp4": ["-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=0.6", "-c:v", "libx264", "-preset", "veryfast", "-an"],
};

async function ensureMedia() {
  fs.mkdirSync(MEDIA, { recursive: true });
  for (const [name, args] of Object.entries(GENERATORS)) {
    if (fs.existsSync(media(name))) continue;
    await run(FFMPEG, ["-y", "-loglevel", "error", ...args, media(name)], { cwd: MEDIA });
  }
}

// ─── assertions helpers ────────────────────────────────────────────────────────

/** Error (ms) of each time against the nearest point of the grid offset + k·period. */
const gridErrors = (times, period, offset = 0) =>
  times.map((t) => Math.abs(t - offset - Math.round((t - offset) / period) * period) * 1000);
const overlaps = (a, b) => Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0;
const approx = (a, b, tol) => Math.abs(a - b) <= tol;

function assertMomentsTile(scan) {
  const byTime = [...scan.moments].sort((a, b) => a.start - b.start);
  assert.equal(byTime[0].start, 0, "moments start at 0");
  assert.ok(approx(byTime.at(-1).end, scan.duration, 0.01), "moments reach the end");
  byTime.forEach((m, i) => {
    assert.ok(m.end > m.start, "positive length");
    assert.ok(m.end - m.start <= 3.5 + 1e-6, `moment ≤ 3.5 s (${m.start}–${m.end})`);
    if (i) assert.ok(approx(m.start, byTime[i - 1].end, 1e-3), "contiguous, non-overlapping");
    assert.ok(m.peak >= m.start && m.peak <= m.end, "peak inside");
    for (const c of scan.cuts) assert.ok(!(c > m.start + 1e-3 && c < m.end - 1e-3), `moment ${m.start}–${m.end} spans cut ${c}`);
    for (const k of ["score", "motion", "loudness"]) assert.ok(m[k] >= 0 && m[k] <= 1, `${k} in 0–1`);
  });
  for (let i = 1; i < scan.moments.length; i++) assert.ok(scan.moments[i - 1].score >= scan.moments[i].score, "sorted by score");
  assert.equal(scan.samples.length, Math.ceil(scan.duration / scan.step - 1e-6), "one sample per step");
  scan.samples.forEach((s, i) => {
    assert.ok(approx(s.t, i * scan.step, 1e-6));
    assert.ok(s.motion >= 0 && s.motion <= 1 && s.loudness >= 0 && s.loudness <= 1);
  });
}

function assertShots(shots, { targetSec, shotMin, shotMax, avoid = [] }) {
  const total = shots.reduce((a, s) => a + s.end - s.start, 0);
  assert.ok(total <= targetSec + shotMax + 1e-6, `total ${total} ≤ target + shotMax`);
  shots.forEach((s, i) => {
    assert.ok(s.end - s.start >= shotMin - 1e-3 && s.end - s.start <= shotMax + 1e-3, `shot length ${s.end - s.start}`);
    if (i) assert.ok(s.start >= shots[i - 1].end - 1e-6, "chronological and non-overlapping");
    for (const r of avoid) assert.ok(!overlaps(s, r), `shot ${s.start}–${s.end} enters avoid range`);
  });
  return total;
}

/** Any ffmpeg/ffprobe still running on `file`? */
function leftoverProcesses(file) {
  const table = execFileSync("ps", ["-Ao", "pid=,args="], { encoding: "utf8" });
  return table.split("\n").filter((l) => /ff(mpeg|probe)/.test(l) && l.includes(file) && !l.includes("ps -Ao"));
}

// ─── tests ─────────────────────────────────────────────────────────────────────

await ensureMedia();
console.log(`media: ${MEDIA}\n`);

await test("detectBeats: 128 BPM kick track (bpm ±1, beats ±30 ms)", async () => {
  const r = await detectBeats(media("kick128.wav"));
  assert.ok(approx(r.bpm, 128, 1), `bpm ${r.bpm}`);
  const errs = gridErrors(r.beats, 60 / 128);
  assert.ok(Math.max(...errs) <= 30, `max beat error ${Math.max(...errs).toFixed(1)} ms`);
  assert.ok(r.beats.length >= 62 && r.beats.length <= 65, `beat count ${r.beats.length}`);
  assert.equal(r.strengths.length, r.beats.length);
  assert.ok(r.strengths.every((s) => s >= 0 && s <= 1));
  const i0 = r.beats.indexOf(r.downbeats[0]);
  assert.ok(i0 >= 0 && i0 < 4 && r.downbeats.every((d, k) => d === r.beats[i0 + 4 * k]), "downbeats = every 4th beat");
  console.log(`  bpm ${r.bpm}, ${r.beats.length} beats, max err ${Math.max(...errs).toFixed(1)} ms, mean err ${(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(1)} ms`);
});

await test("detectBeats: 100 BPM drum pattern + noise", async () => {
  const r = await detectBeats(media("drums100.wav"));
  assert.ok(approx(r.bpm, 100, 1), `bpm ${r.bpm}`);
  const errs = gridErrors(r.beats, 0.6, 0.37);
  const onGrid = errs.filter((e) => e <= 30).length / errs.length;
  assert.ok(onGrid >= 0.95, `${(onGrid * 100).toFixed(0)}% of beats within 30 ms`);
  assert.ok(approx(r.beats.length, 75, 2), `beat count ${r.beats.length}`);
  console.log(`  bpm ${r.bpm}, ${r.beats.length} beats, max err ${Math.max(...errs).toFixed(1)} ms, downbeats from ${r.downbeats[0]}s`);
});

await test("detectBeats: AAC with 3 s silent intro", async () => {
  const r = await detectBeats(media("silence3_kick128.m4a"));
  assert.ok(approx(r.bpm, 128, 1), `bpm ${r.bpm}`);
  assert.ok(r.beats[0] >= 2.95, `first beat ${r.beats[0]} is after the intro`);
  const errs = gridErrors(r.beats, 60 / 128, 3);
  assert.ok(Math.max(...errs) <= 30, `max beat error ${Math.max(...errs).toFixed(1)} ms`);
  console.log(`  first beat ${r.beats[0]}s, max err ${Math.max(...errs).toFixed(1)} ms`);
});

await test("detectBeats: silent audio → no beats; video without audio → clear error", async () => {
  const silent = await detectBeats(media("static10.mp4"));
  assert.equal(silent.bpm, 0);
  assert.deepEqual(silent.beats, []);
  await assert.rejects(detectBeats(media("short3.mp4")), /no audio stream/);
});

await test("cutGrid: beat-aligned, ≥ minShot, within target", async () => {
  const info = await detectBeats(media("kick128.wav"));
  for (const opts of [{ targetSec: 10, minShot: 0.8 }, { targetSec: 12, minShot: 1.5, startAt: 2.2 }]) {
    const cuts = cutGrid(info, opts);
    assert.equal(cuts[0], 0);
    assert.ok(cuts.at(-1) <= opts.targetSec + 0.05 && cuts.at(-1) >= opts.targetSec - 60 / 128 * 4, `ends near target (${cuts.at(-1)})`);
    for (let i = 1; i < cuts.length; i++) {
      assert.ok(cuts[i] - cuts[i - 1] >= opts.minShot - 0.03, `shot ${i} too short`);
      const onBeat = info.beats.some((b) => approx(b - (opts.startAt || 0), cuts[i], 0.002));
      assert.ok(onBeat, `cut ${cuts[i]} is on a beat`);
    }
  }
  const fallback = cutGrid({ bpm: 0, beats: [] }, { targetSec: 5, minShot: 1 });
  assert.deepEqual(fallback, [0, 1, 2, 3, 4, 5]);
  console.log(`  e.g. ${JSON.stringify(cutGrid(info, { targetSec: 6 }))}`);
});

let bursts;
await test("scanMoments: bursts found, cuts exact, moments tile the video (full decode)", async () => {
  const progress = [];
  bursts = await scanMoments(media("bursts.mp4"), { onProgress: (f) => progress.push(f) });
  assert.equal(bursts.mode, "full");
  assert.equal(bursts.step, 0.5);
  assertMomentsTile(bursts);
  assert.equal(bursts.cuts.length, 3, `cuts ${bursts.cuts}`);
  [20, 30, 34].forEach((c, i) => assert.ok(approx(bursts.cuts[i], c, 0.2), `cut near ${c}: ${bursts.cuts[i]}`));
  assert.deepEqual(bursts.samples.filter((s) => s.cut).map((s) => s.t), [20, 30, 34]);
  const [top1, top2] = bursts.moments;
  const burstA = { start: 8, end: 11 };
  const burstB = { start: 24, end: 27 };
  assert.ok([top1, top2].some((m) => overlaps(m, burstA)) && [top1, top2].some((m) => overlaps(m, burstB)), "top 2 moments are the bursts");
  assert.ok(bursts.moments.slice(2).every((m) => m.score < top2.score / 2), "clear margin over static footage");
  const loudest = bursts.samples.reduce((m, s) => (s.loudness > m.loudness ? s : m));
  assert.ok(loudest.t >= 24 && loudest.t < 27, `loudest sample at ${loudest.t}`);
  assert.ok(progress.length > 3 && progress.every((f, i) => f >= 0 && f <= 1 && (!i || f >= progress[i - 1])) && progress.at(-1) === 1, "progress 0→1");
  console.log(`  top: ${JSON.stringify(bursts.moments.slice(0, 2))}`);
});

await test("scanMoments: keyframe-only mode still finds the bursts and the 20 s cut", async () => {
  const r = await scanMoments(media("bursts.mp4"), { mode: "keyframes" });
  assert.equal(r.mode, "keyframes");
  assertMomentsTile(r);
  assert.ok(r.moments.slice(0, 2).some((m) => overlaps(m, { start: 8, end: 11 })), "burst A in top 2");
  assert.ok(r.moments.slice(0, 2).some((m) => overlaps(m, { start: 24, end: 27 })), "burst B in top 2");
  assert.ok(r.cuts.some((c) => approx(c, 20, 0.05)), `cut at 20 (${r.cuts})`);
  assert.ok(!r.cuts.some((c) => c > 7.5 && c < 12), `no false cut at motion onset (${r.cuts})`);
  console.log(`  cuts ${JSON.stringify(r.cuts)}`);
});

await test("pickShots: target length, spread, peaks, avoid ranges", async () => {
  const opts = { targetSec: 10, shotMin: 0.8, shotMax: 3, minGapSec: 4 };
  const shots = pickShots(bursts.moments, opts);
  const total = assertShots(shots, opts);
  assert.ok(approx(total, 10, 0.8), `total ${total}`);
  assert.ok(shots.some((s) => overlaps(s, { start: 8, end: 11 })) && shots.some((s) => overlaps(s, { start: 24, end: 27 })), "both bursts used");
  for (let i = 1; i < shots.length; i++) assert.ok(shots[i].start - shots[i - 1].end >= 4 - 1e-6 || total > 10 - 3, "min gap honoured while candidates last");
  for (const s of shots) assert.ok(!bursts.cuts.some((c) => c > s.start + 1e-3 && c < s.end - 1e-3), "shot spans a cut");

  const avoid = [{ start: 7, end: 12 }];
  const avoided = pickShots(bursts.moments, { ...opts, avoid });
  assertShots(avoided, { ...opts, avoid });
  assert.ok(avoided.some((s) => overlaps(s, { start: 24, end: 27 })), "burst B still picked");

  const tiny = pickShots(bursts.moments, { targetSec: 2.5, shotMax: 3 });
  assert.ok(tiny.length === 1 && approx(tiny[0].end - tiny[0].start, 2.5, 1e-6), `trimmed to the budget: ${JSON.stringify(tiny)}`);
  assert.deepEqual(pickShots([], opts), []);
  console.log(`  ${JSON.stringify(shots)}`);
});

await test("scanMoments: static video with silent audio → low scores, no cuts", async () => {
  const r = await scanMoments(media("static10.mp4"));
  assertMomentsTile(r);
  assert.equal(r.cuts.length, 0);
  assert.ok(r.samples.every((s) => s.motion < 0.05 && s.loudness < 0.05), "flat signals");
  assert.ok(r.moments.every((m) => m.score < 0.1), `max score ${r.moments[0].score}`);
});

await test("scanMoments: very short videos without audio", async () => {
  for (const [name, n] of [["short3.mp4", 6], ["short06.mp4", 2]]) {
    const r = await scanMoments(media(name));
    assertMomentsTile(r);
    assert.equal(r.samples.length, n);
    assert.ok(r.samples.every((s) => s.loudness === 0));
    assert.ok(pickShots(r.moments, { targetSec: 20 }).length <= 1);
  }
});

await test("scanMoments: 42-second project video", async () => {
  if (!fs.existsSync(PROJECT_VIDEO)) return console.log("  (skipped: project video not found)");
  const r = await scanMoments(PROJECT_VIDEO);
  assertMomentsTile(r);
  console.log(`  mode ${r.mode}, ${r.samples.length} samples, cuts ${JSON.stringify(r.cuts)}`);
  console.log(`  samples[10..13] ${JSON.stringify(r.samples.slice(10, 14))}`);
  console.log(`  top 3 moments ${JSON.stringify(r.moments.slice(0, 3))}`);
});

await test("scanMoments: abort kills ffmpeg and rejects with AbortError", async () => {
  await assert.rejects(scanMoments(media("bursts.mp4"), { signal: AbortSignal.abort() }), { name: "AbortError" });
  const file = fs.existsSync(LONG_VIDEO) ? LONG_VIDEO : media("bursts.mp4");
  const controller = new AbortController();
  const pending = scanMoments(file, { signal: controller.signal });
  setTimeout(() => controller.abort(), fs.existsSync(LONG_VIDEO) ? 1500 : 100);
  await assert.rejects(pending, { name: "AbortError" });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(leftoverProcesses(file), [], "no ffmpeg/ffprobe left running");

  const beatsController = new AbortController();
  const beats = detectBeats(media("drums100.wav"), { signal: beatsController.signal });
  beatsController.abort();
  await assert.rejects(beats, { name: "AbortError" });
});

if (!flags.quick) {
  await test("benchmark: scanMoments on the 45-minute 1080p video (< 120 s)", async () => {
    if (!fs.existsSync(LONG_VIDEO)) return console.log("  (skipped: long video not found)");
    const t0 = performance.now();
    let lastLog = 0;
    const r = await scanMoments(LONG_VIDEO, {
      onProgress: (f) => {
        if (f - lastLog >= 0.25) console.log(`  … ${Math.round((lastLog = f) * 100)}% at ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      },
    });
    const secs = (performance.now() - t0) / 1000;
    assertMomentsTile(r);
    console.log(`  ${secs.toFixed(1)} s for ${(r.duration / 60).toFixed(1)} min (mode ${r.mode}, ${r.samples.length} samples, ${r.moments.length} moments, ${r.cuts.length} cuts)`);
    console.log(`  top 5 moments:\n    ${r.moments.slice(0, 5).map((m) => JSON.stringify(m)).join("\n    ")}`);
    console.log(`  pickShots(20 s): ${JSON.stringify(pickShots(r.moments, { targetSec: 20 }))}`);
    assert.ok(secs < 120, `took ${secs.toFixed(1)} s`);
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${flags.quick ? " (quick: long benchmark skipped)" : ""}`);
process.exitCode = failed.length ? 1 : 0;
