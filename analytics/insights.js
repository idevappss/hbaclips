// What the numbers mean: which videos are moving right now, what the channel's typical video looks like,
// and which lengths, posting times, tags and title shapes beat that typical video.
// Everything here compares against the channel's own median — one viral video shouldn't move the bar.
import { videoPace } from "./store.js";

const DAY = 86400000;
const MILESTONES = [1e3, 2.5e3, 5e3, 1e4, 2.5e4, 5e4, 1e5, 2.5e5, 5e5, 1e6, 2.5e6, 5e6, 1e7];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const BANDS = [
  { label: "Under 20s", min: 0, max: 20 },
  { label: "20–40s", min: 20, max: 40 },
  { label: "40–60s", min: 40, max: 60 },
  { label: "1–3 min", min: 60, max: 180 },
  { label: "3–10 min", min: 180, max: 600 },
  { label: "Over 10 min", min: 600, max: Infinity },
];

const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

/** Views per day since publishing — the only fair way to put a video from today next to one from March. */
const rate = (video, now) => {
  const age = video.publishedAt ? (now - Date.parse(video.publishedAt)) / DAY : null;
  return age && age > 0 ? video.views / Math.max(age, 0.5) : null;
};

/** A group of videos against the channel's typical video. Small groups are reported but marked thin. */
function group(label, videos, baseline, now, extra = {}) {
  const rates = videos.map((v) => rate(v, now)).filter(Number.isFinite);
  const mid = median(rates);
  return {
    label,
    count: videos.length,
    medianRate: mid == null ? null : Math.round(mid),
    medianViews: median(videos.map((v) => v.views)),
    multiple: mid && baseline ? r2(mid / baseline) : null,
    thin: videos.length < 3,
    ...extra,
  };
}

/**
 * Everything derived, for one channel.
 * `videos` are the fetched uploads, `videoRows` the per-video daily readings this app has taken,
 * `days` the channel's daily totals.
 */
