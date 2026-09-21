// Claude as the editor: a compact transcript it can read in one go, and the checks a proposed clip has to pass
// before it becomes a clip in the project. Used by the REST API and the MCP server (mcp/server.js), so a person
// in the app and Claude in a chat work on exactly the same clips.
import { hasProfanity } from "./profanity.js";

const r1 = (n) => Math.round(n * 10) / 10;
const stamp = (sec) => {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
};

/**
 * The transcript as phrase lines — `[mm:ss.s-mm:ss.s] text` — split on pauses of half a second, at most 12 s or
 * 160 characters a line, with longer silences and existing clips marked. About a tenth the size of the raw word
 * list, so a whole podcast fits in one read.
 * @param from/to  seconds, to read part of a long episode
 */
export function packTranscript(words, { from = 0, to = Infinity, clips = [], maxChars = 60000 } = {}) {
  const lines = [];
  let phrase = [];
  let chars = 0;
  let cutAt = null;
  const flush = () => {
    if (!phrase.length) return;
    const text = phrase.map((w) => w.text).join(" ");
    lines.push(`[${stamp(phrase[0].start)}-${stamp(phrase.at(-1).end)}] ${text}`);
    chars += text.length + 20;
    phrase = [];
  };
  const inRange = words.filter((w) => w.start >= from && w.start < to);
  for (let i = 0; i < inRange.length; i++) {
    const w = inRange[i];
    const prev = phrase.at(-1);
    if (prev) {
      const gap = w.start - prev.end;
      const long = w.end - phrase[0].start > 12 || phrase.reduce((n, p) => n + p.text.length + 1, 0) > 160;
      if (gap >= 0.5 || long) {
        flush();
        if (gap >= 1.5) lines.push(`  … ${r1(gap)}s pause`);
      }
    }
    phrase.push(w);
    if (chars > maxChars) {
      cutAt = w.start;
      break;
    }
  }
  flush();
  const marks = clips
    .filter((c) => c.end > from && c.start < to)
    .map((c) => `  clip ${c.id} [${stamp(c.start)}-${stamp(c.end)}] "${c.title}"${c.approved ? " (approved)" : ""}`);
  const last = inRange.at(-1)?.end ?? from;
  return {
    text: [...lines, ...(marks.length ? ["", "Existing clips:", ...marks] : [])].join("\n"),
    from: r1(inRange[0]?.start ?? from),
    to: r1(cutAt ?? last),
    more: cutAt !== null ? { from: r1(cutAt) } : null,
  };
}

// Words that only make sense if you heard what came before them. A clip can't open on one unless the pick says
// why it still stands on its own.
const LEANS_BACK = /^(that|it|this|those|these|so|and|but|because|yeah|also|which|then|he|she|they|him|her|them)$/i;

/**
 * Check proposed picks against the transcript. Every problem is reported at once so Claude can fix them all.
 * @param picks  [{ start, end, title, payoff, standalone?, reasoning?, cut?: [{start,end}], hook?: {start,end}, score? }]
 * @returns {{ ok: boolean, problems: string[], clips: object[] }}
 */
export function checkPicks(picks, { words, duration, existing = [] }) {
  const problems = [];
  const clips = [];
  if (!Array.isArray(picks) || !picks.length) return { ok: false, problems: ["No picks were given."], clips };
  picks.forEach((p, n) => {
    const label = `Pick ${n + 1}${p?.title ? ` ("${String(p.title).slice(0, 40)}")` : ""}`;
    const say = (text) => problems.push(`${label}: ${text}`);
    const start = Number(p?.start);
    const end = Number(p?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration + 0.5 || end - start < 5) {
      say(`start/end must be seconds inside the video (0–${Math.round(duration)}) and at least 5s apart.`);
      return;
    }
    const cuts = (Array.isArray(p.cut) ? p.cut : []).map((c) => ({ start: Number(c.start), end: Number(c.end) })).filter((c) => c.end > c.start && c.start >= start && c.end <= end);
    const kept = end - start - cuts.reduce((sum, c) => sum + (c.end - c.start), 0);
    if (kept > 60) say(`runs ${Math.round(kept)}s after cuts; clips have to stay under a minute (aim for 30–42s).`);
    const title = String(p.title || "").trim();
    if (!title) say("needs a title.");
    else if (title.length > 80) say("title is over 80 characters.");
    if (hasProfanity(title)) say("title contains profanity.");
    // Premium brand: calm, specific titles.
    if (/\p{Extended_Pictographic}/u.test(title)) say("title has an emoji; titles stay premium, no emoji.");
    if (title.split(/\s+/).some((w) => /[A-Z]{3,}/.test(w) && w === w.toUpperCase() && !/^\$?\d/.test(w) && !/^(CEO|ROI|AI|USA|NFL|NBA|PT|DC|LLC|SEO|B2B|KPI|CMO|CFO|COO|FAQ)[.,!?]*$/.test(w))) say("title has an ALL-CAPS word; use Title Case.");
    if (/[!?]{2,}/.test(title)) say("title stacks punctuation.");
    const payoff = String(p.payoff || "").trim();
    if (payoff.split(/\s+/).filter(Boolean).length < 5) say("needs a payoff: at least 5 words on what the viewer gets by the end.");
    const said = words.filter((w) => w.start >= start - 0.05 && w.start < end);
    if (!said.length) say("there's no speech in that range.");
    const opener = String(said[0]?.text || "").toLowerCase().replace(/[^a-z']/g, "");
    if (LEANS_BACK.test(opener) && !String(p.standalone || "").trim()) {
      say(`opens on "${said[0].text}", which leans on something said before. Start earlier, or explain in "standalone" why it still works cold.`);
    }
    const overlap = [...existing, ...clips].find((c) => start < c.end - 1 && end > c.start + 1);
    if (overlap) say(`overlaps clip ${overlap.id || "in this list"}.`);
    const hook = p.hook && Number.isFinite(Number(p.hook.start)) && Number(p.hook.end) > Number(p.hook.start) ? { start: Number(p.hook.start), end: Number(p.hook.end) } : null;
    clips.push({ start, end, cuts, hook, title, payoff, standalone: String(p.standalone || "").trim(), reasoning: String(p.reasoning || "").trim(), score: Number.isFinite(Number(p.score)) ? Math.round(Math.min(100, Math.max(1, Number(p.score)))) : null });
  });
  return { ok: !problems.length, problems, clips };
}

/** A checked pick as a project clip (proposed, not approved), with its cuts turned into kept parts. */
export function clipFromPick(pick, id, rank) {
  const parts = [];
  let from = pick.start;
  for (const cut of [...pick.cuts].sort((a, b) => a.start - b.start)) {
    if (cut.start - from >= 0.3) parts.push({ start: from, end: cut.start });
    from = Math.max(from, cut.end);
  }
  if (parts.length && pick.end - from >= 0.3) parts.push({ start: from, end: pick.end });
  return {
    id,
    rank,
    start: +pick.start.toFixed(3),
    end: +pick.end.toFixed(3),
    ...(parts.length ? { parts } : {}),
    ...(pick.hook ? { hook: pick.hook } : {}),
    title: pick.title,
    highlight: "",
    postTitle: pick.title,
    caption: pick.payoff,
    hashtags: [],
    score: pick.score ?? 70,
    reason: pick.reasoning || pick.payoff,
    payoff: pick.payoff,
    standalone: pick.standalone,
    emphasis: [],
    source: "claude-chat",
    approved: false,
  };
}
