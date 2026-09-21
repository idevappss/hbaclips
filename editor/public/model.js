// Pure timeline operations on an editor document (see editor/README.md). Every function mutates the document it's
// given — the store hands them a copy — and keeps clips on a track from overlapping.
import { clamp, r3 } from "./ui.js";

export const FPS = 30;
export const FRAME = 1 / FPS;
export const MIN_DUR = 0.1;

export const end = (c) => c.start + c.duration;
export const isMedia = (c) => c.type === "video" || c.type === "audio";
export const snapFrame = (t) => Math.round(t * FPS) / FPS;

export const allClips = (doc) => doc.tracks.flatMap((track) => track.clips.map((clip) => ({ track, clip })));

export function locate(doc, id) {
  for (const track of doc.tracks) {
    const index = track.clips.findIndex((c) => c.id === id);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return null;
}

/** How long the edit plays: to the end of the last picture (or of anything, when there's no picture). */
export function duration(doc) {
  const ends = (tracks) => tracks.flatMap((t) => t.clips.map(end));
  const picture = ends(doc.tracks.filter((t) => t.kind === "video"));
  return r3(Math.max(0.5, ...(picture.length ? picture : ends(doc.tracks))));
}

/** The clip plus everything linked to it (a video piece and its own audio move, trim and split together). */
export function group(doc, id) {
  const hit = locate(doc, id);
  if (!hit) return [];
  const members = hit.clip.link ? allClips(doc).filter(({ clip }) => clip.link === hit.clip.link) : [hit];
  return members.filter(({ track }) => !track.locked);
}

/** Expand a selection to whole link groups, without repeats. */
export function expand(doc, ids) {
  const out = new Map();
  for (const id of ids) for (const m of group(doc, id)) out.set(m.clip.id, m);
  return [...out.values()];
}

export function newId(doc, prefix) {
  const taken = new Set(allClips(doc).map(({ clip }) => clip.id).concat(doc.tracks.flatMap((t) => t.clips.map((c) => c.link).filter(Boolean))));
  let n = taken.size + 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

const overlaps = (a0, a1, b0, b1) => a0 < b1 - 1e-4 && a1 > b0 + 1e-4;

/**
 * The shift nearest to `wanted` that puts every member somewhere free on its own track: where asked, or butted up
 * against a neighbor. Null when nowhere works.
 */
function freeShift(doc, members, wanted) {
  const moving = new Set(members.map((m) => m.clip.id));
  const others = (track) => track.clips.filter((c) => !moving.has(c.id));
  const candidates = [wanted];
  for (const { track, clip } of members) {
    candidates.push(-clip.start);
    for (const o of others(track)) candidates.push(end(o) - clip.start, o.start - end(clip));
  }
  const fits = (d) => members.every(({ track, clip }) => clip.start + d >= -1e-4 && others(track).every((o) => !overlaps(clip.start + d, end(clip) + d, o.start, end(o))));
  const valid = candidates.filter(fits).sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted));
  return valid.length ? valid[0] : null;
}

/** Move a clip (and its links) so it starts at `start`, landing on the nearest free spot. */
export function move(doc, id, start) {
  const members = group(doc, id);
  const lead = members.find((m) => m.clip.id === id);
  if (!lead) return false;
  const shift = freeShift(doc, members, Math.max(-lead.clip.start, start - lead.clip.start));
  if (shift === null) return false;
  for (const { clip } of members) clip.start = r3(Math.max(0, clip.start + shift));
  return true;
}

/** The nearest end of a clip before `clip` on the track, and the nearest start after it. */
function neighbors(track, clip) {
  let prev = 0;
  let next = Infinity;
  for (const o of track.clips) {
    if (o === clip || o.id === clip.id) continue;
    if (end(o) <= clip.start + 1e-4) prev = Math.max(prev, end(o));
    else if (o.start >= end(clip) - 1e-4) next = Math.min(next, o.start);
  }
  return { prev, next };
}

const loops = (clip) => clip.type === "audio" && clip.loop;

/** Move the clip's in point to `start` (source media follows), within its neighbors and its media. */
export function trimStart(doc, id, start) {
  const members = group(doc, id);
  const lead = members.find((m) => m.clip.id === id);
  if (!lead) return false;
  let lo = -Infinity;
  let hi = Infinity;
  for (const { track, clip } of members) {
    const { prev } = neighbors(track, clip);
    lo = Math.max(lo, prev - clip.start, -clip.start);
    if (isMedia(clip) && !loops(clip)) lo = Math.max(lo, -clip.sourceStart / (clip.speed || 1));
    hi = Math.min(hi, clip.duration - MIN_DUR);
  }
  const delta = clamp(start - lead.clip.start, lo, hi);
  for (const { clip } of members) {
    clip.start = r3(clip.start + delta);
    clip.duration = r3(clip.duration - delta);
    if (isMedia(clip)) clip.sourceStart = r3(Math.max(0, clip.sourceStart + delta * (clip.speed || 1)));
    // A recording on the overlay track keeps playing the same moment where it was.
    if (clip.type === "overlay" && clip.sourceStart != null) clip.sourceStart = r3(Math.max(0, clip.sourceStart + delta));
    // Captions keep their words where they were said; words trimmed off stay in the clip, out of view.
    if (clip.words) for (const w of clip.words) Object.assign(w, { s: r3(w.s - delta), e: r3(w.e - delta) });
  }
  return true;
}

