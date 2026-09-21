// Tightens a talking clip: drops "um"s, stutters and filler phrases, shrinks long pauses, and rebuilds the clip
// as a list of kept pieces with the transcript re-timed to match. Used by clip previews and renders.

/** Always worth cutting: hesitation sounds. */
const HESITATIONS = new Set(["um", "umm", "uhm", "uh", "uhh", "er", "erm", "ah", "ahh", "hmm", "mmm", "mhm"]);

/** Cut only as a whole phrase — these words are fine on their own ("I like it", "you know the answer"). */
const FILLER_PHRASES = [
  ["you", "know", "what", "i", "mean"],
  ["you", "know", "what", "im", "saying"],
  ["kind", "of", "like"],
  ["sort", "of", "like"],
  ["i", "mean", "like"],
  ["so", "like"],
  ["like", "i", "said"],
  ["you", "know"],
  ["i", "mean"],
];

const norm = (word) => String(word.text || "").toLowerCase().replace(/[^a-z']/g, "");
const r3 = (n) => Math.round(n * 1000) / 1000;

/**
 * @param words   the video's transcript [{ text, start, end }]
 * @param ranges  source ranges to build the clip from, in order — [{ start, end }]
 * @param opts    pauseMax: a gap longer than this is shrunk to pauseKeep; filler: cut filler at all;
 *                minPiece: a piece shorter than this rejoins its neighbour when what was cut between them is
 *                no longer than absorbMax seconds
 * @returns { parts: [{ start, end }], words: [{ text, s, e }], removed: { filler, stutters, pauses, seconds } }
 *          `parts` are source ranges to play back to back; `words` are on the tightened timeline.
 */
export function tightenClip(words, ranges, { pauseMax = 0.45, pauseKeep = 0.25, filler = true, minPiece = 1.6, absorbMax = 1.2, keepOut = [], protect = [] } = {}) {
  // Stretches the review pass asked to leave whole (a cut there sounded wrong): nothing inside them is dropped.
  const guarded = (from, to) => protect.some((p) => p.start < to - 0.01 && p.end > from + 0.01);
  const removed = { filler: 0, stutters: 0, pauses: 0, seconds: 0 };
  const parts = [];
  const timed = [];
  let clock = 0; // where we are on the tightened timeline

  for (const range of ranges) {
    // Only words that start inside the range — a word already half-spoken at the cut isn't part of this clip.
    const inRange = words.filter((w) => w.start >= range.start - 0.05 && w.start < range.end - 0.01);
    // Don't trail off into the next thought: words squeezed into the range's last half second after a finished
    // sentence ("…full time. So anyways,") belong to what comes next.
    const lastFull = inRange.findLastIndex((w) => /[.?!]$/.test(String(w.text)));
    if (lastFull >= 0 && lastFull < inRange.length - 1 && inRange[lastFull + 1].start > range.end - 0.5) inRange.length = lastFull + 1;
    if (!inRange.length) {
      parts.push({ start: r3(range.start), end: r3(range.end) });
      clock += range.end - range.start;
      continue;
    }

    // Which words to drop.
    const drop = new Set();
    if (filler) {
      inRange.forEach((w, i) => {
        const n = norm(w);
        if (HESITATIONS.has(n)) {
          drop.add(i);
          removed.filler += 1;
          return;
        }
        // A word stuttered twice in a row ("the the", "I I") — keep the second.
        const prev = inRange[i - 1];
        if (prev && norm(prev) === n && n.length > 1 && w.start - prev.end < 0.4 && !drop.has(i - 1)) {
          drop.add(i - 1);
          removed.stutters += 1;
        }
      });
      // False starts: "I was going to — I was going to tell you" or "we had, we had a patient". The speaker
      // started a phrase, abandoned it within a few words, and said it again. Keep the attempt that finished.
      for (const k of [4, 3, 2]) {
        for (let i = 0; i + k <= inRange.length; i++) {
          const head = inRange.slice(i, i + k).map(norm);
          if (head.some((n) => !n) || head.join("").length < 4) continue;
          for (let j = i + k; j <= i + k + 4 && j + k <= inRange.length; j++) {
            if (!head.every((n, m) => norm(inRange[j + m]) === n)) continue;
            const abandoned = inRange.slice(i, j);
            const quick = inRange[j].start - inRange[i].start <= 3.2;
            const unfinished = !abandoned.some((w) => /[.?!]$/.test(String(w.text)));
            // A restart has a break in it — a catch of breath or a comma. "Day after day after day" flows
            // straight through, and that repetition is on purpose.
            const broke = inRange[j].start - inRange[j - 1].end >= 0.12 || /[,—–-]$/.test(String(inRange[j - 1].text));
            if (quick && unfinished && broke && !abandoned.some((_, m) => drop.has(i + m))) {
              for (let m = i; m < j; m++) drop.add(m);
              removed.stutters += 1;
            }
            break;
          }
        }
      }
      for (const phrase of FILLER_PHRASES) {
        for (let i = 0; i + phrase.length <= inRange.length; i++) {
          if (phrase.every((part, k) => norm(inRange[i + k]) === part) && !phrase.some((_, k) => drop.has(i + k))) {
            // Only when it's an aside: something must be said on both sides of it.
            if (i === 0 || i + phrase.length >= inRange.length) continue;
            for (let k = 0; k < phrase.length; k++) drop.add(i + k);
            removed.filler += phrase.length;
          }
        }
      }
    }

    for (const i of [...drop]) if (guarded(inRange[i].start, inRange[i].end)) drop.delete(i);

    // Walk the kept words, breaking a piece wherever we cut something out or shrink a pause.
    let pieceStart = range.start;
    let previous = null; // last kept word
    const flush = (endAt) => {
      if (previous && endAt - pieceStart >= 0.05) parts.push({ start: r3(pieceStart), end: r3(endAt) });
    };

    inRange.forEach((w, i) => {
      if (drop.has(i)) return;
      if (!previous) {
        timed.push({ text: w.text, s: r3(clock + Math.max(0, w.start - pieceStart)), e: r3(clock + Math.max(0.09, w.end - pieceStart)), at: [w.start, w.end] });
        previous = w;
        return;
      }
      const gap = w.start - previous.end;
      // Where the pause sits decides whether it's dead air. Between sentences a long beat can go; at a comma it
      // takes longer before it's worth a cut; inside a phrase ("to help with … fulfillment") a jump cut breaks
      // the words apart, so only a really long stall gets cut there, and every cut keeps a natural breath.
      const ending = /[.?!]$/.test(String(previous.text || ""));
      const clause = /[,;:—–-]$/.test(String(previous.text || ""));
      const limit = ending ? pauseMax + 0.15 : clause ? pauseMax + 0.25 : pauseMax + 0.55;
      const keep = ending ? Math.max(pauseKeep, 0.35) : Math.max(pauseKeep, 0.3);
      const cutOut = (drop.has(i - 1) || gap > limit) && !guarded(previous.end, w.start);
      if (cutOut) {
        // Close the piece just after the last kept word, and start the next just before this one.
        const endAt = Math.min(range.end, previous.end + (drop.has(i - 1) ? 0.06 : keep / 2));
        const nextStart = Math.max(endAt, w.start - (drop.has(i - 1) ? 0.04 : keep / 2));
        if (gap > limit) {
          removed.pauses += 1;
          removed.seconds += gap - keep;
        } else {
          removed.seconds += nextStart - endAt;
        }
        flush(endAt);
        clock += endAt - pieceStart;
        pieceStart = nextStart;
      }
      timed.push({ text: w.text, s: r3(clock + Math.max(0, w.start - pieceStart)), e: r3(clock + Math.max(0.09, w.end - pieceStart)), at: [w.start, w.end] });
      previous = w;
    });

    const endAt = Math.min(range.end, (previous?.end ?? range.start) + 0.35);
    flush(endAt);
    clock += endAt - pieceStart;
  }

  // No islands: a sliver of speech between two cuts reads as a glitch, not an edit. A piece shorter than
  // `minPiece` gives back the little it was cut away from — the "um" or breath beside it plays, which sounds far
  // more natural than a jump in and straight back out. Pieces separated by a real cut (a dropped sentence, a
  // long pause, the hook joining the clip) stay separate.
  const merged = parts.map((p) => ({ ...p }));
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < merged.length; i++) {
      const p = merged[i];
      if (p.end - p.start >= minPiece) continue;
      const prev = merged[i - 1];
      const next = merged[i + 1];
      // Only neighbours that continue in the same direction through the source (not the hook joining the clip).
      const before = prev && p.start >= prev.end - 0.01 ? p.start - prev.end : Infinity;
      const after = next && next.start >= p.end - 0.01 ? next.start - p.end : Infinity;
      if (Math.min(before, after) > absorbMax) continue;
      // Never absorb across something the creator cut on purpose.
      const blocked = (from, to) => keepOut.some((c) => c.start < to - 0.01 && c.end > from + 0.01);
      if (before <= after ? blocked(prev.end, p.start) : blocked(p.end, next.start)) continue;
      if (before <= after) prev.end = p.end;
      else next.start = p.start;
      removed.seconds -= Math.min(before, after);
      merged.splice(i, 1);
      changed = true;
      break;
    }
  }
  // Words back onto the timeline the merged pieces actually play.
  const retimed = timed.map(({ at, ...w }) => {
    const s = toTightened(merged, at[0]);
    if (s === null) return w;
    const e = toTightened(merged, at[1]);
    return { ...w, s, e: e === null ? r3(s + (w.e - w.s)) : Math.max(e, r3(s + 0.09)) };
  });
  const duration = merged.reduce((sum, p) => sum + (p.end - p.start), 0);
  return { parts: merged, words: retimed, removed: { ...removed, seconds: r3(Math.max(0, removed.seconds)) }, duration: r3(duration) };
}

/** Where a source time lands on the tightened timeline (for subject-tracking paths), or null if it was cut. */
export function toTightened(parts, sourceTime) {
  let clock = 0;
  for (const part of parts) {
    if (sourceTime >= part.start && sourceTime <= part.end) return r3(clock + (sourceTime - part.start));
    clock += part.end - part.start;
  }
  return null;
}
