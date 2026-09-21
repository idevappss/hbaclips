// What happened after a clip was posted, joined back to why it was picked — so picking learns from real results.
// Posts (data/scheduler.json) carry a snapshot of the clip as it was picked (score, rubric ratings, hook, payoff,
// length); the Instagram module (data/instagram.json) stores each published Reel's insights. Each post is scored
// against its own account's typical numbers, and the best and worst performers go into the picking prompt the
// way the Titles module teaches title taste.
import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./tools.js";

const DATA = path.join(ROOT, "data");
const MIN_POSTS = 3; // fewer than this and there's nothing to learn from yet
const MIN_AGE_H = 24; // a Reel's numbers before a day are mostly noise

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
};
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

/**
 * Every published post with insights, scored: [{ postId, accountId, title, hook, payoff, duration, pickScore,
 * ratings, publishedAt, ageHours, metrics, views, relViews, retention, engagement, performance }].
 * relViews = views ÷ that account's median; retention = avg watch time ÷ clip length; engagement = (shares +
 * saves + comments) ÷ reach; performance blends them (1.0 = the account's typical post).
 */
export async function postPerformance({ schedulerFile = path.join(DATA, "scheduler.json"), instagramFile = path.join(DATA, "instagram.json"), now = new Date() } = {}) {
  const sched = await readJson(schedulerFile, { posts: [] });
  const ig = await readJson(instagramFile, { jobs: [] });
  const rows = [];
  for (const job of ig.jobs || []) {
    if (!job.insights || !job.postId) continue;
    const post = (sched.posts || []).find((p) => p.id === job.postId);
    if (!post) continue;
    const published = Date.parse(job.publishedAt || post.scheduledAt);
    const ins = job.insights;
    const duration = Number(post.clip?.duration ?? post.duration) || null;
    // Instagram reports average watch time in milliseconds.
    const watchSec = Number.isFinite(ins.ig_reels_avg_watch_time) ? ins.ig_reels_avg_watch_time / 1000 : null;
    rows.push({
      postId: post.id,
      accountId: job.accountId,
      title: post.clip?.title || post.title,
      hook: post.clip?.hook || null,
      payoff: post.clip?.payoff || null,
      duration,
      pickScore: post.clip?.score ?? null,
      ratings: post.clip?.ratings || null,
      reviewScore: post.clip?.reviewScore ?? null,
      publishedAt: job.publishedAt || post.scheduledAt,
      ageHours: Number.isFinite(published) ? Math.round((now - published) / 3.6e6) : null,
      permalink: job.permalink || null,
      metrics: ins,
      views: Number(ins.views) || 0,
      retention: watchSec && duration ? r2(Math.min(1.5, watchSec / duration)) : null,
      engagement: Number(ins.reach) > 0 ? r2(((Number(ins.shares) || 0) + (Number(ins.saved) || 0) + (Number(ins.comments) || 0)) / Number(ins.reach)) : null,
    });
  }
  // Relative to each account's own typical post, so a small account's hit counts as a hit.
  for (const account of new Set(rows.map((r) => r.accountId))) {
    const mine = rows.filter((r) => r.accountId === account && (r.ageHours ?? 0) >= MIN_AGE_H);
    const typicalViews = median(mine.map((r) => r.views)) || 1;
    const typicalRet = median(mine.map((r) => r.retention));
    const typicalEng = median(mine.map((r) => r.engagement));
    for (const r of rows.filter((x) => x.accountId === account)) {
      r.relViews = r2(r.views / typicalViews);
      const parts = [[r.relViews, 0.5], [typicalRet && r.retention != null ? r.retention / typicalRet : null, 0.3], [typicalEng && r.engagement != null ? r.engagement / typicalEng : null, 0.2]].filter(([v]) => Number.isFinite(v));
      const weight = parts.reduce((s, [, w]) => s + w, 0);
      r.performance = weight ? r2(parts.reduce((s, [v, w]) => s + Math.min(5, v) * w, 0) / weight) : null;
    }
  }
  return rows.sort((a, b) => (b.performance ?? 0) - (a.performance ?? 0));
}

/** Which rubric factors went with better results so far (rank correlation), once there are enough posts. */
export function factorSignals(rows) {
  const usable = rows.filter((r) => r.ratings && Number.isFinite(r.performance) && (r.ageHours ?? 0) >= MIN_AGE_H);
  if (usable.length < 8) return null;
  // Average ranks for ties, then Pearson on the ranks (Spearman); a factor rated the same on every post says nothing.
  const rank = (xs) => {
    const order = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(xs.length);
    for (let k = 0; k < order.length; ) {
      let e = k;
      while (e + 1 < order.length && order[e + 1][0] === order[k][0]) e++;
      for (let m = k; m <= e; m++) out[order[m][1]] = (k + e) / 2;
      k = e + 1;
    }
    return out;
  };
  const pearson = (a, b) => {
    const n = a.length;
    const ma = a.reduce((s, v) => s + v, 0) / n;
    const mb = b.reduce((s, v) => s + v, 0) / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    return da && db ? num / Math.sqrt(da * db) : null;
  };
  const perf = rank(usable.map((r) => r.performance));
  const out = {};
  for (const factor of Object.keys(usable[0].ratings)) {
    const values = usable.map((r) => Number(r.ratings[factor]) || 0);
    if (new Set(values).size < 2) continue;
    const c = pearson(rank(values), perf);
    if (c !== null) out[factor] = r2(c);
  }
  return { posts: usable.length, correlation: out };
}

/** The prompt block for picking: what has and hasn't worked on this creator's accounts. Empty until there's data. */
export async function performanceGuidance(options) {
  const rows = (await postPerformance(options)).filter((r) => (r.ageHours ?? 0) >= MIN_AGE_H && Number.isFinite(r.performance));
  if (rows.length < MIN_POSTS) return "";
  const line = (r) =>
    `- "${r.title}"${r.hook ? ` — opens: "${String(r.hook).slice(0, 120)}"` : ""} | ${Math.round(r.duration || 0)}s | ${r.views} views (${r.relViews}× typical)${r.retention != null ? `, watched ${Math.round(r.retention * 100)}% on average` : ""}${r.engagement != null ? `, ${Math.round(r.engagement * 1000) / 10}% shared/saved/commented` : ""}`;
  const top = rows.slice(0, 5);
  const bottom = rows.slice(-5).reverse().filter((r) => !top.includes(r));
  const signals = factorSignals(rows);
  const parts = [
    `<what_performed>
Real results from clips this creator has already posted, scored against their own typical post. Learn what their audience actually rewards — the kind of opening, topic, length and payoff — and pick more like the winners and fewer like the misses. Never copy a posted clip; it's a signal about taste, not a template.`,
    `<best_performers>\n${top.map(line).join("\n")}\n</best_performers>`,
  ];
  if (bottom.length) parts.push(`<weakest_performers>\n${bottom.map(line).join("\n")}\n</weakest_performers>`);
  if (signals) {
    const sorted = Object.entries(signals.correlation).sort((a, b) => b[1] - a[1]);
    parts.push(`Across ${signals.posts} posts, the picking factors that went with better results: ${sorted.map(([k, v]) => `${k} ${v >= 0 ? "+" : ""}${v}`).join(", ")}. Lean harder on the positive ones.`);
  }
  parts.push("</what_performed>");
  return parts.join("\n\n");
}
