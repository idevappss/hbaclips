// Render plan → finished video with ffmpeg. One pass per shot (time remap, framing, zoom/shake, grade,
// effects), then one pass that joins the shots with transitions, burns in text and mixes music, dialogue and SFX.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { FFMPEG, run } from "../lib/tools.js";
import { gradeChain, TRANSITIONS } from "./looks.js";
import { buildAss } from "./text.js";

export const FPS = 30;
const SFX_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "sfx");
const f3 = (n) => (Math.round(n * 1000) / 1000).toString();

let encoderCheck;
/** "videotoolbox" (Apple hardware, much faster) when it works on this machine, otherwise "x264". */
export function detectEncoder() {
  encoderCheck ??= run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=0.2", "-c:v", "h264_videotoolbox", "-b:v", "2M", "-f", "null", "-"]).then(
    () => "videotoolbox",
    () => "x264",
  );
  return encoderCheck;
}

function videoCodec(encoder, intermediate) {
  if (encoder === "videotoolbox") return ["-c:v", "h264_videotoolbox", "-b:v", intermediate ? "40M" : "16M", "-profile:v", "high"];
  return ["-c:v", "libx264", "-preset", intermediate ? "veryfast" : "medium", "-crf", intermediate ? "14" : "18", "-pix_fmt", "yuv420p"];
}

// ---------------------------------------------------------------------------
// Speed moves as time-remap parts: `src` = offset into the source window, `out` = output seconds.

export function speedParts(mode, L, beat = 0.5) {
  switch (mode) {
    case "slow":
      return [{ src: 0, out: L, speed: 0.5 }];
    case "fast":
      return [{ src: 0, out: L, speed: 1.6 }];
    case "ramp": {
      const a = L * 0.34;
      const b = L * 0.42;
      return [{ src: 0, out: a, speed: 1 }, { src: a, out: b, speed: 0.33 }, { src: a + b * 0.33, out: L - a - b, speed: 1 }];
    }
    case "ramp-fast": {
      const a = L * 0.5;
      return [{ src: 0, out: a, speed: 0.45 }, { src: a * 0.45, out: L - a, speed: 1.9 }];
    }
    case "reverse":
      return [{ src: 0, out: L, speed: 1, reverse: true }];
    case "stutter": {
      const c = Math.max(0.1, Math.min(beat / 4, L / 5));
      return [{ src: 0, out: c, speed: 1 }, { src: 0, out: c, speed: 1 }, { src: 0, out: L - 2 * c, speed: 1 }];
    }
    case "freeze": {
      const a = Math.max(0.2, L * 0.62);
      return [{ src: 0, out: a, speed: 1 }, { src: a, out: L - a, speed: 1, freeze: true }];
    }
    default:
      return [{ src: 0, out: L, speed: 1 }];
  }
}

/** Seconds of source a set of parts reads. */
export const sourceSpan = (parts) => Math.max(...parts.map((p) => p.src + (p.freeze ? 0.1 : p.out * p.speed)));

// ---------------------------------------------------------------------------
// Per-shot filter graph

function motionFilter(shot, frames, W) {
  const fx = new Set(shot.effects);
  const zoom = [];
  const dx = [];
  const dy = [];
  const hit = Math.round(shot.pre * FPS);
  const px = W / 1080;
  const punch = (n, amp) => `if(gte(in,${n}),${amp}*if(lt(in-${n},3),(in-${n})/3,exp(-(in-${n}-3)/7)),0)`;
  if (fx.has("push")) zoom.push(`0.085*in/${frames}`);
  if (fx.has("pull")) zoom.push(`0.085*(1-in/${frames})`);
  if (fx.has("punch")) zoom.push(punch(hit, 0.075));
  if (fx.has("beat-zoom")) for (const b of shot.beats.slice(0, 16)) zoom.push(punch(Math.round(b * FPS), 0.045));
  if (fx.has("shake")) {
    zoom.push("0.03");
    dx.push(`if(gte(in,${hit}),${f3(24 * px)}*exp(-(in-${hit})/6)*sin((in-${hit})*2.3),0)`);
    dy.push(`if(gte(in,${hit}),${f3(18 * px)}*exp(-(in-${hit})/6)*cos((in-${hit})*2.9),0)`);
  }
  if (fx.has("rumble")) {
    zoom.push("0.025");
    dx.push(`${f3(7 * px)}*sin(in*1.31)+${f3(4 * px)}*sin(in*2.77)`);
    dy.push(`${f3(6 * px)}*sin(in*1.73+1)+${f3(3 * px)}*sin(in*3.1)`);
  }
  if (!zoom.length && !dx.length) return null;
  const z = `(${zoom.join("+") || "0"})`;
  const X = `(${dx.join("+") || "0"})`;
  const Y = `(${dy.join("+") || "0"})`;
  return (
    `perspective=x0='W*${z}+${X}':y0='H*${z}+${Y}':x1='W-W*${z}+${X}':y1='H*${z}+${Y}'` +
    `:x2='W*${z}+${X}':y2='H-H*${z}+${Y}':x3='W-W*${z}+${X}':y3='H-H*${z}+${Y}':interpolation=linear:eval=frame`
  );
}