export function channelInsights({ videos = [], videoRows = {}, days = {}, stats = {}, now = new Date() } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  const time = at.getTime();
  const scored = videos.filter((v) => v.publishedAt && rate(v, time) != null);
  const rates = scored.map((v) => rate(v, time));
  const baseline = median(rates);
  const typicalViews = median(scored.map((v) => v.views));

  // ---- what is moving right now -------------------------------------------
  const tracked = [];
  for (const video of videos) {
    const pace = videoPace(videoRows[video.id], at);
    if (!pace) continue;
    tracked.push({
      id: video.id,
      title: video.title,
      thumb: video.thumb,
      publishedAt: video.publishedAt,
      durationSec: video.durationSec,
      views: pace.views,
      today: pace.day?.value ?? null,
      week: pace.week?.value ?? null,
      firstDayViews: pace.firstDayViews,
      sincePublish: pace.sincePublish,
      trackedDays: pace.days,
      series: pace.series.slice(-14),
      multiple: baseline ? r2(rate(video, time) / baseline) : null,
    });
  }
  const movers = [...tracked].filter((v) => v.today != null).sort((a, b) => b.today - a.today).slice(0, 5);
  const movingTotal = tracked.reduce((a, v) => a + (v.today || 0), 0);

  // ---- what a typical video looks like ------------------------------------
  const withViews = scored.filter((v) => v.views > 0);
  const benchmarks = {
    videos: scored.length,
    medianViews: typicalViews == null ? null : Math.round(typicalViews),
    medianViewsPerDay: baseline == null ? null : Math.round(baseline),
    likesPer1k: r2(median(withViews.map((v) => (v.likes / v.views) * 1000))),
    commentsPer1k: r2(median(withViews.map((v) => (v.comments / v.views) * 1000))),
    engagement: r2(median(withViews.map((v) => ((v.likes + v.comments) / v.views) * 100))),
    firstDayViews: (() => {
      const first = tracked.filter((v) => v.sincePublish && Number.isFinite(v.firstDayViews)).map((v) => v.firstDayViews);
      return first.length ? Math.round(median(first)) : null;
    })(),
  };

  // ---- what beats it ------------------------------------------------------
  const lengths = BANDS
    .map((b) => group(b.label, scored.filter((v) => v.durationSec >= b.min && v.durationSec < b.max), baseline, time))
    .filter((g) => g.count);

  const shorts = scored.filter((v) => v.durationSec > 0 && v.durationSec <= 180);
  const longs = scored.filter((v) => v.durationSec > 180);
  const formats = [group("Shorts-length", shorts, baseline, time), group("Longer videos", longs, baseline, time)].filter((g) => g.count);

  const byWeekday = WEEKDAYS
    .map((label, i) => group(label, scored.filter((v) => new Date(v.publishedAt).getDay() === i), baseline, time, { weekday: i }))
    .filter((g) => g.count);

  const hours = [
    { label: "Early morning (12–6am)", from: 0, to: 6 },
    { label: "Morning (6am–12pm)", from: 6, to: 12 },
    { label: "Afternoon (12–6pm)", from: 12, to: 18 },
    { label: "Evening (6pm–12am)", from: 18, to: 24 },
  ]
    .map((slot) => group(slot.label, scored.filter((v) => { const h = new Date(v.publishedAt).getHours(); return h >= slot.from && h < slot.to; }), baseline, time))
    .filter((g) => g.count);

  const tagCounts = new Map();
  for (const video of scored) for (const tag of video.tags || []) {
    const key = tag.toLowerCase().trim();
    if (key.length < 2) continue;
    if (!tagCounts.has(key)) tagCounts.set(key, []);
    tagCounts.get(key).push(video);
  }
  // A pattern every video shares says nothing about what works — it's just the channel.
  const tells = (count) => count >= 3 && count <= scored.length * 0.85;
  const tags = [...tagCounts.entries()]
    .filter(([, vs]) => tells(vs.length))
    .map(([tag, vs]) => group(tag, vs, baseline, time))
    .sort((a, b) => (b.multiple || 0) - (a.multiple || 0))
    .slice(0, 12);

  const titleTests = [
    { label: "Asks a question", test: (t) => t.includes("?") },
    { label: "Has a number", test: (t) => /\d/.test(t) },
    { label: "Names a dollar amount", test: (t) => /\$/.test(t) },
    { label: "A SHOUTED word", test: (t) => /\b[A-Z]{3,}\b/.test(t) },
    { label: "Short title (≤ 40 chars)", test: (t) => t.length <= 40 },
    { label: "Long title (> 60 chars)", test: (t) => t.length > 60 },
  ];
  const titles = titleTests
    .map((t) => group(t.label, scored.filter((v) => t.test(v.title || "")), baseline, time))
    .filter((g) => tells(g.count))
    .sort((a, b) => (b.multiple || 0) - (a.multiple || 0));

  // ---- is the channel growing --------------------------------------------
  const dates = Object.keys(days).sort();
  const span = (metric, wanted) => {
    if (dates.length < 2) return null;
    const end = dates[dates.length - 1];
    const cutoff = new Date(Date.parse(`${end}T00:00:00Z`) - wanted * DAY).toISOString().slice(0, 10);
    let from = null;
    for (const d of dates) {
      if (d > cutoff) break;
      from = d;
    }
    from ||= dates[0];
    if (from === end) return null;
    const covered = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
    return { perDay: (days[end][metric] - days[from][metric]) / covered, covered };
  };

  const viewRate = span("views", 30);
  const subRate = span("subs", 30);
  const subs = stats.subs ?? null;
  const nextTarget = subs == null ? null : MILESTONES.find((m) => m > subs) || null;
  const growth = {
    viewsPerDay: viewRate ? Math.round(viewRate.perDay) : null,
    subsPerDay: subRate ? r2(subRate.perDay) : null,
    covered: viewRate?.covered ?? 0,
    projected30: viewRate ? { views: Math.round(viewRate.perDay * 30), subs: subRate ? Math.round(subRate.perDay * 30) : null } : null,
    milestone: nextTarget && subRate?.perDay > 0
      ? { target: nextTarget, days: Math.ceil((nextTarget - subs) / subRate.perDay), at: new Date(time + ((nextTarget - subs) / subRate.perDay) * DAY).toISOString() }
      : nextTarget
        ? { target: nextTarget, days: null, at: null }
        : null,
  };

  const ranked = [...scored].sort((a, b) => rate(b, time) - rate(a, time));
  return {
    baseline: benchmarks.medianViewsPerDay,
    benchmarks,
    movers,
    movingTotal,
    tracked: tracked.length,
    paces: tracked,
    lengths,
    formats,
    byWeekday: [...byWeekday].sort((a, b) => (b.multiple || 0) - (a.multiple || 0)),
    hours: [...hours].sort((a, b) => (b.multiple || 0) - (a.multiple || 0)),
    tags,
    titles,
    growth,
    best: ranked.slice(0, 3).map((v) => ({ id: v.id, title: v.title, views: v.views, multiple: baseline ? r2(rate(v, time) / baseline) : null })),
    worst: ranked.slice(-3).reverse().map((v) => ({ id: v.id, title: v.title, views: v.views, multiple: baseline ? r2(rate(v, time) / baseline) : null })),
  };
}
