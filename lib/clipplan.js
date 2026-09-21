// One place that decides how a talking clip plays: which pieces survive tightening, the transcript re-timed to
// match, and the quiet instrumental bed under the voice. Previews and renders both build from this, so what the
// creator sees is what gets rendered.
import { MUSIC_TAIL, normalizeDesign } from "./compose.js";
import { getTrack, instrumentalTracks } from "./sounds.js";
import { tightenClip, toTightened } from "./tighten.js";
import { fitWordsToSpeech } from "./silence.js";
import { isProfane } from "./profanity.js";
import { formatMoney } from "./money.js";
import { quietestAt } from "./levels.js";

const r3 = (n) => Math.round(n * 1000) / 1000;

/** The sentence spoken at `at`: whole words, ending on punctuation or after `maxSec`. Null when it's too thin. */
function sentenceAt(words, at, { maxSec = 5, minSec = 1.2, minWords = 4, complete = false } = {}) {
  let first = words.findIndex((w) => w.start >= at - 0.25);
  if (first < 0) return null;
  // A complete line starts where its sentence does: walk back to the word after the previous full stop (or a
  // clear pause), up to a few seconds. A line picked up mid-sentence isn't usable on its own.
  if (complete) {
    const anchor = words[first].start;
    while (first > 0 && !/[.?!]$/.test(String(words[first - 1].text)) && words[first].start - words[first - 1].end < 0.7) {
      if (anchor - words[first - 1].start > 3) return null;
      first -= 1;
    }
  }
  const line = [];
  for (let i = first; i < words.length; i++) {
    const w = words[i];
    if (line.length && (w.start - line.at(-1).end > 0.7 || w.end - words[first].start > maxSec)) break;
    line.push(w);
    if (/[.?!]$/.test(w.text)) break;
  }
  const span = line.length ? line.at(-1).end - line[0].start : 0;
  if (line.length < minWords || span < minSec) return null;
  if (complete && !/[.?!]$/.test(String(line.at(-1).text))) return null;
  return { start: r3(line[0].start), end: r3(line.at(-1).end + 0.12) };
}

/**
 * A hook to open a clip with: one of the video's strongest key messages, said somewhere other than inside this
 * clip. Each clip takes a different one (by rank) so two posts don't open on the same line. Null when the clip's
 * own opening is already the best thing available.
 */