function effectFilters(shot, L) {
  const fx = new Set(shot.effects);
  const p = shot.pre;
  const out = [];
  const win = (a, b) => `between(t,${f3(a)},${f3(b)})`;
  if (fx.has("mono")) out.push("hue=s=0");
  if (fx.has("echo")) out.push("tmix=frames=4:weights='1 0.75 0.5 0.3'");
  if (fx.has("blur-in")) out.push(`gblur=sigma=22:enable='lt(t,${f3(p + 0.1)})'`, `gblur=sigma=8:enable='${win(p + 0.1, p + 0.2)}'`);

  const rgb = [];
  if (fx.has("rgb")) rgb.push(win(p, p + 0.17));
  if (shot.edgeIn === "rgb") rgb.push(win(0, p + 0.05));
  if (shot.edgeOut === "rgb") rgb.push(`gte(t,${f3(L - shot.post - 0.05)})`);
  if (rgb.length) out.push(`rgbashift=rh=-16:bh=16:rv=5:bv=-5:enable='${rgb.join("+")}'`);

  const blurAxis = (dir) => (/up|down/.test(dir) ? "sigma=0.01:sigmaV=34" : "sigma=34:sigmaV=0.01");
  if (shot.edgeIn === "blur") out.push(`gblur=${blurAxis(shot.transition.type)}:enable='lt(t,${f3(p)})'`);
  if (shot.edgeOut === "blur") out.push(`gblur=${blurAxis(shot.nextTransition)}:enable='gte(t,${f3(L - shot.post)})'`);

  if (fx.has("flash")) out.push(`eq=brightness=0.38:enable='${win(p, p + 0.066)}'`, `eq=brightness=0.16:enable='${win(p + 0.067, p + 0.134)}'`);
  if (fx.has("strobe") && shot.beats.length) out.push(`eq=brightness=0.24:enable='${shot.beats.map((b) => win(b, b + 0.05)).join("+")}'`);
  if (fx.has("invert")) out.push(`negate=enable='${win(p, p + 0.067)}'`);
  if (fx.has("letterbox")) out.push("drawbox=x=0:y=0:w=iw:h=ih*0.11:color=black:t=fill", "drawbox=x=0:y=ih*0.89:w=iw:h=ih*0.11:color=black:t=fill");
  return out;
}

function framing(shot, W, H) {
  const fx = (shot.focusX ?? 50) / 100;
  if (shot.frame === "fit") {
    const bw = Math.round(W / 8) * 2;
    const bh = Math.round(H / 8) * 2;
    return `split[fa][fb];[fa]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=10,eq=brightness=-0.1:saturation=1.25,scale=${W}:${H}[bg];` +
      `[fb]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1`;
  }
  return `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${H}:(iw-ow)*${f3(fx)}:(ih-oh)*0.42,setsar=1`;
}

function segmentGraph(shot, plan) {
  const { width: W, height: H } = plan;
  const L = shot.length;
  const frames = Math.round(L * FPS);
  const parts = shot.parts;
  const lines = [];
  lines.push(parts.length > 1 ? `[0:v]split=${parts.length}${parts.map((_, k) => `[s${k}]`).join("")}` : "[0:v]null[s0]");
  parts.forEach((part, k) => {
    let c = `[s${k}]trim=start=${f3(part.src)}:duration=${f3(part.freeze ? 0.1 : part.out * part.speed + 0.05)},setpts=PTS-STARTPTS`;
    if (part.freeze) c += `,fps=${FPS},trim=end_frame=1,tpad=stop_mode=clone:stop_duration=${f3(part.out)}`;
    else {
      if (part.speed !== 1) c += `,setpts=PTS/${part.speed}`;
      if (part.reverse) c += ",reverse";
    }
    c += `,fps=${FPS},trim=duration=${f3(part.out)},format=yuv420p,setsar=1[p${k}]`;
    lines.push(c);
  });
  lines.push(parts.length > 1 ? `${parts.map((_, k) => `[p${k}]`).join("")}concat=n=${parts.length}:v=1:a=0[raw]` : "[p0]null[raw]");

  const look = plan.lut ? `lut3d=file=look.cube` : gradeChain(plan.look, plan.lookIntensity);
  const chain = [framing(shot, W, H), motionFilter(shot, frames, W), look, ...effectFilters(shot, L)].filter(Boolean);
  lines.push(`[raw]${chain.join(",")},tpad=stop_mode=clone:stop_duration=2,trim=end_frame=${frames},format=yuv420p[vout]`);

  if (shot.useAudio) {
    lines.push(`[0:a]atrim=start=0:duration=${f3(L)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${f3(L)}[aout]`);
  }
  return lines.join(";\n");
}