/** Move the clip's out point to `to`, within its neighbors and the source media's length. */
export function trimEnd(doc, id, to, { sourceDuration = Infinity } = {}) {
  const members = group(doc, id);
  const lead = members.find((m) => m.clip.id === id);
  if (!lead) return false;
  let lo = -Infinity;
  let hi = Infinity;
  for (const { track, clip } of members) {
    const { next } = neighbors(track, clip);
    hi = Math.min(hi, next - end(clip));
    if (isMedia(clip) && !loops(clip) && clip.type === "video") hi = Math.min(hi, (sourceDuration - clip.sourceEnd) / (clip.speed || 1));
    if (isMedia(clip) && !loops(clip) && clip.type === "audio" && !clip.sound) hi = Math.min(hi, (sourceDuration - clip.sourceEnd) / (clip.speed || 1));
    lo = Math.max(lo, MIN_DUR - clip.duration);
  }
  const delta = clamp(to - end(lead.clip), lo, hi);
  for (const { clip } of members) {
    clip.duration = r3(clip.duration + delta);
    if (isMedia(clip) && !loops(clip)) clip.sourceEnd = r3(clip.sourceEnd + delta * (clip.speed || 1));
  }
  return true;
}

/** Cut a clip (and its links) in two at `t`. Returns the ids of the right-hand pieces. */
export function split(doc, id, t) {
  const members = group(doc, id);
  if (!members.length || !members.every(({ clip }) => t > clip.start + MIN_DUR / 2 && t < end(clip) - MIN_DUR / 2)) return [];
  const link = members[0].clip.link ? newId(doc, "l") : null;
  const made = [];
  for (const { track, clip } of members) {
    const offset = r3(t - clip.start);
    const right = structuredClone(clip);
    right.id = newId(doc, clip.id.replace(/\d+$/, "").slice(0, 6) || "x");
    right.start = r3(t);
    right.duration = r3(end(clip) - t);
    clip.duration = offset;
    if (link) right.link = link;
    if (isMedia(clip)) {
      right.sourceStart = r3(clip.sourceStart + offset * (clip.speed || 1));
      if (!loops(clip)) clip.sourceEnd = right.sourceStart;
    }
    if (clip.words) {
      clip.words = clip.words.filter((w) => w.s < offset);
      right.words = right.words.filter((w) => w.s >= offset).map((w) => ({ ...w, s: r3(w.s - offset), e: r3(w.e - offset) }));
    }
    track.clips.splice(track.clips.indexOf(clip) + 1, 0, right);
    made.push(right.id);
  }
  return made;
}

/** Delete clips and their links, leaving gaps. */
export function remove(doc, ids) {
  const gone = new Set(expand(doc, ids).map((m) => m.clip.id));
  for (const track of doc.tracks) track.clips = track.clips.filter((c) => !gone.has(c.id));
  return gone.size > 0;
}

/**
 * Take the time range [a, b) out of every unlocked track and close the gap: clips inside go, clips across it are
 * cut around it, and everything after slides back.
 */
export function removeRange(doc, a, b) {
  const len = b - a;
  if (len <= 0) return;
  for (const track of doc.tracks) {
    if (track.locked) continue;
    const out = [];
    for (const c of track.clips) {
      const e = end(c);
      if (e <= a + 1e-4) out.push(c);
      else if (c.start >= b - 1e-4) out.push({ ...c, start: r3(c.start - len) });
      else if (c.start >= a - 1e-4 && e <= b + 1e-4) continue;
      else if (c.start < a && e > b) {
        if (isMedia(c) && !loops(c)) {
          const left = { ...c, duration: r3(a - c.start), sourceEnd: r3(c.sourceStart + (a - c.start) * (c.speed || 1)) };
          const right = { ...structuredClone(c), id: `${newId(doc, "p")}${track.id.slice(0, 1)}`, start: r3(a), duration: r3(e - b), sourceStart: r3(c.sourceStart + (b - c.start) * (c.speed || 1)) };
          if (c.link) right.link = `${c.link}r`;
          out.push(left, right);
        } else {
          const cut = { ...structuredClone(c), duration: r3(c.duration - len) };
          if (cut.words) cut.words = cut.words.filter((w) => c.start + w.s < a || c.start + w.s >= b).map((w) => (c.start + w.s >= b ? { ...w, s: r3(w.s - len), e: r3(w.e - len) } : w));
          out.push(cut);
        }
      } else if (c.start < a) {
        const cut = { ...c, duration: r3(a - c.start) };
        if (isMedia(c) && !loops(c)) cut.sourceEnd = r3(c.sourceStart + cut.duration * (c.speed || 1));
        out.push(cut);
      } else {
        const trim = b - c.start;
        const cut = { ...structuredClone(c), start: r3(a), duration: r3(c.duration - trim) };
        if (isMedia(c)) cut.sourceStart = r3(c.sourceStart + trim * (c.speed || 1));
        if (cut.words) cut.words = cut.words.map((w) => ({ ...w, s: r3(w.s - trim), e: r3(w.e - trim) }));
        out.push(cut);
      }
    }
    track.clips = out;
  }
}