export function hookRange(clip, words, analysis) {
  const candidates = [...(analysis?.messages || [])].filter((m) => Number.isFinite(m.start)).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const inside = (m) => m.start > clip.start - 2 && m.start < clip.end + 2;
  // One of the video's two best lines is already in here: nothing to put in front of it.
  if (candidates.slice(0, 2).some(inside)) return null;
  const lines = [];
  for (const candidate of candidates) {
    if (inside(candidate)) continue;
    // A hook has to land on its own: a whole sentence, long enough to register before the cut.
    const line = sentenceAt(words, candidate.start, { maxSec: 6, minSec: 2, complete: true });
    // A hook can't open on throat-clearing ("Like,", "So yeah", "It's like").
    const opener = line && words.filter((w) => w.start >= line.start - 0.01 && w.start < line.end).slice(0, 2).map((w) => String(w.text).toLowerCase().replace(/[^a-z']/g, "")).join(" ");
    const said = line ? words.filter((w) => w.start >= line.start - 0.01 && w.start < line.end).map((w) => String(w.text).toLowerCase().replace(/[^a-z']/g, "")) : [];
    const filler = said.filter((w) => w === "like" || w === "um" || w === "uh").length;
    const clean = !words.some((w) => w.start >= line?.start - 0.01 && w.start < line?.end && isProfane(w.text));
    if (line && clean && filler < 2 && !/^(like|so|yeah|um|uh|okay|ok|anyway|it's like|i mean|you know)\b/.test(opener)) lines.push(line);
    if (lines.length >= 6) break;
  }
  // Each clip takes its own line by rank; when there aren't enough good lines to go around, later clips open
  // on their own first words rather than repeating another clip's hook.
  const rank = Math.max(1, Math.round(clip.rank || 1));
  return lines[rank - 1] || null;
}

/** A clip shorter than this feels thin on its own, so other strong lines get stitched on behind it. */
const THIN_SEC = 18;
const FULL_SEC = 26;

/**
 * Other valuable things the speaker said, to carry a short clip: the best key messages outside everything the
 * clip already plays, as whole sentences, back in the order they were said.
 */
function stitchRanges(ranges, words, analysis, need) {
  const taken = [...ranges];
  const overlaps = (r) => taken.some((t) => r.start < t.end + 1 && r.end > t.start - 1);
  const extra = [];
  let got = 0;
  for (const m of [...(analysis?.messages || [])].filter((m) => Number.isFinite(m.start)).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    if (got >= need || extra.length >= 3) break;
    if ((m.score ?? 0) < 55) break; // below this it's padding, and padding is worse than a short clip
    const line = sentenceAt(words, m.start, { maxSec: 9, minSec: 1.5 });
    if (!line || overlaps(line) || words.some((w) => w.start >= line.start - 0.01 && w.start < line.end && isProfane(w.text))) continue;
    extra.push(line);
    taken.push(line);
    got += line.end - line.start;
  }
  return extra.sort((a, b) => a.start - b.start);
}

/**
 * @param context  { analysis } — used to open the clip on the video's strongest hook and to fill out a thin clip.
 * @returns { duration, parts: [{ start, end, t, dur }], words: [{ text, s, e }], removed, hook, stitched }
 *          `start`/`end` are source times; `t`/`dur` are where the piece sits in the finished clip.
 */
export function planClip(clip, words, design, { analysis, silences, levels, stills } = {}) {
  const d = normalizeDesign(design);
  // The creator's own spelling fixes for this clip, then word timings pulled back to the actual sound.
  words = fitWordsToSpeech(applyWordFixes(words, clip.wordFixes), silences);
  // The clip's kept stretches (what's left after the tangents and restarts inside it were marked out), held to
  // the clip's own bounds in case its start or end was trimmed afterwards.
  const kept = (clip.parts || [])
    .map((p) => ({ start: Math.max(p.start, clip.start), end: Math.min(p.end, clip.end) }))
    .filter((p) => p.end - p.start >= 0.3);
  const ranges = kept.length ? kept : [{ start: clip.start, end: clip.end }];
  // The finished clip is what has to stay under a minute, so leave room for the music's ring-out after the last
  // word (Podcast Frame with a bed; see pipeline prepareClip).
  const limit = MAX_SEC - (d.style === "podcast" && d.musicBed !== "none" ? MUSIC_TAIL.sec : 0);
  const span = () => ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
  // Lead with the best hook in the video, then the clip itself — unless that would push it past a minute.
  // A hook the creator pinned to this clip wins; otherwise the engine picks one.
  const pinned = Number.isFinite(clip.hook?.start) && clip.hook.end > clip.hook.start ? { start: clip.hook.start, end: clip.hook.end } : null;
  // Claude's picks (they carry ratings) already chose their opening with the topic in mind — its own first line or a
  // hook_segment from elsewhere, which arrives pinned. Borrowing the video's top line by rank instead opened clips
  // on something unrelated, so that fallback is only for clips Claude didn't pick.
  const candidate = pinned || (d.hookFirst && !clip.ratings ? hookRange(clip, words, analysis) : null);
  const hook = candidate && span() + (candidate.end - candidate.start) <= limit ? candidate : null;
  if (hook) ranges.unshift(hook);
  // Never stop mid-sentence: finish the thought if it wraps up within a few seconds, otherwise end the clip on
  // its last complete sentence (below).
  const body = ranges.at(-1);
  const lastSaid = words.findLast((w) => w.start >= body.start - 0.05 && w.start < body.end - 0.01);
  // Where a thought ends: a full stop, or — where the transcript came back without punctuation — a real pause.
  const endsThought = (i) => /[.?!]$/.test(String(words[i].text)) || (words[i + 1] ? words[i + 1].start - words[i].end >= 0.45 : true);
  const at = lastSaid ? words.indexOf(lastSaid) : -1;
  if (at >= 0 && !endsThought(at)) {
    let finish = -1;
    for (let i = at + 1; i < Math.min(words.length, at + 16); i++) if (endsThought(i)) { finish = i; break; }
    const end = finish >= 0 ? words[finish].end : Infinity;
    if (end - body.end <= 4 && span() + (end + 0.3 - body.end) <= limit) body.end = r3(end + 0.3);
    else {
      // It runs on too long to finish: end on the last place inside the clip where a thought does.
      const from = body.start + (body.end - body.start) * 0.5;
      for (let i = at - 1; i >= 0 && words[i].end > from; i--) {
        if (endsThought(i)) {
          body.end = r3(Math.min(words[i].end + 0.3, words[i + 1].start - 0.05));
          break;
        }
      }
    }
  }
  // Too short to hold a reel on its own: follow it with the next-best things the speaker said.
  const stitched = d.stitch && span() < THIN_SEC ? stitchRanges(ranges, words, analysis, FULL_SEC - span()) : [];
  ranges.push(...stitched);
  // No curse words anywhere in the clip: every sentence with one comes out whole. Then the words the creator struck
  // out in the transcript editor.
  const cleanRanges = subtractRanges(withoutStills(withoutProfanity(ranges, words), words, stills), clip.cuts);
  // Cleaning must never leave nothing to play: a clip with no pieces renders as a broken file.
  if (cleanRanges.length) ranges.splice(0, ranges.length, ...cleanRanges);
  // Not tightening still re-times the words onto the clip's own timeline.
  const keepOut = Array.isArray(clip.cuts) ? clip.cuts : [];
  // Every cut then moves to the quietest instant between words, so no piece starts on the tail of a sound.
  const plan = snapCuts(fitUnder(dropLeadingFragment(tightenClip(words, ranges, d.tighten ? { keepOut, protect: clip.protect || [] } : { filler: false, pauseMax: Infinity, keepOut })), limit), words, levels);

  let clock = 0;
  const parts = plan.parts.map((p) => {
    const part = { start: p.start, end: p.end, t: r3(clock), dur: r3(p.end - p.start) };
    clock += part.dur;
    return part;
  });
  const duration = r3(clock);
  // Captions say money the creator's way: "$20k", "$100k/month", "$1".
  const timedWords = formatMoney(plan.words.filter((w) => w.s < duration).map((w) => (w.e > duration ? { ...w, e: duration } : w)));
  return { ...plan, parts, words: timedWords, duration, hook, stitched };
}

/**
 * A clip that opens on a sliver of speech cut off from what follows ("And then the ask," … pause … cut) starts
 * on a stumble. Open on the next piece instead, where the thought actually begins.
 */
function dropLeadingFragment(plan) {
  const [first, second] = plan.parts;
  const len = first ? first.end - first.start : 0;
  if (!second || len >= 1.6) return plan;
  const text = plan.words.filter((w) => w.s < len - 0.02);
  if (text.some((w) => /[.?!]$/.test(String(w.text)))) return plan; // a complete short line is a fine opener
  const words = plan.words.filter((w) => w.s >= len - 0.02).map((w) => ({ ...w, s: r3(w.s - len), e: r3(w.e - len) }));
  return { ...plan, parts: plan.parts.slice(1), words, duration: r3(plan.duration - len) };
}

/**
 * The ranges with every profane sentence cut out. A sentence runs to a full stop or a clear pause; its cut takes
 * the whole sentence so nothing half-said is left behind, and the pieces either side stay as they were.
 */
function withoutProfanity(ranges, words) {
  const out = [];
  for (const range of ranges) {
    const said = words.filter((w) => w.start >= range.start - 0.05 && w.start < range.end - 0.01);
    if (!said.some((w) => isProfane(w.text))) {
      out.push(range);
      continue;
    }
    // Group into sentences.
    const sentences = [];
    let current = [];
    said.forEach((w, i) => {
      current.push(w);
      const next = said[i + 1];
      if (!next || /[.?!]$/.test(String(w.text)) || next.start - w.end >= 0.6) {
        sentences.push(current);
        current = [];
      }
    });
    let from = range.start;
    sentences.forEach((sentence, i) => {
      if (!sentence.some((w) => isProfane(w.text))) return;
      const cutStart = Math.max(from, sentence[0].start - 0.04);
      if (cutStart - from >= 0.3) out.push({ start: r3(from), end: r3(cutStart) });
      from = sentences[i + 1] ? Math.max(sentence.at(-1).end + 0.04, sentences[i + 1][0].start - 0.08) : range.end;
    });
    if (range.end - from >= 0.3) out.push({ start: r3(from), end: r3(range.end) });
  }
  return out.length ? out : ranges.slice(0, 0);
}

/**
 * Move each piece's start and end to the quietest 10 ms nearby (lib/levels.js), without reaching into a word the
 * piece keeps or the tail of the word before or after it. The caption words move with their piece.
 */
function snapCuts(plan, words, levels) {
  if (!levels || !plan.parts.length) return plan;
  const oldT = [];
  let clock = 0;
  for (const p of plan.parts) {
    oldT.push(clock);
    clock += p.end - p.start;
  }
  const parts = plan.parts.map((p) => {
    const inside = words.filter((w) => w.start >= p.start - 0.05 && w.start < p.end - 0.01);
    const first = inside[0];
    const last = inside.at(-1);
    const before = first ? words[words.indexOf(first) - 1] : null;
    const after = last ? words[words.indexOf(last) + 1] : null;
    let start = p.start;
    let end = p.end;
    const sLo = Math.max(p.start - 0.1, before ? before.end + 0.005 : -Infinity);
    const sHi = Math.min(p.start + 0.05, first ? first.start - 0.015 : Infinity);
    const qs = quietestAt(levels, sLo, sHi);
    if (qs !== null) start = qs;
    const eLo = Math.max(p.end - 0.05, last ? last.end + 0.015 : -Infinity);
    const eHi = Math.min(p.end + 0.1, after ? after.start - 0.005 : Infinity);
    const qe = quietestAt(levels, eLo, eHi);
    if (qe !== null) end = qe;
    return end - start >= 0.2 ? { start: r3(start), end: r3(end) } : { start: p.start, end: p.end };
  });
  const newT = [];
  clock = 0;
  for (const p of parts) {
    newT.push(clock);
    clock += p.end - p.start;
  }
  const pieceOf = (t) => {
    let k = 0;
    while (k + 1 < oldT.length && t >= oldT[k + 1] - 1e-6) k++;
    return k;
  };
  const shift = (t, k) => r3(newT[k] + (t - oldT[k]) + (plan.parts[k].start - parts[k].start));
  const moved = plan.words.map((w) => {
    const k = pieceOf(w.s);
    return { ...w, s: Math.max(0, shift(w.s, k)), e: Math.max(0, shift(w.e, k)) };
  });
  return { ...plan, parts, words: moved, duration: r3(clock) };
}

/** A word's key in clip.wordFixes: its start time in milliseconds (stable across re-plans). */
export const wordKey = (w) => String(Math.round(w.start * 1000));

/** Words with the creator's per-clip text fixes applied: { "<startMs>": "new text" } (empty text leaves it as said). */
export function applyWordFixes(words, fixes) {
  if (!fixes || !Object.keys(fixes).length) return words;
  // Keys are a word's start in ms; fixes made from a rendered clip land within a few frames of it, so the nearest
  // word within 80 ms counts.
  const keys = Object.keys(fixes).map(Number).filter(Number.isFinite);
  return words.map((w) => {
    const exact = fixes[wordKey(w)];
    const ms = w.start * 1000;
    const near = typeof exact === "string" ? null : keys.find((k) => Math.abs(k - ms) <= 80);
    const fix = typeof exact === "string" ? exact : near != null ? fixes[String(near)] : null;
    return typeof fix === "string" && fix.trim() ? { ...w, text: fix.trim() } : w;
  });
}

/** Ranges with the creator's cuts [{ start, end }] (source seconds) taken out. */
export function subtractRanges(ranges, cuts) {
  const list = (Array.isArray(cuts) ? cuts : []).filter((c) => Number.isFinite(c?.start) && c.end > c.start).sort((a, b) => a.start - b.start);
  if (!list.length) return ranges;
  const out = [];
  for (const range of ranges) {
    let from = range.start;
    for (const cut of list) {
      if (cut.end <= from || cut.start >= range.end) continue;
      if (cut.start - from >= 0.25) out.push({ start: r3(from), end: r3(cut.start) });
      from = Math.max(from, cut.end);
    }
    if (range.end - from >= 0.25) out.push({ start: r3(from), end: r3(range.end) });
  }
  return out;
}

/**
 * The ranges without the sentences spoken over a still picture — a text card, a black slide, a frozen frame — so
 * the clip never sits on a dead picture. Sentences run to a full stop or a clear pause and come out whole.
 */
/** How far either side of a still frame the cut may reach to finish the sentence it interrupts. */
const REACH = 2.5;

function withoutStills(ranges, words, stills) {
  const cards = (stills || []).filter((s) => s.end - s.start >= 1.2);
  if (!cards.length) return ranges;
  const cuts = [];
  for (const card of cards) {
    const said = words.filter((w) => w.end > card.start && w.start < card.end);
    // Whole sentences around the card: back to the previous full stop, forward to the next.
    let a = said.length ? words.indexOf(said[0]) : -1;
    let b = said.length ? words.indexOf(said.at(-1)) : -1;
    if (a < 0) {
      cuts.push({ start: card.start, end: card.end });
      continue;
    }
    // Some transcripts come back with almost no full stops; without a limit the walk runs the length of the clip and
    // takes everything with it, so it reaches at most a couple of seconds either side of the card.
    while (a > 0 && !/[.?!]$/.test(String(words[a - 1].text)) && words[a].start - words[a - 1].end < 0.6 && words[a].start > card.start - REACH) a--;
    while (b < words.length - 1 && !/[.?!]$/.test(String(words[b].text)) && words[b + 1].start - words[b].end < 0.6 && words[b].end < card.end + REACH) b++;
    cuts.push({ start: Math.min(card.start, words[a].start - 0.04), end: Math.max(card.end, words[b].end + 0.08) });
  }
  const span = (rs) => rs.reduce((sum, r) => sum + (r.end - r.start), 0);
  const trimmed = subtractRanges(ranges, cuts);
  // Cutting away most of the clip to hide a still frame is never the right trade: take out the still frames only.
  if (span(trimmed) < span(ranges) * 0.6) return subtractRanges(ranges, cards);
  return trimmed;
}

/** Every finished clip stays under a minute, music ring-out included. */
export const MAX_SEC = 59;

/**
 * A tightened clip that still runs long ends on the last complete sentence before the limit, never mid-word.
 */
function fitUnder(plan, limit) {
  if (plan.duration <= limit) return plan;
  // Latest full stop that still fits; failing that, the latest comma or clause break; only then a bare word.
  const fits = (w, from) => w.e <= limit - 0.3 && w.e >= limit * from;
  const ender =
    plan.words.findLast((w) => /[.?!]$/.test(String(w.text)) && fits(w, 0.4)) ||
    plan.words.findLast((w) => /[,;:]$/.test(String(w.text)) && fits(w, 0.6)) ||
    plan.words.findLast((w) => w.e <= limit - 0.1);
  const cutoff = ender ? Math.min(limit, ender.e + 0.3) : limit;
  const lastWord = ender ? plan.words.indexOf(ender) : plan.words.length - 1;
  const parts = [];
  let clock = 0;
  for (const p of plan.parts) {
    const len = p.end - p.start;
    if (clock >= cutoff) break;
    parts.push(clock + len <= cutoff ? p : { start: p.start, end: r3(p.start + (cutoff - clock)) });
    clock += len;
  }
  // Nothing after the chosen last word, even if it starts inside the breath that follows it.
  const words = plan.words.slice(0, lastWord + 1).map((w) => (w.e > cutoff ? { ...w, e: r3(cutoff) } : w));
  return { ...plan, parts, words, duration: r3(Math.min(clock, cutoff)) };
}

/**
 * The bed under the talking: "none", a chosen track, or one of the creator's instrumental tracks picked from the
 * clip's id — stable, so the preview and the render use the same song.
 */
export async function clipMusic(clip, design, { projectId = "" } = {}) {
  const d = normalizeDesign(design);
  if (d.musicBed === "none") return null;
  if (d.musicBed !== "auto") return getTrack(d.musicBed);
  const tracks = [...(await instrumentalTracks())].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (!tracks.length) return null;
  // Clips from one video walk through the library in turn, so a batch posted together doesn't share a song, and
  // each video starts somewhere different so every upload's first clip isn't the same track either.
  const hash = (text) => [...String(text)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rank = Number.isFinite(clip.rank) ? clip.rank - 1 : hash(clip.id);
  return getTrack(tracks[(hash(projectId) + rank) % tracks.length].id);
}

/** Move a subject-tracking path (clip-relative source seconds) onto the tightened timeline, dropping cut moments. */
export function mapFocus(focus, clip, parts) {
  if (!focus?.length) return focus;
  return focus
    .map((p) => ({ t: toTightened(parts, clip.start + p.t), x: p.x, ...(p.cut ? { cut: true } : {}) }))
    .filter((p) => p.t != null);
}