async function renderSegment(shot, plan, dir, encoder, signal) {
  const key = crypto
    .createHash("sha1")
    .update(JSON.stringify([shot.file, shot.in, shot.length, shot.parts, shot.effects, shot.focusX, shot.frame, shot.pre, shot.post, shot.edgeIn, shot.edgeOut, shot.useAudio, shot.beats, plan.width, plan.height, plan.look, plan.lookIntensity, plan.lut, encoder]))
    .digest("hex")
    .slice(0, 16);
  const name = `seg-${key}.mp4`;
  const out = path.join(dir, name);
  const exists = await fs.stat(out).then((s) => s.size > 0, () => false);
  if (!exists) {
    const span = sourceSpan(shot.parts);
    const args = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", f3(shot.in), "-t", f3(span + 0.6), "-i", shot.file,
      "-filter_complex", segmentGraph(shot, plan),
      "-map", "[vout]",
    ];
    if (shot.useAudio) args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "256k");
    args.push(...videoCodec(encoder, true), "-r", String(FPS), `${name}.part.mp4`);
    await run(FFMPEG, args, { cwd: dir, signal });
    await fs.rename(path.join(dir, `${name}.part.mp4`), out);
  }
  return name;
}

// ---------------------------------------------------------------------------
// Final pass

function finalGraph(plan, segNames, sfxInputs, musicInput) {
  const g = [];
  const len = plan.length;
  segNames.forEach((_, i) => g.push(`[${i}:v]fps=${FPS},settb=AVTB,format=yuv420p,setsar=1[v${i}]`));
  let cur = "v0";
  for (let i = 1; i < segNames.length; i++) {
    const shot = plan.shots[i];
    const d = shot.transition.duration;
    if (!d) g.push(`[${cur}][v${i}]concat=n=2:v=1:a=0[x${i}]`);
    else g.push(`[${cur}][v${i}]xfade=transition=${TRANSITIONS[shot.transition.type].xfade}:duration=${f3(d)}:offset=${f3(shot.slotStart - d / 2)}[x${i}]`);
    cur = `x${i}`;
  }
  g.push(`[${cur}]${plan.hasText ? "ass=text.ass," : ""}trim=duration=${f3(len)},format=yuv420p[vout]`);

  const mix = [];
  const voices = plan.shots.map((s, i) => ({ s, i })).filter(({ s }) => s.useAudio);
  voices.forEach(({ s, i }) => {
    const ms = Math.max(0, Math.round((s.slotStart - s.pre) * 1000));
    g.push(`[${i}:a]afade=t=in:d=0.03,afade=t=out:st=${f3(Math.max(0, s.length - 0.08))}:d=0.08,adelay=delays=${ms}:all=1[d${i}]`);
  });
  let voice = null;
  if (voices.length) {
    g.push(`${voices.map(({ i }) => `[d${i}]`).join("")}amix=inputs=${voices.length}:normalize=0:dropout_transition=0,apad,atrim=duration=${f3(len)}[voice]`);
    voice = "voice";
  }
  if (musicInput !== null) {
    const fade = Math.min(1.6, len * 0.12);
    g.push(`[${musicInput}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${f3(len)},asetpts=PTS-STARTPTS,afade=t=in:d=0.03,afade=t=out:st=${f3(len - fade)}:d=${f3(fade)},volume=${f3(plan.music.gain)}[mus0]`);
    if (voice) {
      g.push("[voice]asplit=2[voiceMix][voiceKey]", "[mus0][voiceKey]sidechaincompress=threshold=0.012:ratio=16:attack=8:release=450:makeup=1[mus]");
      mix.push("mus", "voiceMix");
    } else mix.push("mus0");
  } else if (voice) mix.push(voice);

  for (const [name, { input, cues }] of Object.entries(sfxInputs)) {
    const labels = cues.map((_, j) => `${name}_${j}`);
    g.push(`[${input}:a]aresample=48000,aformat=channel_layouts=stereo,${cues.length > 1 ? `asplit=${cues.length}` : "anull"}${labels.map((l) => `[${l}]`).join("")}`);
    cues.forEach((cue, j) => {
      const label = `${name}_${j}c`;
      const dur = cue.duration;
      g.push(
        `[${labels[j]}]atrim=start=${f3(cue.offset || 0)}:duration=${f3(dur)},asetpts=PTS-STARTPTS,afade=t=out:st=${f3(Math.max(0, dur - 0.15))}:d=0.15,volume=${f3(cue.gain)},adelay=delays=${Math.max(0, Math.round(cue.at * 1000))}:all=1[${label}]`,
      );
      mix.push(label);
    });
  }

  // The explicit stereo/fltp at the end lets the AAC encoder negotiate a layout after loudnorm.
  if (!mix.length) g.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${f3(len)},aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`);
  else g.push(`${mix.map((m) => `[${m}]`).join("")}amix=inputs=${mix.length}:normalize=0:duration=longest:dropout_transition=0,aformat=channel_layouts=stereo,atrim=duration=${f3(len)},alimiter=limit=0.89:level=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]`);
  return g.join(";\n");
}

/**
 * Render a normalized plan (see timeline.js) into workDir/outName.
 * onProgress(fraction 0–1, message)
 */
export async function renderPlan(plan, workDir, { outName = "edit.mp4", onProgress, signal, concurrency = 3 } = {}) {
  const segDir = path.join(workDir, "segments");
  const thumbDir = path.join(workDir, "thumbs");
  await fs.mkdir(segDir, { recursive: true });
  await fs.mkdir(thumbDir, { recursive: true });
  const encoder = await detectEncoder();
  const N = plan.shots.length;

  // 1. Shots, a few at a time.
  const segNames = new Array(N);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < N) {
      const i = next++;
      signal?.throwIfAborted();
      segNames[i] = await renderSegment(plan.shots[i], plan, segDir, encoder, signal);
      await run(FFMPEG, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f3(Math.min(plan.shots[i].length * 0.5, plan.shots[i].pre + 0.2)), "-i", path.join(segDir, segNames[i]),
        "-frames:v", "1", "-vf", "scale=216:-2", "-q:v", "4", path.join(thumbDir, `shot-${i + 1}.jpg`),
      ], { signal }).catch(() => {});
      done++;
      onProgress?.(0.02 + 0.8 * (done / N), `Cutting shot ${done} of ${N}…`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, N) }, worker));

  // 2. Text overlays.
  plan.hasText = Boolean(plan.texts.length || plan.captions.length);
  if (plan.hasText) {
    await fs.writeFile(path.join(workDir, "text.ass"), buildAss({ width: plan.width, height: plan.height, textStyle: plan.textStyle, accent: plan.accent, texts: plan.texts, captions: plan.captions }));
  }

  // 3. Join, text, audio.
  onProgress?.(0.83, "Adding transitions, text and audio…");
  const inputs = [];
  segNames.forEach((n) => inputs.push("-i", `segments/${n}`));
  let index = N;
  let musicInput = null;
  if (plan.music) {
    inputs.push("-ss", f3(plan.music.start), "-i", plan.music.file);
    musicInput = index++;
  }
  const sfxInputs = {};
  for (const cue of plan.sfx) {
    const safe = cue.name.replace(/[^a-z0-9]/gi, "");
    if (!sfxInputs[safe]) {
      inputs.push("-i", path.join(SFX_DIR, `${cue.name}.mp3`));
      sfxInputs[safe] = { input: index++, cues: [] };
    }
    sfxInputs[safe].cues.push(cue);
  }

  const partial = `${outName}.part.mp4`;
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y", "-nostats", "-progress", "pipe:1",
    ...inputs,
    "-filter_complex", finalGraph(plan, segNames, sfxInputs, musicInput),
    "-map", "[vout]", "-map", "[aout]",
    ...videoCodec(encoder, false), "-r", String(FPS),
    "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
    "-movflags", "+faststart",
    partial,
  ], {
    cwd: workDir,
    signal,
    onLine: (line) => {
      const m = line.match(/^out_time_us=(\d+)/);
      if (m) onProgress?.(0.83 + 0.16 * Math.min(1, Number(m[1]) / 1e6 / plan.length), "Adding transitions, text and audio…");
    },
  });
  await fs.rename(path.join(workDir, partial), path.join(workDir, outName));
  onProgress?.(1, "Done");
  return { file: outName, encoder, segments: segNames };
}

/** Remove cached shot renders no plan in `keep` uses. */
export async function pruneSegments(workDir, keepNames) {
  const segDir = path.join(workDir, "segments");
  const names = await fs.readdir(segDir).catch(() => []);
  await Promise.all(names.filter((n) => !keepNames.has(n)).map((n) => fs.rm(path.join(segDir, n), { force: true })));
}