/**
 * Delete and close the gap. Picture (or its audio) takes its stretch of time out of the whole edit, so captions
 * and titles stay in sync; anything else only closes up its own track.
 */
export function rippleRemove(doc, ids) {
  const members = expand(doc, ids);
  if (!members.length) return false;
  const picture = members.filter(({ track }) => track.kind === "video" || track.role === "voice");
  if (picture.length) {
    const ranges = picture.map(({ clip }) => [clip.start, end(clip)]).sort((x, y) => y[0] - x[0]);
    for (const [a, b] of ranges) removeRange(doc, a, b);
    // Other selected clips outside those ranges still go, gap and all.
    const left = members.filter((m) => !picture.includes(m) && locate(doc, m.clip.id));
    if (left.length) remove(doc, left.map((m) => m.clip.id));
    return true;
  }
  for (const { track, clip } of members.sort((x, y) => y.clip.start - x.clip.start)) {
    track.clips = track.clips.filter((c) => c.id !== clip.id).map((c) => (c.start >= end(clip) - 1e-4 ? { ...c, start: r3(c.start - clip.duration) } : c));
  }
  return true;
}

/** Put a clip on a track at the free spot nearest `at`. Returns the placed clip, or null if the track is full. */
export function place(doc, track, clip, at) {
  track.clips.push(clip);
  clip.start = Math.max(0, at);
  const shift = freeShift(doc, [{ track, clip }], 0);
  if (shift === null) {
    track.clips.pop();
    return null;
  }
  clip.start = r3(clip.start + shift);
  track.clips.sort((a, b) => a.start - b.start);
  return clip;
}

/** Copies of clips (with fresh ids and links) placed at `at`, or right after the originals. */
export function duplicate(doc, ids, at = null) {
  const members = expand(doc, ids);
  if (!members.length) return [];
  const first = Math.min(...members.map((m) => m.clip.start));
  const last = Math.max(...members.map((m) => end(m.clip)));
  const links = new Map();
  const made = [];
  for (const { track, clip } of members) {
    const copy = structuredClone(clip);
    copy.id = newId(doc, clip.id.replace(/\d+$/, "").slice(0, 6) || "x");
    if (clip.link) {
      if (!links.has(clip.link)) links.set(clip.link, newId(doc, "l"));
      copy.link = links.get(clip.link);
    }
    copy.start = r3((at ?? last) + (clip.start - first));
    track.clips.push(copy);
    made.push({ track, clip: copy });
  }
  const shift = freeShift(doc, made, 0);
  if (shift === null) {
    for (const { track, clip } of made) track.clips.splice(track.clips.indexOf(clip), 1);
    return [];
  }
  for (const { track, clip } of made) {
    clip.start = r3(clip.start + shift);
    track.clips.sort((a, b) => a.start - b.start);
  }
  return made.map((m) => m.clip.id);
}

/** Edges worth snapping to: the start, the playhead, and every clip edge not being dragged. */
export function snapPoints(doc, { exclude = new Set(), playhead = null } = {}) {
  const points = [0];
  if (playhead !== null) points.push(playhead);
  for (const { clip } of allClips(doc)) {
    if (exclude.has(clip.id)) continue;
    points.push(clip.start, end(clip));
  }
  return points;
}

/** `t` pulled onto the closest point within `within` seconds, and that point (or null). */
export function snapTo(points, t, within) {
  let best = null;
  for (const p of points) if (Math.abs(p - t) <= within && (best === null || Math.abs(p - t) < Math.abs(best - t))) best = p;
  return best === null ? { t, at: null } : { t: best, at: best };
}

/** Which clip on a track is under time `t`. */
export const clipAt = (track, t) => track.clips.find((c) => t >= c.start - 1e-4 && t < end(c) - 1e-4) || null;
